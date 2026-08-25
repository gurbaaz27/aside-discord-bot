import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppConfig } from "./config.ts";

export type ThreadRecord = {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  sessionId: string;
  title: string;
  model?: string;
  effort?: string;
  createdAt: string;
  lastActivityAt: string;
};

export type PendingPrompt =
  | {
      kind: "approval";
      token: string;
      threadId: string;
      action: string;
      details: string;
      messageId?: string;
    }
  | {
      kind: "question";
      token: string;
      threadId: string;
      header: string;
      question: string;
      options: Array<{ label: string; description: string }>;
      messageId?: string;
    };

export type PendingClaim = {
  pending: PendingPrompt;
  revision: number;
};

type PersistedState = {
  threads: Record<string, ThreadRecord>;
  pending: Record<string, PendingPrompt>;
  pendingRevisions: Record<string, number>;
};

const emptyState = (): PersistedState => ({ threads: {}, pending: {}, pendingRevisions: {} });

/** Reading or writing `state.json` failed. */
export class StateIoError extends Schema.TaggedError<StateIoError>()("StateIoError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class StateStore extends Context.Service<StateStore, {
  // Reads are synchronous: the whole state is held in memory, and callers in
  // the Discord layer read it inline while building replies.
  readonly getThread: (threadId: string) => ThreadRecord | undefined;
  readonly listThreads: (guildId?: string) => ThreadRecord[];
  readonly getPending: (threadId: string) => PendingPrompt | undefined;

  // Writes are effects: each one persists, so each one can fail.
  readonly setThread: (thread: ThreadRecord) => Effect.Effect<void, StateIoError>;
  readonly touchThread: (threadId: string) => Effect.Effect<void, StateIoError>;
  readonly setPending: (prompt: PendingPrompt) => Effect.Effect<void, StateIoError>;
  readonly clearPending: (
    threadId: string,
    expectedToken?: string,
  ) => Effect.Effect<boolean, StateIoError>;
  readonly invalidatePendingRevision: (threadId: string) => Effect.Effect<void, StateIoError>;
  readonly updatePendingMessage: (
    threadId: string,
    token: string,
    messageId: string,
  ) => Effect.Effect<boolean, StateIoError>;
  readonly consumePending: (
    threadId: string,
    token: string,
    kind: PendingPrompt["kind"],
  ) => Effect.Effect<PendingClaim | undefined, StateIoError>;
  readonly restorePendingIfUnchanged: (
    claim: PendingClaim,
  ) => Effect.Effect<boolean, StateIoError>;
}>()("bot/StateStore") {
  static readonly layer = Layer.effect(
    StateStore,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const path = join(config.dataDir, "state.json");

      let state: PersistedState = emptyState();

      // Serialises writes. Replaces the hand-chained promise queue, which had
      // to swallow its own errors to stay usable after a failed write.
      const writeLock = yield* Semaphore.make(1);

      const writeFileAtomically = Effect.fn("StateStore.write")(function* () {
        const snapshot = `${JSON.stringify(state, null, 2)}\n`;
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.tmp`;
            await writeFile(temporary, snapshot, "utf8");
            await rename(temporary, path);
          },
          catch: (cause) => new StateIoError({ path, cause }),
        });
      });

      const persist = () => writeLock.withPermits(1)(writeFileAtomically());

      const bumpPendingRevision = (threadId: string): number => {
        const revision = (state.pendingRevisions[threadId] ?? 0) + 1;
        state.pendingRevisions[threadId] = revision;
        return revision;
      };

      const getThread = (threadId: string): ThreadRecord | undefined => state.threads[threadId];

      const getPending = (threadId: string): PendingPrompt | undefined => state.pending[threadId];

      const listThreads = (guildId?: string): ThreadRecord[] =>
        Object.values(state.threads)
          .filter((thread) => !guildId || thread.guildId === guildId)
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

      const setThread = Effect.fn("StateStore.setThread")(function* (thread: ThreadRecord) {
        state.threads[thread.threadId] = thread;
        yield* persist();
      });

      const touchThread = Effect.fn("StateStore.touchThread")(function* (threadId: string) {
        const thread = getThread(threadId);
        if (!thread) return;
        thread.lastActivityAt = new Date().toISOString();
        yield* persist();
      });

      const setPending = Effect.fn("StateStore.setPending")(function* (prompt: PendingPrompt) {
        state.pending[prompt.threadId] = prompt;
        bumpPendingRevision(prompt.threadId);
        yield* persist();
      });

      const clearPending = Effect.fn("StateStore.clearPending")(function* (
        threadId: string,
        expectedToken?: string,
      ) {
        const current = state.pending[threadId];
        if (expectedToken && current && current.token !== expectedToken) return false;
        delete state.pending[threadId];
        bumpPendingRevision(threadId);
        yield* persist();
        return true;
      });

      const invalidatePendingRevision = Effect.fn("StateStore.invalidatePendingRevision")(
        function* (threadId: string) {
          bumpPendingRevision(threadId);
          yield* persist();
        },
      );

      const updatePendingMessage = Effect.fn("StateStore.updatePendingMessage")(function* (
        threadId: string,
        token: string,
        messageId: string,
      ) {
        const pending = state.pending[threadId];
        if (!pending || pending.token !== token) return false;
        pending.messageId = messageId;
        yield* persist();
        return true;
      });

      const consumePending = Effect.fn("StateStore.consumePending")(function* (
        threadId: string,
        token: string,
        kind: PendingPrompt["kind"],
      ) {
        const pending = state.pending[threadId];
        if (!pending || pending.token !== token || pending.kind !== kind) return undefined;
        delete state.pending[threadId];
        const revision = bumpPendingRevision(threadId);
        yield* persist();
        return { pending, revision } satisfies PendingClaim;
      });

      const restorePendingIfUnchanged = Effect.fn("StateStore.restorePendingIfUnchanged")(
        function* (claim: PendingClaim) {
          const threadId = claim.pending.threadId;
          if (state.pendingRevisions[threadId] !== claim.revision || state.pending[threadId]) {
            return false;
          }
          state.pending[threadId] = claim.pending;
          bumpPendingRevision(threadId);
          yield* persist();
          return true;
        },
      );

      // Load once during layer construction, so no caller has to remember to
      // await a separate load() before first use.
      const loaded = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => new StateIoError({ path, cause }),
      }).pipe(
        Effect.map((raw) => JSON.parse(raw) as Partial<PersistedState>),
        Effect.catchTag("StateIoError", (error) =>
          (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
      if (loaded) {
        state = {
          threads: loaded.threads ?? {},
          pending: loaded.pending ?? {},
          pendingRevisions: loaded.pendingRevisions ?? {},
        };
      } else {
        yield* persist();
      }

      return StateStore.of({
        getThread,
        listThreads,
        getPending,
        setThread,
        touchThread,
        setPending,
        clearPending,
        invalidatePendingRevision,
        updatePendingMessage,
        consumePending,
        restorePendingIfUnchanged,
      });
    }),
  );
}
