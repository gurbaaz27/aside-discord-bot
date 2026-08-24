# Aside Discord Bot

Use your local [Aside](https://aside.so) browser agent from Discord. Every bot-created Discord thread maps to one independent Aside session, so you can keep separate tasks and context in separate chats.

This is a macOS bridge: Discord talks to a Bun process, and the Bun process invokes the local `aside` CLI. No web server or public tunnel is required.

## How it works

```text
Discord server
   │ slash command + thread messages
   ▼
aside-discord-bot (Bun)
   ├── one queue per Discord thread
   ├── Discord buttons for approvals and questions
   └── aside exec --session <session-id>
                         │
                         ▼
                 Aside on your Mac
```

The bot reads the session transcript (`messages.jsonl`) after each turn because it is more reliable than CLI stdout when Aside uses tools. Messages sent while a thread is busy are queued for that thread. Different threads can run independently.

## Requirements

- macOS with Aside installed and signed in
- [Bun](https://bun.sh) 1.1+
- A Discord application and bot
- A private Discord server where the bot can create and reply in public threads

## Discord application setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a Bot and copy its token. Treat it like a password.
3. Copy the application ID from **General Information**.
4. Enable **Message Content Intent** under **Bot → Privileged Gateway Intents**. The bot needs this to receive normal messages in session threads.
5. Enable Developer Mode in your Discord client. Copy your user ID and the server ID.
6. Use the OAuth2 URL generator with scopes `bot` and `applications.commands`. Grant the bot at least:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Create Public Threads
   - Attach Files (only needed if you later add bot-uploaded files)

The bot also checks `DISCORD_USER_ID` and ignores every other user. This is intentionally a hard allowlist even if the server is private.

## Install and run

```bash
cp .env.example .env
# edit .env with your Discord values
bun install
bun run start
```

Use `bun run dev` during development. Commands are registered to `DISCORD_GUILD_ID`, so they appear quickly in that server. The first run creates `.data/state.json`; `.data/media/` is created when the first attachment is received.

If Aside is installed in its standard location, the bot detects:

- the active account from `~/.aside/accounts.json`
- the session directory from `~/.aside/u/<account>/sessions`
- the CLI at `~/.aside/cli/Aside CLI.app/Contents/MacOS/aside`

Set `ASIDE_CLI` or `ASIDE_SESSIONS_DIR` in `.env` if your installation uses another path. `ASIDE_MODEL` is optional; leaving it empty lets Aside use its default model.

## Usage

1. Run `/aside new` in a normal server text channel.
2. The bot creates a Discord thread and starts a new Aside session.
3. Send normal messages inside that thread.

Available commands:

| Command | Where | Purpose |
| --- | --- | --- |
| `/aside new` | Any text channel | Create a fresh thread and fresh Aside session |
| `/aside status` | Session thread | Show session, queue, model, and effort |
| `/aside sessions` | Any channel | List bot-managed threads |
| `/aside model <model>` | Session thread | Set the model for that thread's future turns |
| `/aside effort <level>` | Session thread | Set `off` through `ultrabrowse` effort |
| `/aside stop` | Session thread | Stop the active CLI process |
| `/aside help` | Any channel | Show a short usage hint |

Text and Discord attachments are forwarded to Aside. Attachments are downloaded to `.data/media/` and the local path is included in the prompt so the agent can inspect them.

For actions that need a decision, the agent is instructed not to use Aside's desktop-only question or confirmation tools. It emits a small protocol block instead; the bot renders it as Discord buttons. Approval and question choices are persisted, so a button can still be handled after a bot restart.

## Security and operational notes

- The bot has the same local access as the user running it. Aside sessions are prepared with `full-access` and `finalConfirm: false` so unattended agent work can function; understand that this allows filesystem, browser, and external side effects.
- Keep `.env` and `.data/` private. `.data/state.json` contains thread-to-session mappings and pending prompts; `.data/media/` can contain private attachments.
- The Discord user allowlist is required by the app configuration. Do not remove it just because the server currently contains only you.
- This bridge queues messages; it does not steer a currently running Aside turn.
- `/aside stop` terminates the owned `aside exec` process. It cannot undo actions already completed by the agent.
- Discord message events require Message Content Intent. If slash commands work but ordinary messages do not, check that intent and the bot's thread permissions.

## Development

```bash
bun run typecheck
bun test
```
