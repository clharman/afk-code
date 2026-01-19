# AFK Code

Monitor and interact with Claude Code sessions from Slack or Discord. Respond from your phone while AFK.

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
npx afk-code run -- claude
```

A new channel is created for each session. Messages relay bidirectionally.

## Quick Start (Discord)

```bash
# 1. Create a Discord app at https://discord.com/developers/applications
#    - Go to Bot → Reset Token → copy it
#    - Enable "Message Content Intent"
#    - Go to OAuth2 → URL Generator → select "bot" scope
#    - Select permissions: Send Messages, Manage Channels, Read Message History
#    - Open the generated URL to invite the bot

# 2. Get your User ID (enable Developer Mode, right-click your name → Copy User ID)

# 3. Configure and run
npx afk-code discord setup   # Enter your credentials
npx afk-code discord         # Start the bot

# 4. In another terminal, start a monitored Claude session
npx afk-code run -- claude
```

## Commands

```
afk-code slack setup        Configure Slack credentials
afk-code slack              Run the Slack bot
afk-code discord setup      Configure Discord credentials
afk-code discord            Run the Discord bot
afk-code run -- <command>   Start a monitored session
afk-code help               Show help
```

### Slack Slash Commands

- `/afk` - List active sessions
- `/background` - Send Ctrl+B (background mode)
- `/interrupt` - Send Escape (interrupt)
- `/mode` - Send Shift+Tab (toggle mode)

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
npm run dev -- run -- claude
```

Requires Node.js 18+.

## How It Works

1. `afk-code slack` or `afk-code discord` starts a bot that listens for sessions
2. `afk-code run -- claude` spawns Claude in a PTY and connects to the bot via Unix socket
3. The bot watches Claude's JSONL files for messages and relays them to chat
4. Messages you send in chat are forwarded to the terminal

## Limitations

- Does not support plan mode or responding to Claude Code's form-based questions (AskUserQuestion)
- Does not send tool calls or results

## License

MIT
