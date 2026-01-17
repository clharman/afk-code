import type { WebClient } from '@slack/web-api';

export interface ChannelMapping {
  sessionId: string;
  channelId: string;
  channelName: string;
  sessionName: string;
  status: 'running' | 'idle' | 'ended';
  createdAt: Date;
}

/**
 * Sanitize a string for use as a Slack channel name.
 * Rules: lowercase, no spaces, max 80 chars, only letters/numbers/hyphens/underscores
 */
function sanitizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]/g, '') // Remove invalid chars
    .replace(/\s+/g, '-') // Spaces to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim hyphens from ends
    .slice(0, 70); // Leave room for "afk-" prefix and uniqueness suffix
}

export class ChannelManager {
  private channels = new Map<string, ChannelMapping>();
  private channelToSession = new Map<string, string>();
  private client: WebClient;
  private userId: string;

  constructor(client: WebClient, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  async createChannel(
    sessionId: string,
    sessionName: string,
    cwd: string
  ): Promise<ChannelMapping | null> {
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
    let result;

    while (true) {
      // Ensure max 80 chars
      const nameToTry = channelName.length > 80 ? channelName.slice(0, 80) : channelName;

      try {
        result = await this.client.conversations.create({
          name: nameToTry,
          is_private: true,
        });
        channelName = nameToTry;
        break; // Success!
      } catch (err: any) {
        if (err.data?.error === 'name_taken') {
          // Try next number
          suffix++;
          channelName = `${baseName}-${suffix}`;
        } else {
          throw err; // Different error, rethrow
        }
      }
    }

    if (!result?.channel?.id) {
      console.error('[ChannelManager] Failed to create channel - no ID returned');
      return null;
    }

    const mapping: ChannelMapping = {
      sessionId,
      channelId: result.channel.id,
      channelName,
      sessionName,
      status: 'running',
      createdAt: new Date(),
    };

    this.channels.set(sessionId, mapping);
    this.channelToSession.set(result.channel.id, sessionId);

    // Set channel topic
    try {
      await this.client.conversations.setTopic({
        channel: result.channel.id,
        topic: `Claude Code session: ${sessionName}`,
      });
    } catch (err: any) {
      console.error('[ChannelManager] Failed to set topic:', err.message);
    }

    // Invite user to channel
    if (this.userId) {
      try {
        await this.client.conversations.invite({
          channel: result.channel.id,
          users: this.userId,
        });
        console.log(`[ChannelManager] Invited user to channel`);
      } catch (err: any) {
        // Ignore "already_in_channel" error
        if (err.data?.error !== 'already_in_channel') {
          console.error('[ChannelManager] Failed to invite user:', err.message);
        }
      }
    }

    console.log(`[ChannelManager] Created channel #${channelName} for session ${sessionId}`);
    return mapping;
  }

  async archiveChannel(sessionId: string): Promise<boolean> {
    const mapping = this.channels.get(sessionId);
    if (!mapping) return false;

    try {
      // Rename channel before archiving to free up the name for reuse
      const timestamp = Date.now().toString(36);
      const archivedName = `${mapping.channelName}-archived-${timestamp}`.slice(0, 80);

      await this.client.conversations.rename({
        channel: mapping.channelId,
        name: archivedName,
      });

      await this.client.conversations.archive({
        channel: mapping.channelId,
      });
      console.log(`[ChannelManager] Archived channel #${mapping.channelName}`);
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
