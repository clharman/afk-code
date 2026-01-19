import { Client, GatewayIntentBits, Events, ChannelType, AttachmentBuilder, REST, Routes, SlashCommandBuilder } from 'discord.js';
import type { DiscordConfig } from './types.js';
import { SessionManager, type SessionInfo, type ToolCallInfo, type ToolResultInfo } from '../slack/session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { markdownToSlack, chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';
import { extractImagePaths } from '../utils/image-extractor.js';

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

  // Track tool call messages for threading results
  const toolCallMessages = new Map<string, string>(); // toolUseId -> message id

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
        channelManager.updateStatus(sessionId, status);
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

            // Extract and upload any images mentioned in the response
            const session = sessionManager.getSession(sessionId);
            const images = extractImagePaths(content, session?.cwd);
            for (const image of images) {
              try {
                console.log(`[Discord] Uploading image: ${image.resolvedPath}`);
                const attachment = new AttachmentBuilder(image.resolvedPath);
                await discordChannel.send({
                  content: `📎 ${image.originalPath}`,
                  files: [attachment],
                });
              } catch (err) {
                console.error('[Discord] Failed to upload image:', err);
              }
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

    onToolCall: async (sessionId, tool) => {
      const channel = channelManager.getChannel(sessionId);
      if (!channel) return;

      // Format tool call summary
      let inputSummary = '';
      if (tool.name === 'Bash' && tool.input.command) {
        inputSummary = `\`${tool.input.command.slice(0, 100)}${tool.input.command.length > 100 ? '...' : ''}\``;
      } else if (tool.name === 'Read' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Edit' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Write' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Grep' && tool.input.pattern) {
        inputSummary = `\`${tool.input.pattern}\``;
      } else if (tool.name === 'Glob' && tool.input.pattern) {
        inputSummary = `\`${tool.input.pattern}\``;
      } else if (tool.name === 'Task' && tool.input.description) {
        inputSummary = tool.input.description;
      }

      const text = inputSummary
        ? `🔧 **${tool.name}**: ${inputSummary}`
        : `🔧 **${tool.name}**`;

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          const message = await discordChannel.send(text);
          // Store the message id for threading results
          toolCallMessages.set(tool.id, message.id);
        }
      } catch (err) {
        console.error('[Discord] Failed to post tool call:', err);
      }
    },

    onToolResult: async (sessionId, result) => {
      const channel = channelManager.getChannel(sessionId);
      if (!channel) return;

      const parentMessageId = toolCallMessages.get(result.toolUseId);
      if (!parentMessageId) return; // No parent message to reply to

      // Truncate long results
      const maxLen = 1800; // Discord has 2000 char limit
      let content = result.content;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + '\n... (truncated)';
      }

      const prefix = result.isError ? '❌ Error:' : '✅ Result:';
      const text = `${prefix}\n\`\`\`\n${content}\n\`\`\``;

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          // Fetch the parent message and create a thread
          const parentMessage = await discordChannel.messages.fetch(parentMessageId);
          if (parentMessage) {
            // Create a thread if one doesn't exist, or use existing
            let thread = parentMessage.thread;
            if (!thread) {
              thread = await parentMessage.startThread({
                name: 'Result',
                autoArchiveDuration: 60,
              });
            }
            await thread.send(text);
          }

          // Clean up the mapping
          toolCallMessages.delete(result.toolUseId);
        }
      } catch (err) {
        console.error('[Discord] Failed to post tool result:', err);
      }
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const channel = channelManager.getChannel(sessionId);
      if (!channel) return;

      const emoji = inPlanMode ? '📋' : '🔨';
      const status = inPlanMode ? 'Planning mode - Claude is designing a solution' : 'Execution mode - Claude is implementing';

      try {
        const discordChannel = await client.channels.fetch(channel.channelId);
        if (discordChannel?.type === ChannelType.GuildText) {
          await discordChannel.send(`${emoji} ${status}`);
        }
      } catch (err) {
        console.error('[Discord] Failed to post plan mode change:', err);
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

    // Register slash commands
    const commands = [
      new SlashCommandBuilder()
        .setName('background')
        .setDescription('Send Claude to background mode (Ctrl+B)'),
      new SlashCommandBuilder()
        .setName('interrupt')
        .setDescription('Interrupt Claude (Escape)'),
      new SlashCommandBuilder()
        .setName('mode')
        .setDescription('Toggle Claude mode (Shift+Tab)'),
      new SlashCommandBuilder()
        .setName('afk')
        .setDescription('List active Claude Code sessions'),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(config.botToken);
      await rest.put(Routes.applicationCommands(c.user.id), {
        body: commands.map((cmd) => cmd.toJSON()),
      });
      console.log('[Discord] Slash commands registered');
    } catch (err) {
      console.error('[Discord] Failed to register slash commands:', err);
    }
  });

  // Handle slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, channelId } = interaction;

    if (commandName === 'afk') {
      const active = channelManager.getAllActive();
      if (active.length === 0) {
        await interaction.reply('No active sessions. Start a session with `afk-code run -- claude`');
        return;
      }

      const text = active
        .map((c) => `<#${c.channelId}> - ${formatSessionStatus(c.status)}`)
        .join('\n');

      await interaction.reply(`**Active Sessions:**\n${text}`);
      return;
    }

    if (commandName === 'background' || commandName === 'interrupt' || commandName === 'mode') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      // Send the appropriate escape sequence
      let key: string;
      let message: string;
      if (commandName === 'background') {
        key = '\x02'; // Ctrl+B
        message = '⬇️ Sent background command (Ctrl+B)';
      } else if (commandName === 'interrupt') {
        key = '\x1b'; // Escape
        message = '🛑 Sent interrupt (Escape)';
      } else {
        key = '\x1b[Z'; // Shift+Tab
        message = '🔄 Sent mode toggle (Shift+Tab)';
      }

      const sent = sessionManager.sendInput(sessionId, key);
      if (sent) {
        await interaction.reply(message);
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }
  });

  return { client, sessionManager, channelManager };
}
