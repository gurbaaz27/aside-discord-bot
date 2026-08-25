import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { AsideBridge } from "../src/aside.ts";
import { StateStore, type PendingPrompt, type ThreadRecord } from "../src/state.ts";
import { TurnRunner } from "../src/turn.ts";

const record: ThreadRecord = {
  threadId: "thread-1",
  guildId: "guild-1",
  parentChannelId: "parent-1",
  sessionId: "session-1",
  title: "test",
  createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
};

const thread = {
  id: record.threadId,
  isThread: () => true,
  send: async () => ({ id: "message-1" }),
};

async function loadHandlers() {
  process.env.DISCORD_TOKEN = "token";
  process.env.DISCORD_CLIENT_ID = "client";
  process.env.DISCORD_GUILD_ID = record.guildId;
  process.env.DISCORD_USER_ID = "owner-1";
  return await import("../src/index.ts");
}

function services(pending?: PendingPrompt) {
  const reads: string[] = [];
  const submitted: string[] = [];
  const aside = AsideBridge.of({
    createSession: Effect.succeed(record.sessionId),
    run: () => Effect.succeed({ response: "", outcome: { _tag: "Completed" as const } }),
    sessionTitle: () => Effect.succeed(undefined),
    markRead: (sessionId) => Effect.sync(() => reads.push(sessionId)),
    sessionMessageFile: () => Effect.succeed(undefined),
  });
  const state = StateStore.of({
    getThread: (threadId) => (threadId === record.threadId ? record : undefined),
    listThreads: () => [record],
    getPending: () => pending,
    setThread: () => Effect.void,
    touchThread: () => Effect.void,
    setPending: () => Effect.void,
    clearPending: () => Effect.succeed(true),
    invalidatePendingRevision: () => Effect.void,
    updatePendingMessage: () => Effect.succeed(false),
    consumePending: () =>
      pending ? Effect.succeed({ pending, revision: 1 }) : Effect.succeed(undefined),
    restorePendingIfUnchanged: () => Effect.succeed(false),
  });
  const turns = TurnRunner.of({
    submit: (_thread, _record, prompt) =>
      Effect.sync(() => {
        submitted.push(prompt);
        return { queued: false };
      }),
    interrupt: () => Effect.succeed(false),
    status: () => Effect.succeed({ _tag: "Idle" as const }),
    shutdown: Effect.void,
  });
  const layer = Layer.mergeAll(
    Layer.succeed(AsideBridge, aside),
    Layer.succeed(StateStore, state),
    Layer.succeed(TurnRunner, turns),
  );
  return { layer, reads, submitted };
}

async function flushDetachedRead(): Promise<void> {
  await Effect.runPromise(Effect.sleep("20 millis"));
}

describe("Discord read-state signals", () => {
  test("marks read only for a valid owner follow-up message", async () => {
    const { handleMessage } = await loadHandlers();
    const setup = services();
    const message = {
      author: { bot: false, id: "owner-1" },
      guild: { id: record.guildId },
      channel: thread,
      content: "follow up",
      attachments: new Map(),
    };

    await Effect.runPromise(
      handleMessage(message as never).pipe(Effect.provide(setup.layer)),
    );
    await flushDetachedRead();

    expect(setup.reads).toEqual([record.sessionId]);
    expect(setup.submitted).toEqual(["follow up"]);

    await Effect.runPromise(
      handleMessage({ ...message, author: { bot: false, id: "other-user" } } as never).pipe(
        Effect.provide(setup.layer),
      ),
    );
    await flushDetachedRead();

    expect(setup.reads).toEqual([record.sessionId]);
    expect(setup.submitted).toEqual(["follow up"]);
  });

  test("marks read when the owner clicks a valid prompt button", async () => {
    const { handleButton } = await loadHandlers();
    const pending: PendingPrompt = {
      kind: "question",
      token: "token-1",
      threadId: record.threadId,
      header: "Choice",
      question: "Pick one",
      options: [{ label: "First", description: "The first option" }],
    };
    const setup = services(pending);
    const interaction = {
      user: { id: "owner-1" },
      customId: `aside:question:${record.threadId}:${pending.token}:0`,
      channel: thread,
      update: async () => undefined,
      reply: async () => undefined,
    };

    await Effect.runPromise(
      handleButton(interaction as never).pipe(Effect.provide(setup.layer)),
    );
    await flushDetachedRead();

    expect(setup.reads).toEqual([record.sessionId]);
    expect(setup.submitted).toEqual(["Choice: First"]);
  });
});
