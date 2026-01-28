import { App, LogLevel } from '@slack/bolt';
import { createReadStream } from 'fs';
import type { SlackConfig } from './types.js';
import { SessionManager, type SessionInfo, type ToolCallInfo, type ToolResultInfo } from './session-manager.js';
import { ChannelManager } from './channel-manager.js';
import {
  markdownToSlack,
  chunkMessage,
  formatSessionStatus,
  formatTodos,
} from './message-formatter.js';
import { extractImagePaths } from '../utils/image-extractor.js';

// Rate-limited message queue to avoid Slack API limits
class MessageQueue {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private minDelay = 350; // ms between messages (Slack allows ~1/sec but be safe)

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const fn = this.queue.shift();
      if (fn) {
        await fn();
        if (this.queue.length > 0) {
          await new Promise((r) => setTimeout(r, this.minDelay));
        }
      }
    }

    this.processing = false;
  }
}

export function createSlackApp(config: SlackConfig) {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const channelManager = new ChannelManager(app.client, config.userId);
  const messageQueue = new MessageQueue();

  // Track messages sent from Slack to avoid re-posting them when they come back via JSONL
  const slackSentMessages = new Set<string>();

  // Create session manager with event handlers that post to Slack
  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      const channel = await channelManager.createChannel(session.id, session.name, session.cwd);
      if (channel) {
        // Post initial message to channel
        await messageQueue.add(() =>
          app.client.chat.postMessage({
            channel: channel.channelId,
            text: `${formatSessionStatus(session.status)} *Session started*\n\`${session.cwd}\``,
            mrkdwn: true,
          })
        );
      }
    },

    onSessionEnd: async (sessionId) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateStatus(sessionId, 'ended');

        // Post final message
        await messageQueue.add(() =>
          app.client.chat.postMessage({
            channel: channel.channelId,
            text: ':stop_sign: *Session ended* - this channel will be archived',
          })
        );

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
        channelManager.updateStatus(sessionId, status);
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

              await messageQueue.add(() =>
                app.client.chat.postMessage({
                  channel: channel.channelId,
                  text: chunk,
                  username: userName,
                  icon_url: userIcon,
                  mrkdwn: true,
                })
              );
            } catch (err) {
              console.error('[Slack] Failed to post message:', err);
            }
          }
        } else {
          // Claude's response - post as "Claude Code"
          const chunks = chunkMessage(formatted);
          for (const chunk of chunks) {
            try {
              await messageQueue.add(() =>
                app.client.chat.postMessage({
                  channel: channel.channelId,
                  text: chunk,
                  username: 'Claude Code',
                  icon_url: 'https://claude.ai/favicon.ico',
                  mrkdwn: true,
                })
              );
            } catch (err) {
              console.error('[Slack] Failed to post message:', err);
            }
          }

          // Extract and upload any images mentioned in the response
          const session = sessionManager.getSession(sessionId);
          const images = extractImagePaths(content, session?.cwd);
          for (const image of images) {
            try {
              console.log(`[Slack] Uploading image: ${image.resolvedPath}`);
              await messageQueue.add(() =>
                app.client.files.uploadV2({
                  channel_id: channel.channelId,
                  file: createReadStream(image.resolvedPath),
                  filename: image.resolvedPath.split('/').pop() || 'image',
                  initial_comment: `📎 ${image.originalPath}`,
                })
              );
            } catch (err) {
              console.error('[Slack] Failed to upload image:', err);
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
          await messageQueue.add(() =>
            app.client.chat.postMessage({
              channel: channel.channelId,
              text: `*Tasks:*\n${todosText}`,
              mrkdwn: true,
            })
          );
        } catch (err) {
          console.error('[Slack] Failed to post todos:', err);
        }
      }
    },

    onToolCall: async (_sessionId, _tool) => {
      // Disabled for now to reduce message volume
    },

    onToolResult: async (_sessionId, _result) => {
      // Disabled for now to reduce message volume
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const channel = channelManager.getChannel(sessionId);
      if (!channel) return;

      const emoji = inPlanMode ? ':clipboard:' : ':hammer:';
      const status = inPlanMode ? 'Planning mode - Claude is designing a solution' : 'Execution mode - Claude is implementing';

      try {
        await messageQueue.add(() =>
          app.client.chat.postMessage({
            channel: channel.channelId,
            text: `${emoji} ${status}`,
            mrkdwn: true,
          })
        );
      } catch (err) {
        console.error('[Slack] Failed to post plan mode change:', err);
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

  // Slash command: /sessions
  app.command('/sessions', async ({ command, ack, respond }) => {
    await ack();

    const subcommand = command.text.trim().split(' ')[0];

    if (subcommand === 'sessions' || !subcommand) {
      const active = channelManager.getAllActive();
      if (active.length === 0) {
        await respond('No active sessions. Start a session with `afk-code run -- claude`');
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
      await respond('Unknown command. Try `/sessions`');
    }
  });

  // Slash command: /background - Send Ctrl+B to put Claude in background mode
  app.command('/background', async ({ command, ack, respond }) => {
    await ack();

    const sessionId = channelManager.getSessionByChannel(command.channel_id);
    if (!sessionId) {
      await respond(':warning: This channel is not associated with an active session.');
      return;
    }

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await respond(':warning: This session has ended.');
      return;
    }

    // Send Ctrl+B (ASCII 2)
    const sent = sessionManager.sendInput(sessionId, '\x02');
    if (sent) {
      await respond(':arrow_heading_down: Sent background command (Ctrl+B)');
    } else {
      await respond(':warning: Failed to send command - session not connected.');
    }
  });

  // Slash command: /interrupt - Send Escape to interrupt Claude
  app.command('/interrupt', async ({ command, ack, respond }) => {
    await ack();

    const sessionId = channelManager.getSessionByChannel(command.channel_id);
    if (!sessionId) {
      await respond(':warning: This channel is not associated with an active session.');
      return;
    }

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await respond(':warning: This session has ended.');
      return;
    }

    // Send Escape (ASCII 27)
    const sent = sessionManager.sendInput(sessionId, '\x1b');
    if (sent) {
      await respond(':stop_sign: Sent interrupt (Escape)');
    } else {
      await respond(':warning: Failed to send command - session not connected.');
    }
  });

  // Slash command: /mode - Send Shift+Tab to toggle mode
  app.command('/mode', async ({ command, ack, respond }) => {
    await ack();

    const sessionId = channelManager.getSessionByChannel(command.channel_id);
    if (!sessionId) {
      await respond(':warning: This channel is not associated with an active session.');
      return;
    }

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await respond(':warning: This session has ended.');
      return;
    }

    // Send Shift+Tab (ESC [ Z)
    const sent = sessionManager.sendInput(sessionId, '\x1b[Z');
    if (sent) {
      await respond(':arrows_counterclockwise: Sent mode toggle (Shift+Tab)');
    } else {
      await respond(':warning: Failed to send command - session not connected.');
    }
  });

  // Slash command: /compact - Send /compact to compact the conversation
  app.command('/compact', async ({ command, ack, respond }) => {
    await ack();

    const sessionId = channelManager.getSessionByChannel(command.channel_id);
    if (!sessionId) {
      await respond(':warning: This channel is not associated with an active session.');
      return;
    }

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await respond(':warning: This session has ended.');
      return;
    }

    const sent = sessionManager.sendInput(sessionId, '/compact\n');
    if (sent) {
      await respond(':compression: Sent /compact');
    } else {
      await respond(':warning: Failed to send command - session not connected.');
    }
  });

  // Slash command: /model - Switch Claude model
  app.command('/model', async ({ command, ack, respond }) => {
    await ack();

    const sessionId = channelManager.getSessionByChannel(command.channel_id);
    if (!sessionId) {
      await respond(':warning: This channel is not associated with an active session.');
      return;
    }

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await respond(':warning: This session has ended.');
      return;
    }

    const modelArg = command.text.trim();
    if (!modelArg) {
      await respond('Usage: `/model <opus|sonnet|haiku>`');
      return;
    }

    const sent = sessionManager.sendInput(sessionId, `/model ${modelArg}\n`);
    if (sent) {
      await respond(`:brain: Sent /model ${modelArg}`);
    } else {
      await respond(':warning: Failed to send command - session not connected.');
    }
  });

  // App Home tab
  app.event('app_home_opened', async ({ event, client }) => {
    const active = channelManager.getAllActive();

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'AFK Code Sessions', emoji: true },
      },
      { type: 'divider' },
    ];

    if (active.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '_No active sessions_\n\nStart a session with `afk-code run -- claude`',
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
