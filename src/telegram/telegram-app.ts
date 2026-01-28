import { Bot, Context } from 'grammy';
import type { TelegramConfig } from './types.js';
import { SessionManager, type SessionInfo } from '../slack/session-manager.js';
import { chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';

// Telegram has a 4096 character limit per message
const MAX_MESSAGE_LENGTH = 4000;

interface SessionTracking {
  sessionId: string;
  sessionName: string;
  lastActivity: Date;
}

export function createTelegramApp(config: TelegramConfig) {
  const bot = new Bot(config.botToken);

  const activeSessions = new Map<string, SessionTracking>();
  const telegramSentMessages = new Set<string>();
  let currentSessionId: string | null = null; // Explicitly selected session

  // Message queue for rate limiting (Telegram allows ~30 msg/sec but be conservative)
  const messageQueue: Array<() => Promise<void>> = [];
  let processingQueue = false;

  async function processQueue() {
    if (processingQueue) return;
    processingQueue = true;

    while (messageQueue.length > 0) {
      const fn = messageQueue.shift();
      if (fn) {
        try {
          await fn();
        } catch (err) {
          console.error('[Telegram] Error sending message:', err);
        }
        if (messageQueue.length > 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    processingQueue = false;
  }

  async function sendMessage(text: string, parseMode: 'Markdown' | 'HTML' | undefined = 'Markdown') {
    messageQueue.push(async () => {
      try {
        await bot.api.sendMessage(config.chatId, text, { parse_mode: parseMode });
      } catch (err: any) {
        // If markdown fails, try without formatting
        if (parseMode && err.message?.includes('parse')) {
          await bot.api.sendMessage(config.chatId, text);
        } else {
          throw err;
        }
      }
    });
    processQueue();
  }

  async function sendChunkedMessage(text: string, prefix?: string) {
    const chunks = chunkMessage(text, MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = prefix && i === 0 ? `${prefix}\n\n${chunks[i]}` : chunks[i];
      await sendMessage(chunk);
    }
  }

  // Create session manager with Telegram event handlers
  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      activeSessions.set(session.id, {
        sessionId: session.id,
        sessionName: session.name,
        lastActivity: new Date(),
      });

      await sendMessage(
        `*[${session.name}]* ${formatSessionStatus(session.status)}\n` +
          `Session started\n` +
          `\`${session.cwd}\``
      );
    },

    onSessionEnd: async (sessionId) => {
      const tracking = activeSessions.get(sessionId);
      const name = tracking?.sessionName || sessionId;

      activeSessions.delete(sessionId);

      await sendMessage(`*[${name}]* Session ended`);
    },

    onSessionUpdate: async (sessionId, name) => {
      const tracking = activeSessions.get(sessionId);
      if (tracking) {
        tracking.sessionName = name;
        tracking.lastActivity = new Date();
      }
    },

    onSessionStatus: async (sessionId, _status) => {
      const tracking = activeSessions.get(sessionId);
      if (tracking) {
        tracking.lastActivity = new Date();
      }
    },

    onMessage: async (sessionId, role, content) => {
      const tracking = activeSessions.get(sessionId);
      if (!tracking) return;

      tracking.lastActivity = new Date();

      if (role === 'user') {
        const contentKey = content.trim();
        if (telegramSentMessages.has(contentKey)) {
          telegramSentMessages.delete(contentKey);
          return;
        }
        await sendChunkedMessage(content, `*[${tracking.sessionName}]* *User:*`);
      } else {
        await sendChunkedMessage(content, `*[${tracking.sessionName}]* *Claude:*`);
      }
    },

    onTodos: async (sessionId, todos) => {
      const tracking = activeSessions.get(sessionId);
      if (!tracking || todos.length === 0) return;

      const todosText = formatTodos(todos);
      await sendMessage(`*[${tracking.sessionName}]* *Tasks:*\n${todosText}`);
    },

    onToolCall: async (_sessionId, _tool) => {
      // Disabled to reduce message volume
    },

    onToolResult: async (_sessionId, _result) => {
      // Disabled to reduce message volume
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const tracking = activeSessions.get(sessionId);
      if (!tracking) return;

      const status = inPlanMode
        ? 'Planning mode - Claude is designing a solution'
        : 'Execution mode - Claude is implementing';

      await sendMessage(`*[${tracking.sessionName}]* ${status}`);
    },
  });

  function getCurrentSession(): SessionTracking | null {
    // If explicit session selected, use it
    if (currentSessionId) {
      const session = activeSessions.get(currentSessionId);
      if (session) return session;
      // Session ended, clear selection
      currentSessionId = null;
    }

    // Auto-select if only one session
    if (activeSessions.size === 1) {
      return activeSessions.values().next().value;
    }

    return null;
  }

  function getSessionByName(name: string): SessionTracking | null {
    const nameLower = name.toLowerCase();
    for (const tracking of activeSessions.values()) {
      if (tracking.sessionName.toLowerCase().startsWith(nameLower)) {
        return tracking;
      }
    }
    return null;
  }

  function getMostRecentSession(): SessionTracking | null {
    let mostRecent: SessionTracking | null = null;
    for (const tracking of activeSessions.values()) {
      if (!mostRecent || tracking.lastActivity > mostRecent.lastActivity) {
        mostRecent = tracking;
      }
    }
    return mostRecent;
  }

  // Handle incoming messages
  bot.on('message:text', async (ctx) => {
    // Only respond to messages from the configured chat
    if (ctx.chat.id.toString() !== config.chatId) return;

    const text = ctx.message.text;

    // Handle commands
    if (text.startsWith('/')) {
      await handleCommand(ctx, text.trim());
      return;
    }

    // Get current session
    const current = getCurrentSession();

    if (!current) {
      if (activeSessions.size === 0) {
        await ctx.reply('No active sessions. Start one with:\n`afk-code run -- claude`', { parse_mode: 'Markdown' });
      } else {
        // Multiple sessions, need to select one
        const list = Array.from(activeSessions.values())
          .map((s) => `• \`${s.sessionName}\``)
          .join('\n');
        await ctx.reply(
          `Multiple sessions active. Select one first:\n\n${list}\n\nUse: \`/switch <name>\``,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    telegramSentMessages.add(text.trim());

    const sent = sessionManager.sendInput(current.sessionId, text);
    if (!sent) {
      telegramSentMessages.delete(text.trim());
      await ctx.reply('Failed to send input - session not connected.');
    }
  });

  async function handleCommand(ctx: Context, text: string) {
    const [command, ...args] = text.split(' ');
    const sessionArg = args[0];

    let targetSession: SessionTracking | null = null;
    if (sessionArg && !sessionArg.startsWith('/')) {
      for (const tracking of activeSessions.values()) {
        if (tracking.sessionName.toLowerCase().startsWith(sessionArg.toLowerCase())) {
          targetSession = tracking;
          break;
        }
      }
    }
    if (!targetSession) {
      targetSession = getMostRecentSession();
    }

    switch (command.toLowerCase()) {
      case '/start': {
        await ctx.reply(
          `*AFK Code Telegram Bot*\n\n` +
            `This bot lets you monitor and interact with Claude Code sessions.\n\n` +
            `Start a session with:\n` +
            `\`afk-code run -- claude\`\n\n` +
            `Type /help for available commands.`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case '/sessions': {
        if (activeSessions.size === 0) {
          await ctx.reply('No active sessions. Start one with `afk-code run -- claude`');
          return;
        }

        const current = getCurrentSession();
        const list = Array.from(activeSessions.values())
          .map((s) => {
            const isCurrent = current && s.sessionId === current.sessionId;
            return isCurrent ? `• *${s.sessionName}* ← current` : `• ${s.sessionName}`;
          })
          .join('\n');

        await ctx.reply(`*Active Sessions:*\n${list}\n\nUse \`/switch <name>\` to change`, { parse_mode: 'Markdown' });
        break;
      }

      case '/switch':
      case '/select': {
        if (!sessionArg) {
          if (activeSessions.size === 0) {
            await ctx.reply('No active sessions.');
            return;
          }
          const current = getCurrentSession();
          const list = Array.from(activeSessions.values())
            .map((s) => {
              const isCurrent = current && s.sessionId === current.sessionId;
              return isCurrent ? `• *${s.sessionName}* ← current` : `• ${s.sessionName}`;
            })
            .join('\n');
          await ctx.reply(`*Sessions:*\n${list}\n\nUse: \`/switch <name>\``, { parse_mode: 'Markdown' });
          return;
        }
        const session = getSessionByName(sessionArg);
        if (session) {
          currentSessionId = session.sessionId;
          await ctx.reply(`Switched to: *${session.sessionName}*`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`Session not found: ${sessionArg}`);
        }
        break;
      }

      case '/background':
      case '/bg': {
        if (!targetSession) {
          await ctx.reply('No active session.');
          return;
        }
        const sent = sessionManager.sendInput(targetSession.sessionId, '\x02');
        await ctx.reply(sent ? 'Sent background command (Ctrl+B)' : 'Failed - session not connected.');
        break;
      }

      case '/interrupt':
      case '/stop': {
        if (!targetSession) {
          await ctx.reply('No active session.');
          return;
        }
        const sent = sessionManager.sendInput(targetSession.sessionId, '\x1b');
        await ctx.reply(sent ? 'Sent interrupt (Escape)' : 'Failed - session not connected.');
        break;
      }

      case '/mode': {
        if (!targetSession) {
          await ctx.reply('No active session.');
          return;
        }
        const sent = sessionManager.sendInput(targetSession.sessionId, '\x1b[Z');
        await ctx.reply(sent ? 'Sent mode toggle (Shift+Tab)' : 'Failed - session not connected.');
        break;
      }

      case '/compact': {
        if (!targetSession) {
          await ctx.reply('No active session.');
          return;
        }
        const sent = sessionManager.sendInput(targetSession.sessionId, '/compact\n');
        await ctx.reply(sent ? 'Sent /compact' : 'Failed - session not connected.');
        break;
      }

      case '/model': {
        if (!targetSession) {
          await ctx.reply('No active session.');
          return;
        }
        const modelArg = args.slice(targetSession === getSessionByName(args[0] || '') ? 1 : 0).join(' ');
        if (!modelArg) {
          await ctx.reply('Usage: `/model <opus|sonnet|haiku>`', { parse_mode: 'Markdown' });
          return;
        }
        const sent = sessionManager.sendInput(targetSession.sessionId, `/model ${modelArg}\n`);
        await ctx.reply(sent ? `Sent /model ${modelArg}` : 'Failed - session not connected.');
        break;
      }

      case '/help': {
        await ctx.reply(
          `*AFK Code Commands:*\n\n` +
            `/sessions - List active sessions\n` +
            `/switch <name> - Switch to a session\n` +
            `/model <name> - Switch model\n` +
            `/compact - Compact conversation\n` +
            `/background - Send Ctrl+B\n` +
            `/interrupt - Send Escape\n` +
            `/mode - Toggle mode (Shift+Tab)\n` +
            `/help - Show this message\n\n` +
            `_Messages go to the current session (auto-selected if only one)._`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      default:
        // Ignore unknown commands
        break;
    }
  }

  return { bot, sessionManager };
}
