# AFK Code

Monitor and interact with Claude Code sessions from Slack, Discord, or Telegram. Respond from your phone while AFK.

<img src="https://github.com/user-attachments/assets/83083b63-9ca2-4ef0-b83d-fcc51bd2fff9" alt="AFK Code iPhone Slack screenshot" width="400">

## Client Comparison

Telegram and Discord are recommended.

| | Telegram | Discord | Slack |
|---|---|---|---|
| Siri integration | Receive & Send | Receive only | Receive only |
| Multi-session support | One at a time (switchable) | Yes | Yes |
| Permissions required | Personal | Personal | Admin |
| Image support | Yes | Yes | Yes |

## Quick Start (Telegram)

```bash
# 1. Create a bot with @BotFather on Telegram
#    - Send /newbot and follow the prompts
#    - Copy the bot token

# 2. Get your Chat ID
#    - Message your bot, then visit:
#    - https://api.telegram.org/bot<TOKEN>/getUpdates
#    - Find "chat":{"id":YOUR_CHAT_ID}

# 3. Configure and run
npx afk-code telegram setup   # Enter your credentials
npx afk-code telegram         # Start the bot

# 4. In another terminal, start a monitored Claude session
npx afk-code claude
```

## Quick Start (Discord)

```bash
# 1. Create a Discord app at https://discord.com/developers/applications
#    - Go to Bot → Reset Token → copy it
#    - Enable "Message Content Intent"
#    - Go to OAuth2 → URL Generator → select "bot" scope
#    - Select permissions: Send Messages, Manage Channels, Read Message History, Attach Files
#    - Open the generated URL to invite the bot

# 2. Get your User ID (enable Developer Mode, right-click your name → Copy User ID)

# 3. Configure and run
npx afk-code discord setup   # Enter your credentials
npx afk-code discord         # Start the bot

# 4. In another terminal, start a monitored Claude session
npx afk-code claude
```

## Quick Start (Slack)

```bash
# 1. Create a Slack app at https://api.slack.com/apps
#    Click "Create New App" → "From manifest" → paste slack-manifest.json

# 2. Install to your workspace and get credentials:
#    - Bot Token (xoxb-...) from OAuth & Permissions
#    - App Token (xapp-...) from Basic Information → App-Level Tokens (needs connections:write)
#    - Your User ID from your Slack profile → "..." → Copy member ID

# 3. Configure and run
npx afk-code slack setup   # Enter your credentials
npx afk-code slack         # Start the bot

# 4. In another terminal, start a monitored Claude session
npx afk-code claude
```

A new channel is created for each session. Messages relay bidirectionally.

## Image Support

When Claude references image paths in responses (e.g., `/path/to/screenshot.png`), the bot automatically detects and uploads them to the chat. Supports PNG, JPG, GIF, WebP, and other common formats.

## Commands

```
afk-code telegram setup     Configure Telegram credentials
afk-code telegram           Run the Telegram bot
afk-code discord setup      Configure Discord credentials
afk-code discord            Run the Discord bot
afk-code slack setup        Configure Slack credentials
afk-code slack              Run the Slack bot
afk-code <command> [args]   Start a monitored session
afk-code help               Show help
```

### Slash Commands

| Command | Slack | Discord | Telegram | Description |
|---------|:-----:|:-------:|:--------:|-------------|
| `/sessions` | ✓ | ✓ | ✓ | List active sessions |
| `/switch <name>` | - | - | ✓ | Switch session (Telegram only) |
| `/model <name>` | ✓ | ✓ | ✓ | Switch model (opus, sonnet, haiku) |
| `/compact` | ✓ | ✓ | ✓ | Compact the conversation |
| `/background` | ✓ | ✓ | ✓ | Send Ctrl+B (background mode) |
| `/interrupt` | ✓ | ✓ | ✓ | Send Escape (interrupt) |
| `/mode` | ✓ | ✓ | ✓ | Toggle mode (Shift+Tab) |

## Installation Options

```bash
# Global install
npm install -g afk-code

# Or use npx (no install)
npx afk-code <command>

# Or run from source
git clone https://github.com/clharman/afk-code.git
cd afk-code && npm install
npm run dev -- slack
npm run dev -- claude
```

Requires Node.js 18+.

## How It Works

1. `afk-code slack`, `afk-code discord`, or `afk-code telegram` starts a bot that listens for sessions
2. `afk-code claude` spawns Claude in a PTY and connects to the bot via Unix socket
3. The bot watches Claude's JSONL files for messages and relays them to chat
4. Messages you send in chat are forwarded to the terminal

## Limitations

- Does not support plan mode or responding to Claude Code's form-based questions (AskUserQuestion)
  - You can bypass this using the `/mode` command or by sending any message
- Does not send tool calls or results (would encounter rate limits)

## Disclaimer

This project is not affiliated with Anthropic. Use at your own risk.

## License

MIT
