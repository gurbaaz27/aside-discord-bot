import {
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
import { Effect } from "effect";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { AsideBridge } from "./aside.ts";
import { discordCall, shortText } from "./discord-ui.ts";
import { writeResponseBodyToFile } from "./file-io.ts";
import { config, runtime } from "./runtime.ts";
import { StateStore, type PendingPrompt } from "./state.ts";
import { TurnRunner } from "./turn.ts";

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

const QUEUED_NOTICE = "📥 Queued — I’ll handle that after the current turn.";

function isOwner(userId: string): boolean {
  return userId === config.discordUserId;
}

/** The ephemeral reply used for every rejection and status readout. */
const ephemeral = (
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  content: string,
) =>
  discordCall("reply", () =>
    interaction.reply({ content: content.slice(0, 2_000), flags: MessageFlags.Ephemeral }),
  );

const markSessionRead = Effect.fn("bot.markSessionRead")(function* (
  aside: AsideBridge["Service"],
  sessionId: string,
) {
  yield* aside.markRead(sessionId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Could not mark Aside session ${sessionId} read: ${String(cause)}`),
    ),
    // Read state is advisory; never delay or block the Discord turn on it.
    Effect.forkDetach,
  );
});

async function saveAttachment(
  message: Message,
  attachment: { id: string; url: string; name?: string | null },
): Promise<string> {
  const mediaDir = join(config.dataDir, "media");
  await mkdir(mediaDir, { recursive: true });
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
  const original = attachment.name ?? "attachment";
  const suffix = extname(original).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  // Keyed by message and attachment id, not a timestamp: two attachments on
  // one message would otherwise land on the same path and overwrite.
  const path = join(mediaDir, `${message.channel.id}-${message.id}-${attachment.id}${suffix}`);
  await writeResponseBodyToFile(response, path, 25 * 1024 * 1024);
  return path;
}

export const handleButton = Effect.fn("bot.handleButton")(function* (interaction: ButtonInteraction) {
  const state = yield* StateStore;
  const turns = yield* TurnRunner;
  const aside = yield* AsideBridge;

  if (!isOwner(interaction.user.id)) {
    return yield* ephemeral(interaction, "This bot is private.");
  }
  const parts = interaction.customId.split(":");
  const kind = parts[1];
  const threadId = parts[2];
  const token = parts[3];
  if (!kind || !threadId || !token) {
    return yield* ephemeral(interaction, "That button is malformed.");
  }
  const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
  if (!thread || thread.id !== threadId) {
    return yield* ephemeral(interaction, "Use the buttons in the session thread.");
  }
  if (kind === "approval" && parts[4] !== "approve" && parts[4] !== "deny") {
    return yield* ephemeral(interaction, "That approval button is malformed.");
  }
  const record = state.getThread(threadId);
  if (!record) {
    return yield* ephemeral(interaction, "That session no longer exists.");
  }

  yield* markSessionRead(aside, record.sessionId);

  // Consume before acknowledging the component so two near-simultaneous
  // clicks cannot enqueue two turns. If Discord rejects the acknowledgement,
  // restore the prompt below so the valid decision is not lost.
  const claim = yield* state.consumePending(threadId, token, kind as PendingPrompt["kind"]);
  if (!claim) {
    return yield* ephemeral(interaction, "That prompt is no longer active.");
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
    const option =
      Number.isInteger(optionIndex) && optionIndex >= 0 ? pending.options[optionIndex] : undefined;
    if (!option) {
      yield* state.restorePendingIfUnchanged(claim);
      return yield* ephemeral(
        interaction,
        "That option could not be found. Please reply in your own words.",
      );
    }
    answer = `${pending.header}: ${option.label}`;
    acknowledgement = `✅ ${pending.header}: ${option.label}`;
  }

  yield* discordCall("update", () => interaction.update({ components: [] })).pipe(
    Effect.tapError(() => state.restorePendingIfUnchanged(claim).pipe(Effect.ignore)),
  );

  // Queue the decision before sending the cosmetic acknowledgement. If the
  // acknowledgement message fails, the answer has still reached Aside.
  const { queued } = yield* turns.submit(thread, record, answer);
  yield* discordCall("send", () => thread.send(acknowledgement)).pipe(
    Effect.catch((error) => Effect.logError("Could not post decision acknowledgement", error)),
  );
  if (queued) {
    yield* discordCall("send", () => thread.send(QUEUED_NOTICE)).pipe(Effect.ignore);
  }
});

const createThread = Effect.fn("bot.createThread")(function* (
  interaction: ChatInputCommandInteraction,
) {
  const state = yield* StateStore;
  const aside = yield* AsideBridge;

  const channel = interaction.channel;
  const parent: TextChannel | undefined = channel?.isThread()
    ? channel.parent && channel.parent.type === ChannelType.GuildText
      ? channel.parent
      : undefined
    : channel?.type === ChannelType.GuildText
      ? channel
      : undefined;
  if (!parent) {
    yield* discordCall("editReply", () =>
      interaction.editReply("Run `/aside new` in a normal server text channel."),
    );
    return;
  }

  const title = `aside · ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;

  // Tracked outside the pipeline so the failure path can tell "no thread" from
  // "thread created, but Aside would not start".
  let thread: ThreadChannel | undefined;

  yield* Effect.gen(function* () {
    thread = yield* discordCall("threads.create", () =>
      parent.threads.create({
        name: title.slice(0, 100),
        type: ChannelType.PublicThread,
        autoArchiveDuration: 1440,
      }),
    );
    yield* discordCall("send", () => thread!.send("Starting a fresh Aside session…"));
    const sessionId = yield* aside.createSession;
    const now = new Date().toISOString();
    yield* state.setThread({
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
    yield* discordCall("send", () => thread!.send("✅ Ready. Send a message here to talk to Aside."));
    yield* discordCall("editReply", () =>
      interaction.editReply(`Created <#${thread!.id}> — each Discord thread has its own Aside session.`),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const detail = shortText(String(error), 1_500);
        if (thread) {
          yield* discordCall("send", () => thread!.send(`❌ Could not start Aside: ${detail}`)).pipe(
            Effect.ignore,
          );
        }
        yield* discordCall("editReply", () =>
          interaction.editReply(
            thread
              ? `The thread was created, but Aside could not start: ${shortText(String(error), 1_000)}`
              : `Could not create the Discord thread: ${shortText(String(error), 1_000)}`,
          ),
        ).pipe(Effect.ignore);
      }),
    ),
  );
});

const handleCommand = Effect.fn("bot.handleCommand")(function* (
  interaction: ChatInputCommandInteraction,
) {
  const state = yield* StateStore;
  const turns = yield* TurnRunner;

  if (!isOwner(interaction.user.id)) {
    return yield* ephemeral(interaction, "This bot is private.");
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "help") {
    return yield* ephemeral(
      interaction,
      "Use `/aside new` in a text channel. Then send normal messages inside the created thread. Use `/aside status`, `/aside stop`, `/aside model`, and `/aside effort` inside a thread.",
    );
  }
  if (subcommand === "new") {
    yield* discordCall("deferReply", () =>
      interaction.deferReply({ flags: MessageFlags.Ephemeral }),
    );
    return yield* createThread(interaction);
  }
  if (subcommand === "sessions") {
    const records = state.listThreads(interaction.guildId ?? undefined).slice(0, 20);
    const text = records.length
      ? records
          .map((record) => `<#${record.threadId}> — ${record.title} — session \`${record.sessionId}\``)
          .join("\n")
      : "No Discord sessions yet. Use `/aside new`.";
    return yield* ephemeral(interaction, text);
  }

  const record = state.getThread(interaction.channel?.id ?? "");
  if (!record) {
    return yield* ephemeral(
      interaction,
      "This command belongs in an Aside session thread. Use `/aside new` first.",
    );
  }

  if (subcommand === "status") {
    const turnStatus = yield* turns.status(record.threadId);
    const label =
      turnStatus._tag === "Working"
        ? `working (${turnStatus.elapsed})`
        : turnStatus._tag === "Queued"
          ? "queued"
          : "idle";
    yield* ephemeral(
      interaction,
      `Session: \`${record.sessionId}\`\nState: ${label}\nModel: ${record.model ?? "Aside default"}\nEffort: ${record.effort ?? config.asideEffort}`,
    );
  } else if (subcommand === "model") {
    record.model = interaction.options.getString("model", true);
    yield* state.setThread(record);
    yield* ephemeral(interaction, `Future turns in this thread will use model \`${record.model}\`.`);
  } else if (subcommand === "effort") {
    record.effort = interaction.options.getString("level", true);
    yield* state.setThread(record);
    yield* ephemeral(interaction, `Future turns in this thread will use \`${record.effort}\` effort`);
  } else if (subcommand === "stop") {
    const stopped = yield* turns.interrupt(record.threadId);
    if (!stopped) {
      yield* ephemeral(interaction, "This session is idle.");
    } else {
      yield* discordCall("reply", () => interaction.reply("🛑 Stopping the active Aside turn…"));
    }
  }
});

export const handleMessage = Effect.fn("bot.handleMessage")(function* (message: Message) {
  const state = yield* StateStore;
  const turns = yield* TurnRunner;
  const aside = yield* AsideBridge;

  if (
    message.author.bot ||
    !message.guild ||
    !isOwner(message.author.id) ||
    !message.channel.isThread()
  ) {
    return;
  }
  const record = state.getThread(message.channel.id);
  if (!record) return;

  const parts: string[] = [];
  if (message.content.trim()) parts.push(message.content.trim());
  for (const attachment of message.attachments.values()) {
    const saved = yield* Effect.tryPromise(() => saveAttachment(message, attachment)).pipe(
      Effect.result,
    );
    parts.push(
      saved._tag === "Success"
        ? `[The owner attached a file. It is saved at ${saved.success}; inspect it if useful.]`
        : `[The owner attached ${attachment.name ?? "a file"}, but it could not be downloaded: ${String(saved.failure)}]`,
    );
  }
  const prompt = parts.join("\n\n");
  if (!prompt) return;

  // Discord does not expose a supported read receipt to bots. A subsequent
  // owner message is our conservative signal that the session was revisited.
  yield* markSessionRead(aside, record.sessionId);

  // A free-form reply is also a valid answer to a question without buttons.
  // Retire the old prompt so it cannot be answered again later.
  const pending = state.getPending(message.channel.id);
  if (pending) {
    yield* state.clearPending(message.channel.id, pending.token);
  } else {
    // A button handler may have consumed the prompt while its Discord
    // acknowledgement is still in flight. Advance the revision even though
    // there is no pending row, preventing stale restoration.
    yield* state.invalidatePendingRevision(message.channel.id);
  }
  yield* state.touchThread(message.channel.id);

  const { queued } = yield* turns.submit(
    message.channel as ThreadChannel,
    record,
    prompt,
  );
  if (queued) {
    yield* discordCall("send", () => (message.channel as ThreadChannel).send(QUEUED_NOTICE)).pipe(
      Effect.ignore,
    );
  }
});

const registerCommands = Effect.fn("bot.registerCommands")(function* (client: Client) {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  yield* discordCall("commands.put", () =>
    rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
      body: commands,
    }),
  );
  yield* Effect.logInfo(`Registered ${commands.length} command in guild ${config.discordGuildId}`);
  yield* Effect.logInfo(`Logged in as ${client.user?.tag}`);
});

type AppServices = StateStore | TurnRunner | AsideBridge;

/** Runs a handler on the shared runtime, logging anything it fails with. */
const dispatch = <A, E>(label: string, effect: Effect.Effect<A, E, AppServices>) =>
  void runtime.runFork(
    effect.pipe(Effect.catchCause((cause) => Effect.logError(`${label} failed`, cause))),
  );

async function main(): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    dispatch(
      "Command registration",
      registerCommands(readyClient).pipe(
        Effect.tapCause(() => Effect.sync(() => (process.exitCode = 1))),
      ),
    );
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isButton()) dispatch("Interaction", handleButton(interaction));
    else if (interaction.isChatInputCommand()) dispatch("Interaction", handleCommand(interaction));
  });
  client.on(Events.MessageCreate, (message) => {
    dispatch("Message", handleMessage(message));
  });

  // launchd sends SIGTERM and SIGKILLs ~20s later, while a turn can run for
  // twenty minutes -- so shut down by interrupting turns, never by waiting for
  // them. Interrupting closes each turn's scope, which kills its Aside child.
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Never let teardown outlive launchd's ~20s patience.
      const hardStop = setTimeout(() => process.exit(0), 10_000);
      hardStop.unref?.();
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const turns = yield* TurnRunner;
            yield* turns.shutdown;
          }),
        )
        .catch((error) => console.error("Shutdown failed:", error))
        .finally(async () => {
          await runtime.dispose();
          await client.destroy();
          clearTimeout(hardStop);
          process.exit(0);
        });
    });
  }

  await client.login(config.discordToken);
}

if (import.meta.main) {
  await main();
}
