import type { ThreadChannel } from "discord.js";
import { Cause, Context, Effect, Exit, Fiber, FiberMap, FiberSet, Layer, Semaphore } from "effect";
import { AsideBridge } from "./aside.ts";
import { AppConfig } from "./config.ts";
import {
  discordCall,
  formatElapsed,
  presentApproval,
  presentQuestion,
  sendChunks,
  shortText,
} from "./discord-ui.ts";
import { parseApproval, parseQuestion, removeProtocolBlocks } from "./protocol.ts";
import { StateStore, type ThreadRecord } from "./state.ts";

export type TurnStatus =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Queued" }
  | { readonly _tag: "Working"; readonly elapsed: string };

export class TurnRunner extends Context.Service<TurnRunner, {
  /**
   * Queues a turn for a thread. Resolves as soon as the turn is queued, not
   * when it finishes; `queued` is true when another turn was already in
   * flight for this thread.
   */
  readonly submit: (
    thread: ThreadChannel,
    record: ThreadRecord,
    prompt: string,
  ) => Effect.Effect<{ queued: boolean }>;
  /** Interrupts the in-flight turn for a thread. False when it was idle. */
  readonly interrupt: (threadId: string) => Effect.Effect<boolean>;
  readonly status: (threadId: string) => Effect.Effect<TurnStatus>;
  /** Interrupts every turn, in-flight and queued. Used on shutdown. */
  readonly shutdown: Effect.Effect<void>;
}>()("bot/TurnRunner") {
  static readonly layer = Layer.effect(
    TurnRunner,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const aside = yield* AsideBridge;
      const state = yield* StateStore;

      // The in-flight turn per thread. Interrupting an entry tears down the
      // whole turn: the Aside child process is killed by its release
      // finalizer, and the status ticker dies with the turn's scope.
      const running = yield* FiberMap.make<string>();
      // Every submitted turn, in-flight or waiting on its thread's lock, so
      // shutdown can drain them all.
      const submitted = yield* FiberSet.make();

      // One lock per thread serialises that thread's turns. Replaces the
      // hand-chained promise queue.
      const locks = new Map<string, Semaphore.Semaphore>();
      const lockFor = (threadId: string) =>
        Effect.gen(function* () {
          const existing = locks.get(threadId);
          if (existing) return existing;
          const lock = yield* Semaphore.make(1);
          locks.set(threadId, lock);
          return lock;
        });

      const startedAt = new Map<string, number>();
      const inflight = new Map<string, number>();

      const syncThreadTitle = Effect.fn("TurnRunner.syncThreadTitle")(function* (
        thread: ThreadChannel,
        record: ThreadRecord,
      ) {
        const asideTitle = yield* aside.sessionTitle(record.sessionId);
        if (!asideTitle) return;
        const title = shortText(asideTitle, 100);
        if (!title) return;
        if (thread.name !== title) {
          yield* discordCall("setName", () => thread.setName(title));
        }
        if (record.title !== title) {
          record.title = title;
          yield* state.setThread(record);
        }
      },
      Effect.catchCause((cause) =>
        Effect.logError("Could not sync Discord thread title", cause),
      ));

      const runTurn = Effect.fn("TurnRunner.runTurn")(function* (
        thread: ThreadChannel,
        record: ThreadRecord,
        prompt: string,
      ) {
        const began = Date.now();
        const status = yield* discordCall("send", () => thread.send("⏳ Working…")).pipe(
          Effect.catchTag("DiscordError", (error) =>
            Effect.logError(`Could not post status in thread ${thread.id}`, error).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        if (!status) return;

        startedAt.set(thread.id, began);

        // Dies with the turn's scope, so there is no clearInterval to forget.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.sleep("10 seconds").pipe(
              Effect.andThen(
                discordCall("edit", () => status.edit(`⏳ Working… ${formatElapsed(began)}`)),
              ),
              Effect.ignore,
            ),
          ),
        );

        const { response, outcome } = yield* aside.run(record.sessionId, prompt, {
          model: record.model ?? config.asideModel,
          effort: record.effort ?? config.asideEffort,
        });

        yield* syncThreadTitle(thread, record);
        const approval = parseApproval(response);
        const question = approval ? undefined : parseQuestion(response);
        const visible = approval || question ? removeProtocolBlocks(response) : response;

        yield* discordCall("edit", () =>
          status.edit(`✅ Finished in ${formatElapsed(began)}`),
        ).pipe(Effect.ignore);

        if (visible) yield* sendChunks(thread, visible);

        if (approval) {
          yield* presentApproval(thread, approval);
        } else if (question) {
          yield* presentQuestion(thread, question);
        } else if (!response && outcome._tag === "TimedOut") {
          yield* discordCall("send", () =>
            thread.send("The Aside turn timed out. Use `/aside stop` for future turns or try again."),
          );
        } else if (!response && outcome._tag === "Failed") {
          const detail = shortText(outcome.stderr || outcome.stdout || "unknown error", 1_500);
          yield* discordCall("send", () => thread.send(`Aside returned an error: ${detail}`));
        } else if (!response) {
          yield* discordCall("send", () =>
            thread.send("Aside finished without a response. Check the Mac's Aside app and try again."),
          );
        }
      },
      // Runs on success, failure, and interruption alike -- the replacement
      // for the old `finally` block.
      (effect, thread) =>
        effect.pipe(
          Effect.provideService(StateStore, state),
          Effect.scoped,
          Effect.ensuring(
            Effect.suspend(() => {
              startedAt.delete(thread.id);
              return state.touchThread(thread.id).pipe(Effect.ignore);
            }),
          ),
        ));

      const submit = Effect.fn("TurnRunner.submit")(function* (
        thread: ThreadChannel,
        record: ThreadRecord,
        prompt: string,
      ) {
        const threadId = thread.id;
        const lock = yield* lockFor(threadId);
        const queued = (inflight.get(threadId) ?? 0) > 0;
        inflight.set(threadId, (inflight.get(threadId) ?? 0) + 1);

        const guarded = lock.withPermits(1)(
          Effect.gen(function* () {
            // Forked under the thread's key so `interrupt` can reach exactly
            // this turn while leaving anything queued behind it intact.
            const fiber = yield* FiberMap.run(running, threadId, runTurn(thread, record, prompt));
            const [exit] = yield* Fiber.awaitAll([fiber]);
            if (exit && Exit.isFailure(exit)) {
              if (Cause.hasInterrupts(exit.cause)) {
                yield* discordCall("send", () => thread.send("🛑 Turn stopped.")).pipe(
                  Effect.ignore,
                );
              } else {
                yield* Effect.logError(`Turn failed in thread ${threadId}`, exit.cause);
              }
            }
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const remaining = (inflight.get(threadId) ?? 1) - 1;
              if (remaining > 0) inflight.set(threadId, remaining);
              else {
                inflight.delete(threadId);
                locks.delete(threadId);
              }
            }),
          ),
        );

        yield* FiberSet.run(submitted, guarded);
        return { queued };
      });

      const interrupt = Effect.fn("TurnRunner.interrupt")(function* (threadId: string) {
        const isRunning = yield* FiberMap.has(running, threadId);
        if (!isRunning) return false;
        yield* FiberMap.remove(running, threadId);
        return true;
      });

      const status = Effect.fn("TurnRunner.status")(function* (threadId: string) {
        const began = startedAt.get(threadId);
        if (began !== undefined) {
          return { _tag: "Working", elapsed: formatElapsed(began) } satisfies TurnStatus;
        }
        if ((inflight.get(threadId) ?? 0) > 0) return { _tag: "Queued" } satisfies TurnStatus;
        return { _tag: "Idle" } satisfies TurnStatus;
      });

      const shutdown = Effect.gen(function* () {
        yield* FiberMap.clear(running);
        yield* FiberSet.clear(submitted);
      });

      return TurnRunner.of({ submit, interrupt, status, shutdown });
    }),
  );
}
