import { homedir } from 'os';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import * as readline from 'readline';

const CONFIG_DIR = `${homedir()}/.afk-code`;
const DISCORD_CONFIG_FILE = `${CONFIG_DIR}/discord.env`;

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function discordSetup(): Promise<void> {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│                 AFK Code Discord Setup                      │
└─────────────────────────────────────────────────────────────┘

This will guide you through setting up the Discord bot for
monitoring Claude Code sessions.

Step 1: Create a Discord Application
────────────────────────────────────
1. Go to: https://discord.com/developers/applications
2. Click "New Application"
3. Give it a name (e.g., "AFK Code")
4. Click "Create"

Step 2: Create a Bot
────────────────────
1. Go to "Bot" in the sidebar
2. Click "Add Bot" → "Yes, do it!"
3. Under "Privileged Gateway Intents", enable:
   • MESSAGE CONTENT INTENT
4. Click "Reset Token" and copy the token

Step 3: Invite the Bot
──────────────────────
1. Go to "OAuth2" → "URL Generator"
2. Select scopes: "bot"
3. Select permissions:
   • Send Messages
   • Manage Channels
   • Read Message History
4. Copy the URL and open it to invite the bot to your server
`);

  await prompt('Press Enter when you have created and invited the bot...');

  console.log(`
Now let's collect your credentials:

• Bot Token: "Bot" → "Token" (click "Reset Token" if needed)
• Your User ID: Enable Developer Mode in Discord settings,
  then right-click your name → "Copy User ID"
`);

  const botToken = await prompt('Bot Token: ');
  if (!botToken || botToken.length < 50) {
    console.error('Invalid bot token.');
    process.exit(1);
  }

  const userId = await prompt('Your Discord User ID: ');
  if (!userId || !/^\d+$/.test(userId)) {
    console.error('Invalid user ID. Should be a number.');
    process.exit(1);
  }

  // Save configuration
  await mkdir(CONFIG_DIR, { recursive: true });

  const envContent = `# AFK Code Discord Configuration
DISCORD_BOT_TOKEN=${botToken}
DISCORD_USER_ID=${userId}
`;

  await writeFile(DISCORD_CONFIG_FILE, envContent);
  console.log(`
✓ Configuration saved to ${DISCORD_CONFIG_FILE}

To start the Discord bot, run:
  afk-code discord

Then start a Claude Code session with:
  afk-code run -- claude
`);
}

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  if (!(await fileExists(path))) return {};

  const content = await readFile(path, 'utf-8');
  const config: Record<string, string> = {};

  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...valueParts] = line.split('=');
    config[key.trim()] = valueParts.join('=').trim();
  }
  return config;
}

export async function discordRun(): Promise<void> {
  // Load config from multiple sources (in order of precedence):
  // 1. Environment variables (highest priority)
  // 2. Local .env file
  // 3. ~/.afk-code/discord.env (lowest priority)

  const globalConfig = await loadEnvFile(DISCORD_CONFIG_FILE);
  const localConfig = await loadEnvFile(`${process.cwd()}/.env`);

  // Merge configs (local overrides global, env vars override both)
  const config: Record<string, string> = {
    ...globalConfig,
    ...localConfig,
  };

  // Environment variables take highest precedence
  if (process.env.DISCORD_BOT_TOKEN) config.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  if (process.env.DISCORD_USER_ID) config.DISCORD_USER_ID = process.env.DISCORD_USER_ID;

  // Validate required config
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_USER_ID'];
  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    console.error(`Missing config: ${missing.join(', ')}`);
    console.error('');
    console.error('Provide tokens via:');
    console.error('  - Environment variables (DISCORD_BOT_TOKEN, DISCORD_USER_ID)');
    console.error('  - Local .env file');
    console.error('  - Run "afk-code discord setup" for guided configuration');
    process.exit(1);
  }

  // Import and run the discord bot
  const { createDiscordApp } = await import('../discord/discord-app.js');

  // Show where config was loaded from
  const localEnvExists = await fileExists(`${process.cwd()}/.env`);
  const globalEnvExists = await fileExists(DISCORD_CONFIG_FILE);
  const source = localEnvExists ? '.env' : globalEnvExists ? DISCORD_CONFIG_FILE : 'environment';
  console.log(`[AFK Code] Loaded config from ${source}`);
  console.log('[AFK Code] Starting Discord bot...');

  const discordConfig = {
    botToken: config.DISCORD_BOT_TOKEN,
    userId: config.DISCORD_USER_ID,
  };

  const { client, sessionManager } = createDiscordApp(discordConfig);

  // Start session manager (Unix socket server for CLI connections)
  try {
    await sessionManager.start();
    console.log('[AFK Code] Session manager started');
  } catch (err) {
    console.error('[AFK Code] Failed to start session manager:', err);
    process.exit(1);
  }

  // Start Discord bot
  try {
    await client.login(config.DISCORD_BOT_TOKEN);
    console.log('[AFK Code] Discord bot is running!');
    console.log('');
    console.log('Start a Claude Code session with: afk-code run -- claude');
    console.log('Each session will create an #afk-* channel');
  } catch (err) {
    console.error('[AFK Code] Failed to start Discord bot:', err);
    process.exit(1);
  }
}
