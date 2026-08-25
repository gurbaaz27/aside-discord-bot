import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Schedule } from "effect";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AsideBridge } from "../src/aside.ts";
import { AppConfig, type Config } from "../src/config.ts";

const testConfig = (dataDir: string, cli: string): Config => ({
  discordToken: "token",
  discordClientId: "client",
  discordGuildId: "guild",
  discordUserId: "user",
  asideCli: cli,
  asideSessionsDir: join(dataDir, "sessions"),
  asideEffort: "medium",
  asideExecTimeoutMs: 60_000,
  dataDir,
});

/**
 * Runs `use` against an AsideBridge whose CLI is a stand-in shell script.
 *
 * `script` receives the path of a file it should touch when it is signalled,
 * which is how the tests observe that the child was actually killed.
 */
async function withFakeCli<A>(
  script: (signalledPath: string, readyPath: string) => string,
  use: (
    aside: AsideBridge["Service"],
    paths: { signalled: string; ready: string },
  ) => Effect.Effect<A, unknown, never>,
): Promise<A> {
  const directory = await mkdtemp(join(tmpdir(), "aside-lifecycle-"));
  try {
    const cli = join(directory, "fake-aside");
    const signalledPath = join(directory, "signalled");
    const readyPath = join(directory, "ready");
    await writeFile(cli, script(signalledPath, readyPath), "utf8");
    await chmod(cli, 0o755);
    const layer = AsideBridge.layer.pipe(
      Layer.provide(Layer.succeed(AppConfig, testConfig(directory, cli))),
    );
    return await Effect.runPromise(
      Effect.gen(function* () {
        const aside = yield* AsideBridge;
        return yield* use(aside, { signalled: signalledPath, ready: readyPath });
      }).pipe(Effect.provide(layer), Effect.orDie),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Polls for a file, up to ~3s. Returns whether it appeared. */
const waitForFile = (path: string) =>
  Effect.promise(() => Bun.file(path).exists()).pipe(
    Effect.repeat({
      until: (exists: boolean) => exists,
      times: 30,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.catch(() => Effect.succeed(false)),
  );

describe("child process lifecycle", () => {
  test("interrupting a turn signals and reaps the child", async () => {
    await withFakeCli(
      // A real SIGTERM handler, not a shell trap: macOS /bin/sh defers traps
      // while blocked in `wait`, which would make this child look cooperative
      // when it is not.
      (signalled, ready) => `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(signalled)}, "terminated");
  process.exit(0);
});
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(ready)}, "ready");
`,
      (aside, paths) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(aside.run("session", "prompt"));
          // Wait for the handler to be installed; interrupting before that
          // would test the default SIGTERM disposition, not our teardown.
          yield* waitForFile(paths.ready);

          const began = Date.now();
          yield* Fiber.interrupt(fiber);
          const elapsed = Date.now() - began;

          // The turn tears down promptly rather than waiting out `sleep 60`.
          expect(elapsed).toBeLessThan(3_000);
          // ...and the child was actually signalled, not leaked. The trap
          // writes the marker as the shell is tearing down, so poll for it
          // rather than racing that last write.
          const wasSignalled = yield* waitForFile(paths.signalled);
          expect(wasSignalled).toBe(true);
        }),
    );
  }, 20_000);

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    await withFakeCli(
      () => `#!/bin/sh
trap '' TERM
sleep 60 &
wait
`,
      (aside) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(aside.run("session", "prompt"));
          yield* Effect.sleep("750 millis");

          const began = Date.now();
          yield* Fiber.interrupt(fiber);
          const elapsed = Date.now() - began;

          // SIGTERM is ignored, so teardown waits out the 1.5s escalation
          // window and then SIGKILLs -- bounded, not hanging on `sleep 60`.
          expect(elapsed).toBeGreaterThanOrEqual(1_400);
          expect(elapsed).toBeLessThan(6_000);
        }),
    );
  }, 20_000);

  test("marks a session read through a short REPL call", async () => {
    const args = await withFakeCli(
      (signalled) => `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dirname(signalled), "args"))}, JSON.stringify(process.argv.slice(-2)));
`,
      (aside, paths) =>
        Effect.gen(function* () {
          yield* aside.markRead('session"with-quote');
          return yield* Effect.promise(() => readFile(join(dirname(paths.signalled), "args"), "utf8"));
        }),
    );

    expect(JSON.parse(args)).toEqual([
      "repl",
      'aside.sessions.markRead("session\\\"with-quote")',
    ]);
  });
});
