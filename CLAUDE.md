## Project: AFK Code

Interact with Claude Code sessions from Slack, Discord, and Telegram.

### Architecture
- **CLI**: `src/cli/` - Commands like `afk-code run`, `afk-code slack`, `afk-code discord`, `afk-code telegram`
- **Slack**: `src/slack/` - Slack bot integration
- **Discord**: `src/discord/` - Discord bot integration
- **Telegram**: `src/telegram/` - Telegram bot integration via grammY

### Running
```bash
# Slack setup (first time)
afk-code slack setup

# Start the Slack bot
afk-code slack

# Discord setup (first time)
afk-code discord setup

# Start the Discord bot
afk-code discord

# Telegram setup (first time)
afk-code telegram setup

# Start the Telegram bot
afk-code telegram

# Start a monitored Claude Code session (in another terminal)
afk-code run -- claude
```

### Key Files
- `src/cli/index.ts` - CLI entry point
- `src/cli/run.ts` - `afk-code run` command (PTY + JSONL watching)
- `src/cli/slack.ts` - Slack setup and run commands
- `src/cli/discord.ts` - Discord setup and run commands
- `src/cli/telegram.ts` - Telegram setup and run commands
- `src/slack/session-manager.ts` - JSONL watching and session tracking (shared)
- `src/slack/slack-app.ts` - Slack Bolt app and event handlers
- `src/discord/discord-app.ts` - Discord.js app and event handlers
- `src/telegram/telegram-app.ts` - Telegram grammY app and event handlers
- `slack-manifest.json` - Slack app manifest for easy setup
