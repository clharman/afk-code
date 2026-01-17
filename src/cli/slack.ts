import { homedir } from 'os';
import { mkdir } from 'fs/promises';
import * as readline from 'readline';

const SLACK_CONFIG_DIR = `${homedir()}/.snowfort`;
const SLACK_CONFIG_FILE = `${SLACK_CONFIG_DIR}/slack.env`;
const MANIFEST_URL = 'https://raw.githubusercontent.com/colinharman/snowfort/main/slack-manifest.json';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function slackSetup(): Promise<void> {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│                 Snowfort Slack Setup                        │
└─────────────────────────────────────────────────────────────┘

This will guide you through setting up the Slack bot for
monitoring Claude Code sessions.

Step 1: Create a Slack App
──────────────────────────
1. Go to: https://api.slack.com/apps
2. Click "Create New App" → "From manifest"
3. Select your workspace
4. Paste the manifest from: ${MANIFEST_URL}
   (Or copy from slack-manifest.json in this repo)
5. Click "Create"

Step 2: Install the App
───────────────────────
1. Go to "Install App" in the sidebar
2. Click "Install to Workspace"
3. Authorize the app

Step 3: Get Your Tokens
───────────────────────
`);

  await prompt('Press Enter when you have created and installed the app...');

  console.log(`
Now let's collect your tokens:

• Bot Token: "OAuth & Permissions" → "Bot User OAuth Token" (starts with xoxb-)
• App Token: "Basic Information" → "App-Level Tokens" → Generate one with
  "connections:write" scope (starts with xapp-)
• User ID: Click your profile in Slack → "..." → "Copy member ID"
`);

  const botToken = await prompt('Bot Token (xoxb-...): ');
  if (!botToken.startsWith('xoxb-')) {
    console.error('Invalid bot token. Should start with xoxb-');
    process.exit(1);
  }

  const appToken = await prompt('App Token (xapp-...): ');
  if (!appToken.startsWith('xapp-')) {
    console.error('Invalid app token. Should start with xapp-');
    process.exit(1);
  }

  const userId = await prompt('Your Slack User ID (U...): ');
  if (!userId.startsWith('U')) {
    console.error('Invalid user ID. Should start with U');
    process.exit(1);
  }

  // Save configuration
  await mkdir(SLACK_CONFIG_DIR, { recursive: true });

  const envContent = `# Snowfort Slack Configuration
SLACK_BOT_TOKEN=${botToken}
SLACK_APP_TOKEN=${appToken}
SLACK_USER_ID=${userId}
`;

  await Bun.write(SLACK_CONFIG_FILE, envContent);
  console.log(`
✓ Configuration saved to ${SLACK_CONFIG_FILE}

To start the Slack bot, run:
  snowfort slack

Then start a Claude Code session with:
  snowfort run -- claude
`);
}

export async function slackRun(): Promise<void> {
  // Load config from ~/.snowfort/slack.env
  const configFile = Bun.file(SLACK_CONFIG_FILE);

  if (!(await configFile.exists())) {
    console.error('Slack not configured. Run "snowfort slack setup" first.');
    process.exit(1);
  }

  const content = await configFile.text();
  const config: Record<string, string> = {};

  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...valueParts] = line.split('=');
    config[key.trim()] = valueParts.join('=').trim();
  }

  // Validate required config
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_USER_ID'];
  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    console.error(`Missing config: ${missing.join(', ')}`);
    console.error('Run "snowfort slack setup" to reconfigure.');
    process.exit(1);
  }

  // Set environment variables and start the bot
  process.env.SLACK_BOT_TOKEN = config.SLACK_BOT_TOKEN;
  process.env.SLACK_APP_TOKEN = config.SLACK_APP_TOKEN;
  process.env.SLACK_USER_ID = config.SLACK_USER_ID;

  // Import and run the slack bot
  const { createSlackApp } = await import('../slack/slack-app');
  const { SessionManager } = await import('../slack/session-manager');

  console.log('[Snowfort] Starting Slack bot...');

  const slackConfig = {
    botToken: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    signingSecret: '',
    userId: config.SLACK_USER_ID,
  };

  const { app, sessionManager } = createSlackApp(slackConfig);

  // Start session manager (Unix socket server for CLI connections)
  try {
    await sessionManager.start();
    console.log('[Snowfort] Session manager started');
  } catch (err) {
    console.error('[Snowfort] Failed to start session manager:', err);
    process.exit(1);
  }

  // Start Slack app
  try {
    await app.start();
    console.log('[Snowfort] Slack bot is running!');
    console.log('');
    console.log('Start a Claude Code session with: snowfort run -- claude');
    console.log('Each session will create a private #afk-* channel');
  } catch (err) {
    console.error('[Snowfort] Failed to start Slack app:', err);
    process.exit(1);
  }
}
