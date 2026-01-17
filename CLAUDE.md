Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Project: AFK

Monitor Claude Code sessions from Slack/Discord.

### Architecture
- **CLI**: `src/cli/` - Commands like `afk run`, `afk slack`, `afk discord`
- **Slack**: `src/slack/` - Slack bot integration
- **Discord**: `src/discord/` - Discord bot integration (planned)

### Running
```bash
# Setup (first time)
afk slack setup

# Start the Slack bot
afk slack

# Start a monitored Claude Code session (in another terminal)
afk run -- claude
```

### Key Files
- `src/cli/index.ts` - CLI entry point
- `src/cli/slack.ts` - Slack setup and run commands
- `src/slack/session-manager.ts` - JSONL watching and session tracking
- `src/slack/slack-app.ts` - Slack Bolt app and event handlers
- `slack-manifest.json` - Slack app manifest for easy setup
