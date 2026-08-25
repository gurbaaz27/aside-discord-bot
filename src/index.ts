import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { AsideBridge } from "./aside.ts";
import { loadConfig, type Config } from "./config.ts";
import { writeResponseBodyToFile } from "./file-io.ts";
import { parseApproval, parseQuestion, removeProtocolBlocks } from "./protocol.ts";
import { StateStore, type PendingPrompt, type ThreadRecord } from "./state.ts";

const config = loadConfig();
const state = new StateStore(config.dataDir);
const aside = new AsideBridge(config);
const active = new Map<string, { controller: AbortController; startedAt: number }>();
const queues = new Map<string, Promise<void>>();

const commands = [
  new SlashCommandBuilder()
    .setName("aside")
    .setDescription("Manage your Aside Discord sessions")
    .addSubcommand((subcommand) =>
      subcommand.setName("new").setDescription("Create a new Discord thread and Aside session"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("status").setDescription("Show this thread's Aside status"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("sessions").setDescription("List Discord threads connected to Aside sessions"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("model")
        .setDescription("Set the model for future turns in this thread")
        .addStringOption((option) => option.setName("model").setDescription("Aside model id").setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("effort")
        .setDescription("Set thinking effort for future turns in this thread")
        .addStringOption((option) =>
          option
            .setName("level")
            .setDescription("Thinking effort")
            .setRequired(true)
            .addChoices(
              { name: "off", value: "off" },
              { name: "minimal", value: "minimal" },
              { name: "low", value: "low" },
              { name: "medium", value: "medium" },
              { name: "high", value: "high" },
              { name: "xhigh", value: "xhigh" },
              { name: "ultrabrowse", value: "ultrabrowse" },
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("stop").setDescription("Stop the active Aside turn in this thread"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("help").setDescription("Show how to use the bot"),
    )
    .toJSON(),
];

function isOwner(userId: string): boolean {
  return userId === config.discordUserId;
}

function getThread(interaction: ChatInputCommandInteraction | Message): ThreadRecord | undefined {
  return state.getThread(interaction.channel?.id ?? "");
}

function shortText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

async function sendChunks(thread: ThreadChannel, text: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  let remaining = clean;
  while (remaining.length > 0) {
    if (remaining.length <= 2_000) {
      await thread.send(remaining);
      return;
    }
    let cut = remaining.lastIndexOf("\n\n", 2_000);
    if (cut < 500) cut = remaining.lastIndexOf("\n", 2_000);
    if (cut < 500) cut = 2_000;
    await thread.send(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
}

async function saveAttachment(message: Message, attachment: { url: string; name?: string | null }): Promise<string> {
  const mediaDir = join(config.dataDir, "media");
  await mkdir(mediaDir, { recursive: true });
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
  const original = attachment.name ?? "attachment";
  const suffix = extname(original).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  const path = join(mediaDir, `${message.channel.id}-${Date.now()}${suffix}`);
  await writeResponseBodyToFile(response, path, 25 * 1024 * 1024);
  return path;
}

function queueForThread(threadId: string, task: () => Promise<void>): boolean {
  const previous = queues.get(threadId);
  const wasBusy = Boolean(previous);
  const next = (previous ?? Promise.resolve()).then(task).catch(async (error: unknown) => {
    console.error(`Turn failed in thread ${threadId}:`, error);
  });
  queues.set(threadId, next);
  void next.finally(() => {
    if (queues.get(threadId) === next) queues.delete(threadId);
  });
  return wasBusy;
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function syncThreadTitle(thread: ThreadChannel, record: ThreadRecord): Promise<void> {
  const asideTitle = await aside.sessionTitle(record.sessionId);
  if (!asideTitle) return;
  const title = shortText(asideTitle, 100);
  if (!title) return;
  try {
    if (thread.name !== title) await thread.setName(title);
    if (record.title !== title) {
      record.title = title;
      await state.setThread(record);
    }
  } catch (error) {
    console.error(`Could not sync Discord thread title for ${thread.id}:`, error);
  }
}

async function runTurn(thread: ThreadChannel, record: ThreadRecord, prompt: string): Promise<void> {
  const controller = new AbortController();
  const startedAt = Date.now();
  active.set(thread.id, { controller, startedAt });
  let status;
  try {
    status = await thread.send("⏳ Working…");
  } catch (error) {
    active.delete(thread.id);
    console.error(`Could not post status in thread ${thread.id}:`, error);
    return;
  }
  const ticker = setInterval(() => {
    void status.edit(`⏳ Working… ${formatElapsed(startedAt)}`).catch(() => undefined);
  }, 10_000);

  try {
    const { result, response } = await aside.run(record.sessionId, prompt, {
      model: record.model ?? config.asideModel,
      effort: record.effort ?? config.asideEffort,
      signal: controller.signal,
    });
    await syncThreadTitle(thread, record);
    const approval = parseApproval(response);
    const question = approval ? undefined : parseQuestion(response);
    const visible = approval || question ? removeProtocolBlocks(response) : response;

    await status.edit(`✅ Finished in ${formatElapsed(startedAt)}`).catch(() => undefined);
    if (controller.signal.aborted) {
      await thread.send("🛑 Turn stopped.");
    } else if (visible) {
      await sendChunks(thread, visible);
    }

    if (controller.signal.aborted) {
      // Nothing else should be emitted for a cancelled turn.
    } else if (approval) {
      await presentApproval(thread, approval);
    } else if (question) {
      await presentQuestion(thread, question);
    } else if (!response && result.timedOut) {
      await thread.send("The Aside turn timed out. Use `/aside stop` for future turns or try again.");
    } else if (!response && result.code !== 0) {
      await thread.send(`Aside returned an error: ${shortText(result.stderr || result.stdout || "unknown error", 1_500)}`);
    } else if (!response) {
      await thread.send("Aside finished without a response. Check the Mac's Aside app and try again.");
    }
  } finally {
    clearInterval(ticker);
    active.delete(thread.id);
    await state.touchThread(thread.id);
  }
}

async function presentApproval(thread: ThreadChannel, approval: { action: string; details: string }): Promise<void> {
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const prompt: PendingPrompt = {
    kind: "approval",
    token,
    threadId: thread.id,
    action: approval.action,
    details: approval.details,
  };
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`aside:approval:${thread.id}:${token}:approve`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`aside:approval:${thread.id}:${token}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger),
  );
  const lines = [`🔐 Approval needed\n\nAction: ${approval.action}`];
  if (approval.details) lines.push(`Details: ${approval.details}`);
  lines.push("\nChoose an action below.");
  // Persist before publishing the buttons. Discord can deliver a click as
  // soon as the message is visible, so the handler must already be able to
  // find the pending decision.
  await state.setPending(prompt);
  let message;
  try {
    message = await thread.send({ content: lines.join("\n").slice(0, 2_000), components: [buttons] });
  } catch (error) {
    await state.clearPending(thread.id, prompt.token);
    throw error;
  }
  try {
    await state.updatePendingMessage(thread.id, prompt.token, message.id);
  } catch (error) {
    // messageId is optional; keep the already-persisted token usable if this
    // metadata write fails after Discord has published the buttons.
    console.error("Could not persist approval message id:", error);
  }
}

async function presentQuestion(thread: ThreadChannel, question: { header: string; question: string; options: Array<{ label: string; description: string }> }): Promise<void> {
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
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
    ? `\n\n${question.options.map((option) => `• ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n")}`
    : "";
  // Persist before publishing the buttons; otherwise a fast click can race
  // the state write and be rejected as an inactive prompt.
  await state.setPending(prompt);
  let message;
  try {
    message = await thread.send({ content: `❓ ${question.header}\n\n${question.question}${optionsText}`.slice(0, 2_000), components: rows });
  } catch (error) {
    await state.clearPending(thread.id, prompt.token);
    throw error;
  }
  try {
    await state.updatePendingMessage(thread.id, prompt.token, message.id);
  } catch (error) {
    console.error("Could not persist question message id:", error);
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: "This bot is private.", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const kind = parts[1];
  const threadId = parts[2];
  const token = parts[3];
  if (!kind || !threadId || !token) {
    await interaction.reply({ content: "That button is malformed.", flags: MessageFlags.Ephemeral });
    return;
  }
  const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
  if (!thread || thread.id !== threadId) {
    await interaction.reply({ content: "Use the buttons in the session thread.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (kind === "approval" && parts[4] !== "approve" && parts[4] !== "deny") {
    await interaction.reply({ content: "That approval button is malformed.", flags: MessageFlags.Ephemeral });
    return;
  }
  const record = state.getThread(threadId);
  if (!record) {
    await interaction.reply({ content: "That session no longer exists.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Consume before acknowledging the component so two near-simultaneous
  // clicks cannot enqueue two turns. If Discord rejects the acknowledgement,
  // restore the prompt below so the valid decision is not lost.
  const claim = await state.consumePending(threadId, token, kind as PendingPrompt["kind"]);
  if (!claim) {
    await interaction.reply({ content: "That prompt is no longer active.", flags: MessageFlags.Ephemeral });
    return;
  }
  const pending = claim.pending;

  let answer: string;
  let acknowledgement: string;
  if (pending.kind === "approval") {
    const approved = parts[4] === "approve";
    answer = approved
      ? `[APPROVAL GRANTED] I approve this action: ${pending.action}. Proceed now.`
      : `[APPROVAL DENIED] Do not perform this action: ${pending.action}. Acknowledge and stop.`;
    acknowledgement = approved ? `✅ Approved: ${pending.action}` : `🛑 Denied: ${pending.action}`;
  } else {
    const optionIndex = Number(parts[4] ?? "-1");
    const option = Number.isInteger(optionIndex) && optionIndex >= 0 ? pending.options[optionIndex] : undefined;
    if (!option) {
      await state.restorePendingIfUnchanged(claim);
      await interaction.reply({ content: "That option could not be found. Please reply in your own words.", flags: MessageFlags.Ephemeral });
      return;
    }
    answer = `${pending.header}: ${option.label}`;
    acknowledgement = `✅ ${pending.header}: ${option.label}`;
  }

  try {
    await interaction.update({ components: [] });
  } catch (error) {
    await state.restorePendingIfUnchanged(claim);
    throw error;
  }

  // Queue the decision before sending the cosmetic acknowledgement. If the
  // acknowledgement message fails, the answer has still reached Aside.
  const wasBusy = queueForThread(threadId, () => runTurn(thread, record, answer));
  await thread.send(acknowledgement).catch((error) => console.error("Could not post decision acknowledgement:", error));
  if (wasBusy) await thread.send("📥 Queued — I’ll handle that after the current turn.").catch(() => undefined);
}

async function createThread(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  const parent: TextChannel | undefined = channel?.isThread()
    ? channel.parent && channel.parent.type === ChannelType.GuildText
      ? channel.parent
      : undefined
    : channel?.type === ChannelType.GuildText
      ? channel
      : undefined;
  if (!parent) {
    await interaction.editReply("Run `/aside new` in a normal server text channel.");
    return;
  }

  const title = `aside · ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  let thread: ThreadChannel | undefined;
  try {
    thread = await parent.threads.create({ name: title.slice(0, 100), type: ChannelType.PublicThread, autoArchiveDuration: 1440 });
    await thread.send("Starting a fresh Aside session…");
    const sessionId = await aside.createSession();
    const now = new Date().toISOString();
    await state.setThread({
      threadId: thread.id,
      guildId: interaction.guildId!,
      parentChannelId: parent.id,
      sessionId,
      title,
      model: config.asideModel,
      effort: config.asideEffort,
      createdAt: now,
      lastActivityAt: now,
    });
    await thread.send("✅ Ready. Send a message here to talk to Aside.");
    await interaction.editReply(`Created <#${thread.id}> — each Discord thread has its own Aside session.`);
  } catch (error) {
    if (thread) await thread.send(`❌ Could not start Aside: ${shortText(String(error), 1_500)}`).catch(() => undefined);
    await interaction.editReply(thread
      ? `The thread was created, but Aside could not start: ${shortText(String(error), 1_000)}`
      : `Could not create the Discord thread: ${shortText(String(error), 1_000)}`);
  }
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: "This bot is private.", flags: MessageFlags.Ephemeral });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "help") {
    await interaction.reply({ content: "Use `/aside new` in a text channel. Then send normal messages inside the created thread. Use `/aside status`, `/aside stop`, `/aside model`, and `/aside effort` inside a thread.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (subcommand === "new") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await createThread(interaction);
    return;
  }
  if (subcommand === "sessions") {
    const records = state.listThreads(interaction.guildId ?? undefined).slice(0, 20);
    const text = records.length
      ? records.map((record) => `<#${record.threadId}> — ${record.title} — session \`${record.sessionId}\``).join("\n")
      : "No Discord sessions yet. Use `/aside new`.";
    await interaction.reply({ content: text.slice(0, 2_000), flags: MessageFlags.Ephemeral });
    return;
  }

  const record = getThread(interaction);
  if (!record) {
    await interaction.reply({ content: "This command belongs in an Aside session thread. Use `/aside new` first.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (subcommand === "status") {
    const running = active.get(record.threadId);
    const queued = queues.has(record.threadId) && !running;
    await interaction.reply({ content: `Session: \`${record.sessionId}\`\nState: ${running ? `working (${formatElapsed(running.startedAt)})` : queued ? "queued" : "idle"}\nModel: ${record.model ?? "Aside default"}\nEffort: ${record.effort ?? config.asideEffort}`, flags: MessageFlags.Ephemeral });
  } else if (subcommand === "model") {
    record.model = interaction.options.getString("model", true);
    await state.setThread(record);
    await interaction.reply({ content: `Future turns in this thread will use model \`${record.model}\`.`, flags: MessageFlags.Ephemeral });
  } else if (subcommand === "effort") {
    record.effort = interaction.options.getString("level", true);
    await state.setThread(record);
    await interaction.reply({ content: `Future turns in this thread will use \`${record.effort}\` effort`, flags: MessageFlags.Ephemeral });
  } else if (subcommand === "stop") {
    const current = active.get(record.threadId);
    if (!current) {
      await interaction.reply({ content: "This session is idle.", flags: MessageFlags.Ephemeral });
    } else {
      current.controller.abort();
      await interaction.reply("🛑 Stopping the active Aside turn…");
    }
  }
}

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.guild || !isOwner(message.author.id) || !message.channel.isThread()) return;
  const record = state.getThread(message.channel.id);
  if (!record) return;
  const parts: string[] = [];
  if (message.content.trim()) parts.push(message.content.trim());
  for (const attachment of message.attachments.values()) {
    try {
      const path = await saveAttachment(message, attachment);
      parts.push(`[The owner attached a file. It is saved at ${path}; inspect it if useful.]`);
    } catch (error) {
      parts.push(`[The owner attached ${attachment.name ?? "a file"}, but it could not be downloaded: ${String(error)}]`);
    }
  }
  const prompt = parts.join("\n\n");
  if (!prompt) return;
  // A free-form reply is also a valid answer to a question without buttons.
  // Retire the old prompt so it cannot be answered again later.
  const pending = state.getPending(message.channel.id);
  if (pending) {
    await state.clearPending(message.channel.id, pending.token);
  } else {
    // A button handler may have consumed the prompt while its Discord
    // acknowledgement is still in flight. Advance the revision even though
    // there is no pending row, preventing stale restoration.
    await state.invalidatePendingRevision(message.channel.id);
  }
  await state.touchThread(message.channel.id);
  const wasBusy = queueForThread(message.channel.id, () => runTurn(message.channel as ThreadChannel, record, prompt));
  if (wasBusy) await message.channel.send("📥 Queued — I’ll handle that after the current turn.");
}

async function registerCommands(client: Client): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: commands });
  console.log(`Registered ${commands.length} command in guild ${config.discordGuildId}`);
  console.log(`Logged in as ${client.user?.tag}`);
}

async function main(): Promise<void> {
  await state.load();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  client.once(Events.ClientReady, (readyClient) => {
    void registerCommands(readyClient).catch((error) => {
      console.error("Could not register slash commands:", error);
      process.exitCode = 1;
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void (interaction.isButton() ? handleButton(interaction) : interaction.isChatInputCommand() ? handleCommand(interaction) : Promise.resolve()).catch((error) => {
      console.error("Interaction failed:", error);
    });
  });
  client.on(Events.MessageCreate, (message) => void handleMessage(message).catch((error) => console.error("Message failed:", error)));
  await client.login(config.discordToken);
}

await main();
