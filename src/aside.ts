import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AppConfig } from "./config.ts";
import { createPersona, followupReminder } from "./protocol.ts";

/** Spawning the Aside CLI failed outright. */
export class AsideSpawnError extends Schema.TaggedError<AsideSpawnError>()("AsideSpawnError", {
  cause: Schema.Defect(),
}) {}

/** The Aside CLI exited non-zero on a call whose output we depend on. */
export class AsideExitError extends Schema.TaggedError<AsideExitError>()("AsideExitError", {
  code: Schema.Number,
  stderr: Schema.String,
  stdout: Schema.String,
}) {}

/** Aside started a session but its id never showed up on disk. */
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  {},
) {}

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * How a turn ended.
 *
 * A turn that timed out or exited non-zero may still have produced assistant
 * text, so this is a result rather than an error channel: the caller decides
 * what to show based on both the outcome and whether `response` is empty.
 */
export type TurnOutcome =
  | { readonly _tag: "Completed" }
  | { readonly _tag: "TimedOut" }
  | {
      readonly _tag: "Failed";
      readonly code: number;
      readonly stderr: string;
      readonly stdout: string;
    };

function isSessionDirectory(name: string): boolean {
  return name.includes("_");
}

/**
 * Reads assistant text appended to a transcript after a byte offset.
 *
 * Kept a plain function: it is pure I/O with no process lifecycle, and
 * `tests/aside.test.ts` exercises it directly.
 */
export async function readAssistantTextSince(path: string, offset: number): Promise<string> {
  try {
    const content = await readFile(path);
    // stat().size is a byte offset; slicing a UTF-16 string would drift as
    // soon as an earlier transcript line contained non-ASCII text.
    const tail = content.subarray(offset).toString("utf8");
    const texts: string[] = [];
    for (const line of tail.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { role?: string; content?: unknown };
        if (row.role !== "assistant" || !Array.isArray(row.content)) continue;
        for (const part of row.content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string" && text.trim()) texts.push(text);
          }
        }
      } catch {
        // Aside may be appending a partial JSON line while we read it.
      }
    }
    return texts.join("\n\n");
  } catch {
    return "";
  }
}

