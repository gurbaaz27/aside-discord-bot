import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, type PendingPrompt } from "../src/state.ts";

function approval(threadId: string, token: string): PendingPrompt {
  return { kind: "approval", threadId, token, action: "test action", details: "test details" };
}

describe("pending decision lifecycle", () => {
  test("does not resurrect a consumed prompt after its message is published", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-state-"));
    try {
      const store = new StateStore(directory);
      await store.load();
      await store.setPending(approval("thread", "old"));
      const claim = await store.consumePending("thread", "old", "approval");
      expect(claim).toBeDefined();
      expect(await store.updatePendingMessage("thread", "old", "message")).toBe(false);
      expect(store.getPending("thread")).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not restore a stale prompt over a newer prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-state-"));
    try {
      const store = new StateStore(directory);
      await store.load();
      await store.setPending(approval("thread", "old"));
      const claim = await store.consumePending("thread", "old", "approval");
      expect(claim).toBeDefined();
      await store.setPending(approval("thread", "new"));
      expect(await store.restorePendingIfUnchanged(claim!)).toBe(false);
      expect(store.getPending("thread")?.token).toBe("new");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
