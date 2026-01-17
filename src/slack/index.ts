import { createSlackApp } from './slack-app';
import type { SlackConfig } from './types';

async function main() {
  const config: SlackConfig = {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    appToken: process.env.SLACK_APP_TOKEN || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    userId: process.env.SLACK_USER_ID || '',
  };

  // Validate required config
  const required: (keyof SlackConfig)[] = ['botToken', 'appToken', 'userId'];

  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    console.error(`[Slack] Missing required config: ${missing.join(', ')}`);
    console.error('');
    console.error('Required environment variables:');
    console.error('  SLACK_BOT_TOKEN     - Bot User OAuth Token (xoxb-...)');
    console.error('  SLACK_APP_TOKEN     - App-Level Token for Socket Mode (xapp-...)');
    console.error('  SLACK_USER_ID       - Your Slack user ID (U...)');
    console.error('');
    console.error('Optional:');
    console.error('  SLACK_SIGNING_SECRET - Signing secret (for request verification)');
    process.exit(1);
  }

  console.log('[Slack] Starting AFK bot...');

  const { app, sessionManager } = createSlackApp(config);

  // Start session manager (Unix socket server for CLI connections)
  try {
    await sessionManager.start();
    console.log('[Slack] Session manager started');
  } catch (err) {
    console.error('[Slack] Failed to start session manager:', err);
    process.exit(1);
  }

  // Start Slack app
  try {
    await app.start();
    console.log('[Slack] Bot is running!');
    console.log('');
    console.log('Start a Claude Code session with: bun run dev run -- claude');
    console.log('Each session will create a private #afk-* channel');
  } catch (err) {
    console.error('[Slack] Failed to start app:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Slack] Fatal error:', err);
  process.exit(1);
});
