import { run } from './run.js';
import { slackSetup, slackRun } from './slack.js';
import { discordSetup, discordRun } from './discord.js';
import { telegramSetup, telegramRun } from './telegram.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'run': {
      // Find -- separator and get command after it
      const separatorIndex = args.indexOf('--');
      if (separatorIndex === -1) {
        console.error('Usage: afk-code run -- <command> [args...]');
        console.error('Example: afk-code run -- claude');
        process.exit(1);
      }
      const cmd = args.slice(separatorIndex + 1);
      if (cmd.length === 0) {
        console.error('No command specified after --');
        process.exit(1);
      }
      await run(cmd);
      break;
    }

    case 'slack': {
      if (args[1] === 'setup') {
        await slackSetup();
      } else {
        await slackRun();
      }
      break;
    }

    case 'discord': {
      if (args[1] === 'setup') {
        await discordSetup();
      } else {
        await discordRun();
      }
      break;
    }

    case 'telegram': {
      if (args[1] === 'setup') {
        await telegramSetup();
      } else {
        await telegramRun();
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined: {
      console.log(`
AFK Code - Monitor Claude Code sessions from Slack/Discord/Telegram

Commands:
  slack              Run the Slack bot
  slack setup        Configure Slack integration
  discord            Run the Discord bot
  discord setup      Configure Discord integration
  telegram           Run the Telegram bot
  telegram setup     Configure Telegram integration
  run -- <command>   Start a monitored session
  help               Show this help message

Examples:
  afk-code slack setup      # First-time Slack configuration
  afk-code slack            # Start the Slack bot
  afk-code discord setup    # First-time Discord configuration
  afk-code discord          # Start the Discord bot
  afk-code telegram setup   # First-time Telegram configuration
  afk-code telegram         # Start the Telegram bot
  afk-code run -- claude    # Start a Claude Code session
`);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error('Run "afk-code help" for usage');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
