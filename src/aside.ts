import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { createPersona, followupReminder } from "./protocol.ts";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function isSessionDirectory(name: string): boolean {
  return name.includes("_");
}

export class AsideBridge {
  private sessionCreationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config) {}

  async sessionMessageFile(sessionId: string): Promise<string | undefined> {
    try {
      const names = await readdir(this.config.asideSessionsDir);
      const directory = names.find((name) => name.endsWith(`_${sessionId}`));
      if (!directory) return undefined;
      const path = join(this.config.asideSessionsDir, directory, "messages.jsonl");
      await access(path);
      return path;
    } catch {
      return undefined;
    }
  }

  async createSession(): Promise<string> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.sessionCreationQueue;
    this.sessionCreationQueue = previous.then(() => turn);
    await previous;
    try {
      return await this.createSessionUnlocked();
    } finally {
      release();
    }
  }

  private async createSessionUnlocked(): Promise<string> {
    console.log(`[aside] creating session using ${this.config.asideCli}`);
    console.log(`[aside] sessions directory: ${this.config.asideSessionsDir}`);
    const before = new Set((await this.sessionDirectories()).map((directory) => directory.name));
    const startedAt = Date.now() - 2_000;
    const result = await this.exec(createPersona(), {
      model: this.config.asideModel,
      effort: "low",
    });
    console.log(`[aside] initial exec exited code=${result.code} timedOut=${result.timedOut}`);
    if (result.stderr.trim()) console.error(`[aside] stderr: ${result.stderr.trim().slice(0, 1_000)}`);
    if (result.code !== 0) {
      throw new Error(`Aside could not create a session: ${result.stderr || result.stdout}`.slice(0, 500));
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidates = await this.sessionDirectories();
      const match = candidates
        .filter((candidate) => !before.has(candidate.name) && candidate.mtime >= startedAt)
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (match) {
        const marker = await this.transcriptText(join(match.path, "messages.jsonl"));
        if (marker.toLowerCase().includes("inside a private discord thread")) {
          console.log(`[aside] found new session ${match.sessionId}`);
          await this.prepareSession(match.sessionId);
          return match.sessionId;
        }
      }
      await Bun.sleep(250);
    }
    throw new Error("Aside created a session, but its session id could not be found");
  }

  async run(
    sessionId: string,
    prompt: string,
    options: { model?: string; effort?: string; signal?: AbortSignal } = {},
  ): Promise<{ result: ExecResult; response: string }> {
    const transcript = await this.sessionMessageFile(sessionId);
    const offset = transcript ? (await stat(transcript)).size : 0;
    const result = await this.exec(`${prompt}${followupReminder()}`, {
      sessionId,
      model: options.model ?? this.config.asideModel,
      effort: options.effort ?? this.config.asideEffort,
      signal: options.signal,
    });
    const latest = transcript ? await this.assistantTextSince(transcript, offset) : "";
    return { result, response: latest || result.stdout.trim() };
  }

  private async prepareSession(sessionId: string): Promise<void> {
    const expression = `aside.sessions.update(${JSON.stringify(sessionId)}, { permissionMode: 'full-access', runtimeConfig: { finalConfirm: false } })`;
    const result = await this.execRepl(expression);
    if (result.code !== 0) {
      console.warn(`Could not prepare Aside session ${sessionId}: ${result.stderr}`);
    }
  }

  private async execRepl(expression: string): Promise<ExecResult> {
    return this.spawnProcess(["repl", expression]);
  }

  private async exec(
    prompt: string,
    options: { sessionId?: string; model?: string; effort?: string; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    const args = ["exec"];
    if (options.sessionId) args.push("--session", options.sessionId);
    if (options.model) args.push("-m", options.model);
    if (options.effort) args.push("--effort", options.effort);
    args.push(prompt);
    return this.spawnProcess(args, options.signal);
  }

  private spawnProcess(args: string[], externalSignal?: AbortSignal): Promise<ExecResult> {
    return new Promise((resolve) => {
      console.log(`[aside] spawn ${this.config.asideCli} ${args.slice(0, -1).join(" ")}`);
      // Use Bun.spawn rather than node:child_process.spawn. Aside's CLI can
      // hang under Bun's Node-compatible child_process implementation, while
      // Bun's native subprocess API handles its stdio correctly.
      let child: Bun.Subprocess;
      try {
        child = Bun.spawn([this.config.asideCli, ...args], {
          env: process.env as Record<string, string>,
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        resolve({ code: -1, stdout: "", stderr: String(error), timedOut: false });
        return;
      }

      let timedOut = false;
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        if (settled) return;
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the signal and this call.
        }
        escalation = setTimeout(() => {
          if (settled) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have exited between the two signals.
          }
        }, 1_500);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, this.config.asideExecTimeoutMs);
      const abort = () => terminate();
      externalSignal?.addEventListener("abort", abort, { once: true });
      if (externalSignal?.aborted) terminate();

      const finish = async () => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout as ReadableStream<Uint8Array>).text(),
          new Response(child.stderr as ReadableStream<Uint8Array>).text(),
        ]);
        console.log(`[aside] process exited code=${code} timedOut=${timedOut}`);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        externalSignal?.removeEventListener("abort", abort);
        resolve({ code, stdout, stderr, timedOut });
      };
      void finish();
    });
  }

  private async sessionDirectories(): Promise<Array<{ name: string; path: string; sessionId: string; mtime: number }>> {
    try {
      const names = await readdir(this.config.asideSessionsDir);
      const rows = [];
      for (const name of names) {
        if (!isSessionDirectory(name)) continue;
        const path = join(this.config.asideSessionsDir, name);
        const info = await stat(path).catch(() => undefined);
        if (!info?.isDirectory()) continue;
        rows.push({ name, path, sessionId: name.slice(name.lastIndexOf("_") + 1), mtime: info.mtimeMs });
      }
      return rows;
    } catch {
      return [];
    }
  }

  private async transcriptText(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  private async assistantTextSince(path: string, offset: number): Promise<string> {
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
}
