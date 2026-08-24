import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_USER_ID: z.string().min(1),
  ASIDE_CLI: z.string().optional(),
  ASIDE_SESSIONS_DIR: z.string().optional(),
  ASIDE_MODEL: z.string().optional(),
  ASIDE_EFFORT: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "ultrabrowse"])
    .default("medium"),
  ASIDE_EXEC_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1200),
  DATA_DIR: z.string().default(".data"),
});

export type Config = {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  discordUserId: string;
  asideCli: string;
  asideSessionsDir: string;
  asideModel?: string;
  asideEffort: string;
  asideExecTimeoutMs: number;
  dataDir: string;
};

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function detectAsideRoot(): string {
  const accountsPath = join(homedir(), ".aside", "accounts.json");
  try {
    const accounts = JSON.parse(readFileSync(accountsPath, "utf8")) as {
      currentAccountId?: unknown;
    };
    const id = accounts.currentAccountId;
    if (typeof id === "number" && Number.isInteger(id) && id >= 0) {
      return join(homedir(), ".aside", "u", String(id));
    }
  } catch {
    // A single-account install uses u/0, and old Aside installs may not have
    // accounts.json yet.
  }
  return join(homedir(), ".aside", "u", "0");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const value = parsed.data;
  const asideRoot = detectAsideRoot();
  const asideCli = expandHome(
    value.ASIDE_CLI?.trim() || join(homedir(), ".aside", "cli", "Aside CLI.app", "Contents", "MacOS", "aside"),
  );
  const sessionsDir = expandHome(
    value.ASIDE_SESSIONS_DIR?.trim() || join(asideRoot, "sessions"),
  );

  return {
    discordToken: value.DISCORD_TOKEN,
    discordClientId: value.DISCORD_CLIENT_ID,
    discordGuildId: value.DISCORD_GUILD_ID,
    discordUserId: value.DISCORD_USER_ID,
    asideCli,
    asideSessionsDir: sessionsDir,
    asideModel: value.ASIDE_MODEL?.trim() || undefined,
    asideEffort: value.ASIDE_EFFORT,
    asideExecTimeoutMs: value.ASIDE_EXEC_TIMEOUT_SECONDS * 1000,
    dataDir: resolve(expandHome(value.DATA_DIR)),
  };
}
