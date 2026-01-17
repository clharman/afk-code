#!/usr/bin/env bun

import { run } from './run';
import { slackSetup, slackRun } from './slack';
import { discordSetup, discordRun } from './discord';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'run': {
      // Find -- separator and get command after it
      const separatorIndex = args.indexOf('--');
      if (separatorIndex === -1) {
        console.error('Usage: afk run -- <command> [args...]');
        console.error('Example: afk run -- claude');
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

    case 'help':
    case '--help':
    case '-h':
    case undefined: {
      console.log(`
AFK - Monitor Claude Code sessions from Slack/Discord

Commands:
  slack              Run the Slack bot
  slack setup        Configure Slack integration
  discord            Run the Discord bot
  discord setup      Configure Discord integration
  run -- <command>   Start a monitored session
  help               Show this help message

Examples:
  afk slack setup    # First-time Slack configuration
  afk slack          # Start the Slack bot
  afk discord setup  # First-time Discord configuration
  afk discord        # Start the Discord bot
  afk run -- claude  # Start a Claude Code session
`);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error('Run "afk help" for usage');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
