import type { Client, TextChannel, CategoryChannel, Guild } from 'discord.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

export interface ChannelMapping {
  sessionId: string;
  channelId: string;
  channelName: string;
  sessionName: string;
  status: 'running' | 'idle' | 'ended';
  createdAt: Date;
}

/**
 * Sanitize a string for use as a Discord channel name.
 * Rules: lowercase, no spaces, max 100 chars, only letters/numbers/hyphens/underscores
 */
function sanitizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]/g, '') // Remove invalid chars
    .replace(/\s+/g, '-') // Spaces to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim hyphens from ends
    .slice(0, 90); // Leave room for "afk-" prefix and uniqueness suffix
}

export class ChannelManager {
  private channels = new Map<string, ChannelMapping>();
  private channelToSession = new Map<string, string>();
  private client: Client;
  private userId: string;
  private guild: Guild | null = null;
  private category: CategoryChannel | null = null;

  constructor(client: Client, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  async initialize(): Promise<void> {
    // Find the first guild the bot is in
    const guilds = await this.client.guilds.fetch();
    if (guilds.size === 0) {
      throw new Error('Bot is not in any servers. Please invite the bot first.');
    }

    const guildId = guilds.first()!.id;
    this.guild = await this.client.guilds.fetch(guildId);

    // Find or create AFK category
    const existingCategory = this.guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === 'afk sessions'
    ) as CategoryChannel | undefined;

    if (existingCategory) {
      this.category = existingCategory;
    } else {
      this.category = await this.guild.channels.create({
        name: 'AFK Sessions',
        type: ChannelType.GuildCategory,
      });
    }

    console.log(`[ChannelManager] Using guild: ${this.guild.name}`);
    console.log(`[ChannelManager] Using category: ${this.category.name}`);
  }

  async createChannel(
    sessionId: string,
    sessionName: string,
    cwd: string
  ): Promise<ChannelMapping | null> {
    if (!this.guild || !this.category) {
      console.error('[ChannelManager] Not initialized');
      return null;
    }

    // Check if channel already exists for this session
    if (this.channels.has(sessionId)) {
      return this.channels.get(sessionId)!;
    }

    // Extract just the folder name from the path
    const folderName = cwd.split('/').filter(Boolean).pop() || 'session';
    const baseName = `afk-${sanitizeChannelName(folderName)}`;

    // Try to create channel, incrementing suffix if name is taken
    let channelName = baseName;
    let suffix = 1;
    let channel: TextChannel | null = null;

    while (true) {
      const nameToTry = channelName.length > 100 ? channelName.slice(0, 100) : channelName;

      // Check if name exists
      const existing = this.guild.channels.cache.find(
        (ch) => ch.name === nameToTry && ch.parentId === this.category!.id
      );

      if (!existing) {
        try {
          channel = await this.guild.channels.create({
            name: nameToTry,
            type: ChannelType.GuildText,
            parent: this.category,
            topic: `Claude Code session: ${sessionName}`,
          });
          channelName = nameToTry;
          break;
        } catch (err: any) {
          console.error('[ChannelManager] Failed to create channel:', err.message);
          return null;
        }
      } else {
        suffix++;
        channelName = `${baseName}-${suffix}`;
      }
    }

    if (!channel) {
      return null;
    }

    const mapping: ChannelMapping = {
      sessionId,
      channelId: channel.id,
      channelName,
      sessionName,
      status: 'running',
      createdAt: new Date(),
    };

    this.channels.set(sessionId, mapping);
    this.channelToSession.set(channel.id, sessionId);

    console.log(`[ChannelManager] Created channel #${channelName} for session ${sessionId}`);
    return mapping;
  }

  async archiveChannel(sessionId: string): Promise<boolean> {
    if (!this.guild) return false;

    const mapping = this.channels.get(sessionId);
    if (!mapping) return false;

    try {
      const channel = await this.guild.channels.fetch(mapping.channelId);
      if (channel && channel.type === ChannelType.GuildText) {
        // Rename with archived suffix
        const timestamp = Date.now().toString(36);
        const archivedName = `${mapping.channelName}-archived-${timestamp}`.slice(0, 100);

        await channel.setName(archivedName);

        // Move out of category or delete (Discord doesn't have archive)
        // For now, just rename to indicate it's archived
        console.log(`[ChannelManager] Archived channel #${mapping.channelName}`);
      }
      return true;
    } catch (err: any) {
      console.error('[ChannelManager] Failed to archive channel:', err.message);
      return false;
    }
  }

  getChannel(sessionId: string): ChannelMapping | undefined {
    return this.channels.get(sessionId);
  }

  getSessionByChannel(channelId: string): string | undefined {
    return this.channelToSession.get(channelId);
  }

  updateStatus(sessionId: string, status: 'running' | 'idle' | 'ended'): void {
    const mapping = this.channels.get(sessionId);
    if (mapping) {
      mapping.status = status;
    }
  }

  updateName(sessionId: string, name: string): void {
    const mapping = this.channels.get(sessionId);
    if (mapping) {
      mapping.sessionName = name;
    }
  }

  getAllActive(): ChannelMapping[] {
    return Array.from(this.channels.values()).filter((c) => c.status !== 'ended');
  }
}