async function transcriptText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export class AsideBridge extends Context.Service<AsideBridge, {
  readonly createSession: Effect.Effect<
    string,
    AsideSpawnError | AsideExitError | SessionNotFoundError
  >;
  readonly run: (
    sessionId: string,
    prompt: string,
    options?: { model?: string | undefined; effort?: string | undefined },
  ) => Effect.Effect<{ response: string; outcome: TurnOutcome }, AsideSpawnError>;
  readonly sessionTitle: (sessionId: string) => Effect.Effect<string | undefined, AsideSpawnError>;
  readonly sessionMessageFile: (sessionId: string) => Effect.Effect<string | undefined>;
}>()("bot/AsideBridge") {
  static readonly layer = Layer.effect(
    AsideBridge,
    Effect.gen(function* () {
      const config = yield* AppConfig;

      /**
       * Kills a child and waits for it to actually go.
       *
       * Runs as a release finalizer, so it fires on success, failure, and
       * interruption alike -- this is what replaces the old terminate() plus
       * its SIGKILL escalation timer. Both branches await `exited`, so a child
       * that ignores SIGTERM is bounded rather than hanging forever.
       */
      const terminate = (child: Bun.Subprocess) =>
        Effect.suspend(() => {
          if (child.exitCode !== null) return Effect.void;
          child.kill("SIGTERM");
          return Effect.race(
            Effect.promise(() => child.exited),
            Effect.sleep("1500 millis").pipe(
              Effect.andThen(Effect.sync(() => child.kill("SIGKILL"))),
              Effect.andThen(Effect.promise(() => child.exited)),
            ),
          );
        }).pipe(
          // Finalizers run while the fiber is already interrupted, and a bare
          // race would be cut short there -- SIGTERM would be delivered but
          // nothing would wait for the child to actually die, letting shutdown
          // race ahead and orphan it. Uninterruptible keeps the wait honest.
          Effect.uninterruptible,
          Effect.asVoid,
          Effect.orDie,
        );

      /**
       * Runs the Aside CLI and collects its output.
       *
       * Returns `undefined` when the call outlived the configured timeout.
       *
       * Bun.spawn is used rather than node:child_process.spawn. A spike on
       * 2026-08-25 found node:child_process handles this CLI fine for `repl`
       * calls, even under 1MB of output, but the original hang was observed on
       * long-running `exec` calls, which could not be re-tested without
       * burning a real Aside turn. Bun.spawn is known-good for both, so it
       * stays until there is a reason to revisit.
       */
      const spawnProcess = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* Effect.logDebug(`spawn ${config.asideCli} ${args.slice(0, -1).join(" ")}`);
          const child = yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                Bun.spawn([config.asideCli, ...args], {
                  env: process.env as Record<string, string>,
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              catch: (cause) => new AsideSpawnError({ cause }),
            }),
            terminate,
          );

          const collected = yield* Effect.promise(() =>
            Promise.all([
              child.exited,
              new Response(child.stdout as ReadableStream<Uint8Array>).text(),
              new Response(child.stderr as ReadableStream<Uint8Array>).text(),
            ]),
          ).pipe(Effect.timeoutOption(config.asideExecTimeoutMs));

          if (Option.isNone(collected)) {
            yield* Effect.logDebug("process timed out");
            return undefined;
          }
          const [code, stdout, stderr] = collected.value;
          yield* Effect.logDebug(`process exited code=${code}`);
          return { code, stdout, stderr } satisfies ExecResult;
        }).pipe(Effect.scoped);

      const execRepl = (expression: string) => spawnProcess(["repl", expression]);

      const exec = (
        prompt: string,
        options: {
          sessionId?: string;
          model?: string | undefined;
          effort?: string | undefined;
        } = {},
      ) => {
        const args = ["exec"];
        if (options.sessionId) args.push("--session", options.sessionId);
        if (options.model) args.push("-m", options.model);
        if (options.effort) args.push("--effort", options.effort);
        args.push(prompt);
        return spawnProcess(args);
      };

      const sessionDirectories = Effect.promise(async () => {
        try {
          const names = await readdir(config.asideSessionsDir);
          const rows = [];
          for (const name of names) {
            if (!isSessionDirectory(name)) continue;
            const path = join(config.asideSessionsDir, name);
            const info = await stat(path).catch(() => undefined);
            if (!info?.isDirectory()) continue;
            rows.push({
              name,
              path,
              sessionId: name.slice(name.lastIndexOf("_") + 1),
              mtime: info.mtimeMs,
            });
          }
          return rows;
        } catch {
          return [];
        }
      });

      const sessionMessageFile = (sessionId: string) =>
        Effect.promise(async () => {
          try {
            const names = await readdir(config.asideSessionsDir);
            const directory = names.find((name) => name.endsWith(`_${sessionId}`));
            if (!directory) return undefined;
            const path = join(config.asideSessionsDir, directory, "messages.jsonl");
            await access(path);
            return path;
          } catch {
            return undefined;
          }
        });

      const prepareSession = Effect.fn("AsideBridge.prepareSession")(function* (sessionId: string) {
        const expression = `aside.sessions.update(${JSON.stringify(sessionId)}, { permissionMode: 'full-access', runtimeConfig: { finalConfirm: false } })`;
        const result = yield* execRepl(expression);
        if (!result || result.code !== 0) {
          yield* Effect.logWarning(
            `Could not prepare Aside session ${sessionId}: ${result?.stderr ?? "timed out"}`,
          );
        }
      });

      const sessionTitle = Effect.fn("AsideBridge.sessionTitle")(function* (sessionId: string) {
        const startMarker = "__ASIDE_SESSION_TITLE__";
        const endMarker = "__END_ASIDE_SESSION_TITLE__";
        const expression = `console.log(${JSON.stringify(startMarker)} + JSON.stringify((await aside.sessions.get(${JSON.stringify(sessionId)})).title) + ${JSON.stringify(endMarker)})`;
        const result = yield* execRepl(expression);
        if (!result || result.code !== 0) {
          yield* Effect.logWarning(
            `Could not read Aside session title for ${sessionId}: ${result?.stderr || result?.stdout || "timed out"}`,
          );
          return undefined;
        }
        const encoded = result.stdout.match(new RegExp(`${startMarker}(.*?)${endMarker}`, "s"))?.[1];
        if (!encoded) return undefined;
        try {
          const title = JSON.parse(encoded) as unknown;
          return typeof title === "string" && title.trim() ? title.trim() : undefined;
        } catch {
          yield* Effect.logWarning(`Could not parse Aside session title for ${sessionId}`);
          return undefined;
        }
      });

      const createSessionUnlocked = Effect.fn("AsideBridge.createSession")(function* () {
        yield* Effect.logInfo(`creating session using ${config.asideCli}`);
        yield* Effect.logInfo(`sessions directory: ${config.asideSessionsDir}`);
        const before = new Set((yield* sessionDirectories).map((directory) => directory.name));
        const startedAt = Date.now() - 2_000;
        const result = yield* exec(createPersona(), {
          model: config.asideModel,
          effort: "low",
        });
        if (!result) {
          return yield* new AsideExitError({ code: -1, stderr: "timed out", stdout: "" });
        }
        yield* Effect.logInfo(`initial exec exited code=${result.code}`);
        if (result.stderr.trim()) {
          yield* Effect.logError(`stderr: ${result.stderr.trim().slice(0, 1_000)}`);
        }
        if (result.code !== 0) {
          return yield* new AsideExitError({
            code: result.code,
            stderr: result.stderr,
            stdout: result.stdout,
          });
        }

        for (let attempt = 0; attempt < 10; attempt += 1) {
          const candidates = yield* sessionDirectories;
          const match = candidates
            .filter((candidate) => !before.has(candidate.name) && candidate.mtime >= startedAt)
            .sort((a, b) => b.mtime - a.mtime)[0];
          if (match) {
            const marker = yield* Effect.promise(() =>
              transcriptText(join(match.path, "messages.jsonl")),
            );
            if (marker.toLowerCase().includes("inside a private discord thread")) {
              yield* Effect.logInfo(`found new session ${match.sessionId}`);
              yield* prepareSession(match.sessionId);
              return match.sessionId;
            }
          }
          yield* Effect.sleep("250 millis");
        }
        return yield* new SessionNotFoundError();
      });

      // Serialises session creation. Replaces the hand-rolled promise-chain
      // mutex, which needed an escaping `release!` binding to work.
      const createLock = yield* Semaphore.make(1);
      const createSession = createLock.withPermits(1)(createSessionUnlocked());

      const run = Effect.fn("AsideBridge.run")(function* (
        sessionId: string,
        prompt: string,
        options: { model?: string | undefined; effort?: string | undefined } = {},
      ) {
        const transcript = yield* sessionMessageFile(sessionId);
        const offset = transcript
          ? yield* Effect.promise(() => stat(transcript).then((info) => info.size))
          : 0;
        const result = yield* exec(`${prompt}${followupReminder()}`, {
          sessionId,
          model: options.model ?? config.asideModel,
          effort: options.effort ?? config.asideEffort,
        });
        const latest = transcript
          ? yield* Effect.promise(() => readAssistantTextSince(transcript, offset))
          : "";

        if (!result) {
          return { response: latest, outcome: { _tag: "TimedOut" } as const };
        }
        const response = latest || result.stdout.trim();
        const outcome: TurnOutcome =
          result.code === 0
            ? { _tag: "Completed" }
            : { _tag: "Failed", code: result.code, stderr: result.stderr, stdout: result.stdout };
        return { response, outcome };
      });

      return AsideBridge.of({ createSession, run, sessionTitle, sessionMessageFile });
    }),
  );
}
