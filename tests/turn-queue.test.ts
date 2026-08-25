import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsideBridge } from "../src/aside.ts";
import { AppConfig, type Config } from "../src/config.ts";
import { StateStore, type ThreadRecord } from "../src/state.ts";
import { TurnRunner } from "../src/turn.ts";

const testConfig = (dataDir: string): Config => ({
  discordToken: "token",
  discordClientId: "client",
  discordGuildId: "guild",
  discordUserId: "user",
  asideCli: "/nonexistent/aside",
  asideSessionsDir: join(dataDir, "sessions"),
  asideEffort: "medium",
  asideExecTimeoutMs: 10_000,
  dataDir,
});

const record: ThreadRecord = {
  threadId: "thread-1",
  guildId: "guild",
  parentChannelId: "parent",
  sessionId: "session-1",
  title: "test",
  createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
};

/** Just enough ThreadChannel for a turn to run against. */
function fakeThread(id: string, sent: string[]) {
  const thread = {
    id,
    name: "test",
    send: async (payload: unknown) => {
      sent.push(typeof payload === "string" ? payload : JSON.stringify(payload));
      return { id: `m${sent.length}`, edit: async () => undefined };
    },
    setName: async () => undefined,
  };
  return thread as unknown as Parameters<TurnRunner["Service"]["submit"]>[0];
}

describe("per-thread turn queue", () => {
  test("serialises turns for one thread and reports the second as queued", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-queue-"));
    try {
      const events: string[] = [];
      const sent: string[] = [];

      const asideStub = Layer.succeed(
        AsideBridge,
        AsideBridge.of({
          createSession: Effect.succeed("session-1"),
          markRead: () => Effect.void,
          sessionTitle: () => Effect.succeed(undefined),
          sessionMessageFile: () => Effect.succeed(undefined),
          run: (_sessionId, prompt) =>
            Effect.gen(function* () {
              events.push(`start:${prompt}`);
              yield* Effect.sleep("300 millis");
              events.push(`end:${prompt}`);
              return { response: `reply to ${prompt}`, outcome: { _tag: "Completed" as const } };
            }),
        }),
      );

      const layer = TurnRunner.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(asideStub, StateStore.layer)),
        Layer.provideMerge(Layer.succeed(AppConfig, testConfig(directory))),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const turns = yield* TurnRunner;
          const thread = fakeThread(record.threadId, sent);

          const first = yield* turns.submit(thread, record, "one");
          const second = yield* turns.submit(thread, record, "two");

          expect(first.queued).toBe(false);
          expect(second.queued).toBe(true);

          // Mid-flight the thread reports as working.
          yield* Effect.sleep("150 millis");
          expect((yield* turns.status(record.threadId))._tag).toBe("Working");

          // Both turns take 300ms; wait for the pair plus slack.
          yield* Effect.sleep("1200 millis");

          // Per-turn bookkeeping is cleaned up, so the thread is idle again.
          expect((yield* turns.status(record.threadId))._tag).toBe("Idle");
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
      );

      // The second turn must not begin until the first has finished.
      expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
      // Each turn posted its own status line and its reply.
      expect(sent.filter((text) => text.includes("Working"))).toHaveLength(2);
      expect(sent).toContain("reply to one");
      expect(sent).toContain("reply to two");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
