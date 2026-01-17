import { Client, GatewayIntentBits, Events, ChannelType } from 'discord.js';
import type { DiscordConfig } from './types';
import { SessionManager, type SessionInfo } from '../slack/session-manager';
import { ChannelManager } from './channel-manager';
import { markdownToSlack, chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter';

export function createDiscordApp(config: DiscordConfig) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelManager = new ChannelManager(client, config.userId);

  // Track messages sent from Discord to avoid re-posting
  const discordSentMessages = new Set<string>();

  // Create session manager with event handlers that post to Discord
  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      const channel = await channelManager.createChannel(session.id, session.name, session.cwd);
      if (channel) {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send(
            `${formatSessionStatus(session.status)} **Session started**\n\`${session.cwd}\``
          );
        }
      }
    },

    onSessionEnd: async (sessionId) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateStatus(sessionId, 'ended');

        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send('🛑 **Session ended** - this channel will be archived');
        }

        await channelManager.archiveChannel(sessionId);
      }
    },

    onSessionUpdate: async (sessionId, name) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        channelManager.updateName(sessionId, name);
        // Update channel topic
        try {
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.setTopic(`Claude Code session: ${name}`);
          }
        } catch (err) {
          console.error('[Discord] Failed to update channel topic:', err);
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
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send(`<@${config.userId}> Session is waiting for input`);
          }
        }
      }
    },

    onMessage: async (sessionId, role, content) => {
      const channel = channelManager.getChannel(sessionId);
      if (channel) {
        // Discord markdown is similar to Slack's mrkdwn but uses standard markdown
        const formatted = content; // Discord uses standard markdown

        if (role === 'user') {
          // Skip messages that originated from Discord
          const contentKey = content.trim();
          if (discordSentMessages.has(contentKey)) {
            discordSentMessages.delete(contentKey);
            return;
          }

          // User message from terminal
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            const chunks = chunkMessage(formatted);
            for (const chunk of chunks) {
              await discordChannel.send(`**User:** ${chunk}`);
            }
          }
        } else {
          // Claude's response
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            const chunks = chunkMessage(formatted);
            for (const chunk of chunks) {
              await discordChannel.send(chunk);
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
          const discordChannel = await client.channels.fetch(channel.channelId);
          if (discordChannel?.type === ChannelType.GuildText) {
            await discordChannel.send(`**Tasks:**\n${todosText}`);
          }
        } catch (err) {
          console.error('[Discord] Failed to post todos:', err);
        }
      }
    },
  });

  // Handle messages in session channels (user sending input to Claude)
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot's own messages
    if (message.author.bot) return;

    // Ignore DMs
    if (!message.guild) return;

    const sessionId = channelManager.getSessionByChannel(message.channelId);
    if (!sessionId) return; // Not a session channel

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await message.reply('⚠️ This session has ended.');
      return;
    }

    console.log(`[Discord] Sending input to session ${sessionId}: ${message.content.slice(0, 50)}...`);

    // Track this message so we don't re-post it
    discordSentMessages.add(message.content.trim());

    const sent = sessionManager.sendInput(sessionId, message.content);
    if (!sent) {
      discordSentMessages.delete(message.content.trim());
      await message.reply('⚠️ Failed to send input - session not connected.');
    }
  });

  // When bot is ready
  client.once(Events.ClientReady, async (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);
    await channelManager.initialize();
  });

  return { client, sessionManager, channelManager };
}
