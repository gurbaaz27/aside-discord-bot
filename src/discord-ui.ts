import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ThreadChannel,
} from "discord.js";
import { Effect, Schema } from "effect";
import { StateStore, type PendingPrompt } from "./state.ts";

/** A call into the Discord API failed. */
export class DiscordError extends Schema.TaggedError<DiscordError>()("DiscordError", {
  action: Schema.String,
  cause: Schema.Defect(),
}) {}

export const discordCall = <A>(action: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new DiscordError({ action, cause }) });

export function shortText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Sends text to a thread, split on paragraph boundaries under Discord's 2k limit. */
export const sendChunks = Effect.fn("discord.sendChunks")(function* (
  thread: ThreadChannel,
  text: string,
) {
  const clean = text.trim();
  if (!clean) return;
  let remaining = clean;
  while (remaining.length > 0) {
    if (remaining.length <= 2_000) {
      yield* discordCall("send", () => thread.send(remaining));
      return;
    }
    let cut = remaining.lastIndexOf("\n\n", 2_000);
    if (cut < 500) cut = remaining.lastIndexOf("\n", 2_000);
    if (cut < 500) cut = 2_000;
    const slice = remaining.slice(0, cut).trim();
    yield* discordCall("send", () => thread.send(slice));
    remaining = remaining.slice(cut).trimStart();
  }
});

const newToken = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/**
 * Publishes a prompt's buttons and records the message id.
 *
 * The prompt is persisted by the caller *before* this runs. Discord can
 * deliver a click as soon as the message is visible, so the handler must
 * already be able to find the pending decision; if publishing fails, the
 * caller rolls the pending row back.
 */
const publishPrompt = Effect.fn("discord.publishPrompt")(function* (
  thread: ThreadChannel,
  prompt: PendingPrompt,
  payload: Parameters<ThreadChannel["send"]>[0],
) {
  const state = yield* StateStore;
  yield* state.setPending(prompt);
  const message = yield* discordCall("send", () => thread.send(payload)).pipe(
    Effect.tapError(() => state.clearPending(thread.id, prompt.token).pipe(Effect.ignore)),
  );
  // messageId is optional; keep the already-persisted token usable if this
  // metadata write fails after Discord has published the buttons.
  yield* state.updatePendingMessage(thread.id, prompt.token, message.id).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(`Could not persist ${prompt.kind} message id`, cause),
    ),
  );
});

export const presentApproval = Effect.fn("discord.presentApproval")(function* (
  thread: ThreadChannel,
  approval: { action: string; details: string },
) {
  const token = newToken();
  const prompt: PendingPrompt = {
    kind: "approval",
    token,
    threadId: thread.id,
    action: approval.action,
    details: approval.details,
  };
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`aside:approval:${thread.id}:${token}:approve`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`aside:approval:${thread.id}:${token}:deny`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
  const lines = [`🔐 Approval needed\n\nAction: ${approval.action}`];
  if (approval.details) lines.push(`Details: ${approval.details}`);
  lines.push("\nChoose an action below.");
  yield* publishPrompt(thread, prompt, {
    content: lines.join("\n").slice(0, 2_000),
    components: [buttons],
  });
});

export const presentQuestion = Effect.fn("discord.presentQuestion")(function* (
  thread: ThreadChannel,
  question: { header: string; question: string; options: Array<{ label: string; description: string }> },
) {
  const token = newToken();
  const prompt: PendingPrompt = { kind: "question", token, threadId: thread.id, ...question };
  const buttons = question.options.map((option, index) =>
    new ButtonBuilder()
      .setCustomId(`aside:question:${thread.id}:${token}:${index}`)
      .setLabel(shortText(option.label, 80))
      .setStyle(ButtonStyle.Primary),
  );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)));
  }
  const optionsText = question.options.length
    ? `\n\n${question.options
        .map((option) => `• ${option.label}${option.description ? ` — ${option.description}` : ""}`)
        .join("\n")}`
    : "";
  yield* publishPrompt(thread, prompt, {
    content: `❓ ${question.header}\n\n${question.question}${optionsText}`.slice(0, 2_000),
    components: rows,
  });
});
