import { homedir } from 'os';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import * as readline from 'readline';

const CONFIG_DIR = `${homedir()}/.afk-code`;
const TELEGRAM_CONFIG_FILE = `${CONFIG_DIR}/telegram.env`;

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

export async function telegramSetup(): Promise<void> {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│                AFK Code Telegram Setup                       │
└─────────────────────────────────────────────────────────────┘

This will configure a Telegram bot for monitoring Claude Code sessions.

Step 1: Create a Telegram Bot
─────────────────────────────
1. Open Telegram and search for @BotFather
2. Send /newbot and follow the prompts
3. Choose a name (e.g., "AFK Code")
4. Choose a username (e.g., "my_afk_code_bot")
5. Copy the bot token BotFather gives you
`);

  const botToken = await prompt('Bot Token: ');

  if (!botToken || !botToken.includes(':')) {
    console.error('Invalid bot token. It should look like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz');
    process.exit(1);
  }

  console.log(`
Step 2: Get Your Chat ID
────────────────────────
1. Start a chat with your new bot in Telegram
2. Send it any message (e.g., "hello")
3. Visit this URL in your browser:
   https://api.telegram.org/bot${botToken}/getUpdates
4. Find "chat":{"id":YOUR_CHAT_ID} in the response
5. Copy the numeric chat ID
`);

  const chatId = await prompt('Chat ID: ');

  if (!chatId || !/^-?\d+$/.test(chatId)) {
    console.error('Invalid chat ID. It should be a number (can be negative for groups).');
    process.exit(1);
  }

  // Save configuration
  await mkdir(CONFIG_DIR, { recursive: true });

  const envContent = `# AFK Code Telegram Configuration
TELEGRAM_BOT_TOKEN=${botToken}
TELEGRAM_CHAT_ID=${chatId}
`;

  await writeFile(TELEGRAM_CONFIG_FILE, envContent);

  console.log(`
Configuration saved to ${TELEGRAM_CONFIG_FILE}

To start the Telegram bot, run:
  afk-code telegram

Then start a Claude Code session with:
  afk-code run -- claude

Your bot will send session updates to your Telegram chat!
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

export async function telegramRun(): Promise<void> {
  // Load config
  const globalConfig = await loadEnvFile(TELEGRAM_CONFIG_FILE);
  const localConfig = await loadEnvFile(`${process.cwd()}/.env`);

  const config: Record<string, string> = {
    ...globalConfig,
    ...localConfig,
  };

  // Environment variables take highest precedence
  if (process.env.TELEGRAM_BOT_TOKEN) config.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) config.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  // Validate required config
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    console.error(`Missing config: ${missing.join(', ')}`);
    console.error('');
    console.error('Run "afk-code telegram setup" for guided configuration.');
    process.exit(1);
  }

  console.log('[AFK Code] Starting Telegram bot...');

  // Import and create the Telegram app
  const { createTelegramApp } = await import('../telegram/telegram-app.js');

  const telegramConfig = {
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
  };

  const { bot, sessionManager } = createTelegramApp(telegramConfig);

  // Start session manager
  try {
    await sessionManager.start();
  } catch (err) {
    console.error('[AFK Code] Failed to start session manager:', err);
    process.exit(1);
  }

  // Start bot
  bot.start({
    onStart: (botInfo) => {
      console.log(`[AFK Code] Telegram bot @${botInfo.username} is running!`);
      console.log('');
      console.log('Start a Claude Code session with: afk-code run -- claude');
    },
  });
}
