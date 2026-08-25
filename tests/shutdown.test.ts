import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Schedule } from "effect";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsideBridge } from "../src/aside.ts";
import { AppConfig, type Config } from "../src/config.ts";
import { StateStore, type ThreadRecord } from "../src/state.ts";
import { TurnRunner } from "../src/turn.ts";

const record: ThreadRecord = {
  threadId: "thread-1",
  guildId: "guild",
  parentChannelId: "parent",
  sessionId: "session-1",
  title: "test",
  createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
};

function fakeThread(id: string) {
  const thread = {
    id,
    name: "test",
    send: async () => ({ id: "m1", edit: async () => undefined }),
    setName: async () => undefined,
  };
  return thread as unknown as Parameters<TurnRunner["Service"]["submit"]>[0];
}

const waitForFile = (path: string) =>
  Effect.promise(() => Bun.file(path).exists()).pipe(
    Effect.repeat({
      until: (exists: boolean) => exists,
      times: 50,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.catch(() => Effect.succeed(false)),
  );

describe("shutdown", () => {
  test("disposing the runtime reaps a turn's child process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-shutdown-"));
    try {
      const cli = join(directory, "fake-aside");
      const signalled = join(directory, "signalled");
      const ready = join(directory, "ready");
      await writeFile(
        cli,
        `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(signalled)}, "terminated");
  process.exit(0);
});
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(ready)}, "ready");
`,
        "utf8",
      );
      await chmod(cli, 0o755);

      const config: Config = {
        discordToken: "token",
        discordClientId: "client",
        discordGuildId: "guild",
        discordUserId: "user",
        asideCli: cli,
        asideSessionsDir: join(directory, "sessions"),
        asideEffort: "medium",
        asideExecTimeoutMs: 60_000,
        dataDir: directory,
      };

      const layer = TurnRunner.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AsideBridge.layer, StateStore.layer)),
        Layer.provideMerge(Layer.succeed(AppConfig, config)),
      );
      const runtime = ManagedRuntime.make(layer);

      await runtime.runPromise(
        Effect.gen(function* () {
          const turns = yield* TurnRunner;
          yield* turns.submit(fakeThread(record.threadId), record, "a long turn");
          // The child is up and listening once it writes its ready marker.
          const started = yield* waitForFile(ready);
          expect(started).toBe(true);
        }),
      );

      const began = Date.now();
      await runtime.dispose();
      const elapsed = Date.now() - began;

      // launchd SIGKILLs ~20s after SIGTERM, so shutdown has to be quick.
      expect(elapsed).toBeLessThan(5_000);
      // The Aside child was signalled rather than orphaned.
      expect(await Bun.file(signalled).exists()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
