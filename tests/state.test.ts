import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfig, type Config } from "../src/config.ts";
import { StateStore, type PendingPrompt } from "../src/state.ts";

function approval(threadId: string, token: string): PendingPrompt {
  return { kind: "approval", threadId, token, action: "test action", details: "test details" };
}

const testConfig = (dataDir: string): Config => ({
  discordToken: "token",
  discordClientId: "client",
  discordGuildId: "guild",
  discordUserId: "user",
  asideCli: "/nonexistent/aside",
  asideSessionsDir: join(dataDir, "sessions"),
  asideEffort: "medium",
  asideExecTimeoutMs: 1_000,
  dataDir,
});

/** Runs an effect against a StateStore rooted in a fresh temp directory. */
async function withStore<A>(
  use: (store: StateStore["Service"]) => Effect.Effect<A, unknown, never>,
): Promise<A> {
  const directory = await mkdtemp(join(tmpdir(), "aside-state-"));
  try {
    const layer = StateStore.layer.pipe(Layer.provide(Layer.succeed(AppConfig, testConfig(directory))));
    return await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore;
        return yield* use(store);
      }).pipe(Effect.provide(layer), Effect.orDie),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("pending decision lifecycle", () => {
  test("does not resurrect a consumed prompt after its message is published", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.setPending(approval("thread", "old"));
        const claim = yield* store.consumePending("thread", "old", "approval");
        expect(claim).toBeDefined();
        expect(yield* store.updatePendingMessage("thread", "old", "message")).toBe(false);
        expect(store.getPending("thread")).toBeUndefined();
      }),
    );
  });

  test("does not restore a prompt after a free-form answer supersedes it", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.setPending(approval("thread", "old"));
        const claim = yield* store.consumePending("thread", "old", "approval");
        expect(claim).toBeDefined();
        yield* store.invalidatePendingRevision("thread");
        expect(yield* store.restorePendingIfUnchanged(claim!)).toBe(false);
        expect(store.getPending("thread")).toBeUndefined();
      }),
    );
  });

  test("does not restore a stale prompt over a newer prompt", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.setPending(approval("thread", "old"));
        const claim = yield* store.consumePending("thread", "old", "approval");
        expect(claim).toBeDefined();
        yield* store.setPending(approval("thread", "new"));
        expect(yield* store.restorePendingIfUnchanged(claim!)).toBe(false);
        expect(store.getPending("thread")?.token).toBe("new");
      }),
    );
  });
});
