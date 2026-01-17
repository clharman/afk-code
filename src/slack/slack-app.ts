import { App, LogLevel } from '@slack/bolt';
import type { SlackConfig } from './types';
import { SessionManager, type SessionInfo } from './session-manager';
import { ChannelManager } from './channel-manager';
import {
  markdownToSlack,
  chunkMessage,
  formatSessionStatus,
  formatTodos,
} from './message-formatter';

export function createSlackApp(config: SlackConfig) {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const channelManager = new ChannelManager(app.client, config.userId);

  // Track messages sent from Slack to avoid re-posting them when they come back via JSONL
  const slackSentMessages = new Set<string>();

  // Create session manager with event handlers that post to Slack
  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      const channel = await channelManager.createChannel(session.id, session.name, session.cwd);
      if (channel) {
        // Post initial message to channel
        await app.client.chat.postMessage({
          channel: channel.channelId,
          text: `${formatSessionStatus(session.status)} *Session started*\n\`${session.cwd}\``,
          mrkdwn: true,
        });
      }
    },

    onSessionEnd: async (sessionId) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateStatus(sessionId, 'ended');

        // Post final message
        await app.client.chat.postMessage({
          channel: channel.channelId,
          text: ':stop_sign: *Session ended* - this channel will be archived',
        });

        // Archive the channel
        await channelManager.archiveChannel(sessionId);
      }
    },

    onSessionUpdate: async (sessionId, name) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateName(sessionId, name);
        // Update channel topic with new name
        try {
          await app.client.conversations.setTopic({
            channel: channel.channelId,
            topic: `Claude Code session: ${name}`,
          });
        } catch (err) {
          console.error('[Slack] Failed to update channel topic:', err);
        }
      }
    },

    onSessionStatus: async (sessionId, status) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        const previousStatus = channel.status;
        channelManager.updateStatus(sessionId, status);

        // Notify user when session becomes idle (finished responding)
        if (previousStatus === 'running' && status === 'idle') {
          await app.client.chat.postMessage({
            channel: channel.channelId,
            text: `<@${config.userId}> Session is waiting for input`,
          });
        }
      }
    },

    onMessage: async (sessionId, role, content) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        const formatted = markdownToSlack(content);

        if (role === 'user') {
          // Skip messages that originated from Slack (already visible in channel)
          const contentKey = content.trim();
          if (slackSentMessages.has(contentKey)) {
            slackSentMessages.delete(contentKey);
            return;
          }

          // User message from terminal - post as the user (using their name/avatar)
          const chunks = chunkMessage(formatted);
          for (const chunk of chunks) {
            try {
              // Fetch user profile to get their name and avatar
              const userInfo = await app.client.users.info({ user: config.userId });
              const userName = userInfo.user?.real_name || userInfo.user?.name || 'User';
              const userIcon = userInfo.user?.profile?.image_72;

              await app.client.chat.postMessage({
                channel: channel.channelId,
                text: chunk,
                username: userName,
                icon_url: userIcon,
                mrkdwn: true,
              });
            } catch (err) {
              console.error('[Slack] Failed to post message:', err);
            }
          }
        } else {
          // Claude's response - post as "Claude Code"
          const chunks = chunkMessage(formatted);
          for (const chunk of chunks) {
            try {
              await app.client.chat.postMessage({
                channel: channel.channelId,
                text: chunk,
                username: 'Claude Code',
                icon_url: 'https://claude.ai/favicon.ico',
                mrkdwn: true,
              });
            } catch (err) {
              console.error('[Slack] Failed to post message:', err);
            }
          }
        }
      }
    },

    onTodos: async (sessionId, todos) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel && todos.length > 0) {
        const todosText = formatTodos(todos);
        try {
          await app.client.chat.postMessage({
            channel: channel.channelId,
            text: `*Tasks:*\n${todosText}`,
            mrkdwn: true,
          });
        } catch (err) {
          console.error('[Slack] Failed to post todos:', err);
        }
      }
    },
  });

  // Handle messages in session channels (user sending input to Claude)
  app.message(async ({ message, say }) => {
    // Type guard for regular messages
    if ('subtype' in message && message.subtype) return;
    if (!('text' in message) || !message.text) return;
    if (!('channel' in message) || !message.channel) return;

    // Ignore bot's own messages
    if ('bot_id' in message && message.bot_id) return;

    // Ignore thread replies (we want top-level messages only)
    if ('thread_ts' in message && message.thread_ts) return;

    const sessionId = channelManager.getSessionByChannel(message.channel);
    if (!sessionId) return; // Not a session channel

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await say(':warning: This session has ended.');
      return;
    }

    console.log(`[Slack] Sending input to session ${sessionId}: ${message.text.slice(0, 50)}...`);

    // Track this message so we don't re-post it when it comes back via JSONL
    slackSentMessages.add(message.text.trim());

    const sent = sessionManager.sendInput(sessionId, message.text);
    if (!sent) {
      slackSentMessages.delete(message.text.trim());
      await say(':warning: Failed to send input - session not connected.');
    }
  });

  // Slash command: /afk [sessions]
  app.command('/afk', async ({ command, ack, respond }) => {
    await ack();

    const subcommand = command.text.trim().split(' ')[0];

    if (subcommand === 'sessions' || !subcommand) {
      const active = channelManager.getAllActive();
      if (active.length === 0) {
        await respond('No active sessions. Start a session with `bun run dev run -- claude`');
        return;
      }

      const text = active
        .map((c) => `<#${c.channelId}> - ${formatSessionStatus(c.status)}`)
        .join('\n');

      await respond({
        text: `*Active Sessions:*\n${text}`,
        mrkdwn: true,
      });
    } else {
      await respond('Unknown command. Available: `/afk sessions`');
    }
  });

  // App Home tab
  app.event('app_home_opened', async ({ event, client }) => {
    const active = channelManager.getAllActive();

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'AFK Sessions', emoji: true },
      },
      { type: 'divider' },
    ];

    if (active.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '_No active sessions_\n\nStart a session with `bun run dev run -- claude`',
        },
      });
    } else {
      for (const c of active) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${c.sessionName}*\n${formatSessionStatus(c.status)}\n<#${c.channelId}>`,
          },
        });
      }
    }

    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: 'home',
          blocks,
        },
      });
    } catch (err) {
      console.error('[Slack] Failed to publish home view:', err);
    }
  });

  return { app, sessionManager, channelManager };
}
