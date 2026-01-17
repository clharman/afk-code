/**
 * Session manager for Slack bot - handles JSONL watching and Unix socket communication
 * This replaces the need for the daemon + relay.
 */

import { watch, type FSWatcher } from 'fs';
import { readdir } from 'fs/promises';
import type { Socket } from 'bun';
import type { TodoItem } from '../types';

const DAEMON_SOCKET = '/tmp/afk-daemon.sock';

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  projectDir: string;
  status: 'running' | 'idle' | 'ended';
  startedAt: Date;
}

interface InternalSession extends SessionInfo {
  socket: Socket<unknown>;
  watcher?: FSWatcher;
  watchedFile?: string;
  seenMessages: Set<string>;
  slugFound: boolean;
  lastTodosHash: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface SessionEvents {
  onSessionStart: (session: SessionInfo) => void;
  onSessionEnd: (sessionId: string) => void;
  onSessionUpdate: (sessionId: string, name: string) => void;
  onSessionStatus: (sessionId: string, status: 'running' | 'idle' | 'ended') => void;
  onMessage: (sessionId: string, role: 'user' | 'assistant', content: string) => void;
  onTodos: (sessionId: string, todos: TodoItem[]) => void;
}

export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  private claimedFiles = new Set<string>();
  private events: SessionEvents;
  private server: ReturnType<typeof Bun.listen> | null = null;

  constructor(events: SessionEvents) {
    this.events = events;
  }

  async start(): Promise<void> {
    // Remove old socket file
    try {
      await Bun.$`rm -f ${DAEMON_SOCKET}`.quiet();
    } catch {}

    // Start Unix socket server
    this.server = Bun.listen({
      unix: DAEMON_SOCKET,
      socket: {
        data: (socket, data) => {
          const messages = data.toString().split('\n').filter(Boolean);
          for (const msg of messages) {
            try {
              const parsed = JSON.parse(msg);
              this.handleSessionMessage(socket, parsed);
            } catch (error) {
              console.error('[SessionManager] Error parsing message:', error);
            }
          }
        },
        error: (socket, error) => {
          console.error('[SessionManager] Socket error:', error);
        },
        close: (socket) => {
          // Find and cleanup session for this socket
          for (const [id, session] of this.sessions) {
            if (session.socket === socket) {
              console.log(`[SessionManager] Session disconnected: ${id}`);
              this.stopWatching(session);
              this.sessions.delete(id);
              this.events.onSessionEnd(id);
              break;
            }
          }
        },
      },
    });

    console.log(`[SessionManager] Listening on ${DAEMON_SOCKET}`);
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      this.stopWatching(session);
    }
    this.sessions.clear();
    // Note: Bun.listen doesn't have a close method, socket will close on process exit
  }

  sendInput(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[SessionManager] Session not found: ${sessionId}`);
      return false;
    }

    // Send text first, then Enter
    try {
      session.socket.write(JSON.stringify({ type: 'input', text }) + '\n');
    } catch (err) {
      console.error(`[SessionManager] Failed to send input to ${sessionId}:`, err);
      // Socket is dead, clean up
      this.stopWatching(session);
      this.sessions.delete(sessionId);
      this.events.onSessionEnd(sessionId);
      return false;
    }

    setTimeout(() => {
      try {
        session.socket.write(JSON.stringify({ type: 'input', text: '\r' }) + '\n');
      } catch {
        // Session likely already cleaned up from the first write failure
      }
    }, 50);

    return true;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      projectDir: session.projectDir,
      status: session.status,
      startedAt: session.startedAt,
    };
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      projectDir: s.projectDir,
      status: s.status,
      startedAt: s.startedAt,
    }));
  }

  private async handleSessionMessage(socket: Socket<unknown>, message: any): Promise<void> {
    switch (message.type) {
      case 'session_start': {
        const session: InternalSession = {
          id: message.id,
          name: message.name || message.command?.join(' ') || 'Session',
          cwd: message.cwd,
          projectDir: message.projectDir,
          socket,
          status: 'running',
          seenMessages: new Set(),
          startedAt: new Date(),
          slugFound: false,
          lastTodosHash: '',
        };

        this.sessions.set(message.id, session);
        console.log(`[SessionManager] Session started: ${message.id} - ${session.name}`);

        this.events.onSessionStart({
          id: session.id,
          name: session.name,
          cwd: session.cwd,
          projectDir: session.projectDir,
          status: session.status,
          startedAt: session.startedAt,
        });

        this.startWatching(session);
        break;
      }

      case 'session_end': {
        const session = this.sessions.get(message.sessionId);
        if (session) {
          console.log(`[SessionManager] Session ended: ${message.sessionId}`);
          this.stopWatching(session);
          this.sessions.delete(message.sessionId);
          this.events.onSessionEnd(message.sessionId);
        }
        break;
      }
    }
  }

  private async findActiveJsonlFile(
    projectDir: string
  ): Promise<string | null> {
    try {
      const files = await readdir(projectDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'));

      const allPaths = jsonlFiles
        .map((f) => `${projectDir}/${f}`)
        .filter((path) => !this.claimedFiles.has(path));

      if (allPaths.length === 0) return null;
      if (allPaths.length === 1) return allPaths[0];

      // Always return most recently modified file
      // This handles continued sessions where messages go to the original file
      const fileStats = await Promise.all(
        allPaths.map(async (path) => {
          const stat = await Bun.file(path).stat();
          return { path, mtime: stat?.mtime || 0 };
        })
      );
      fileStats.sort((a, b) => (b.mtime as number) - (a.mtime as number));
      return fileStats[0]?.path || null;
    } catch {
      return null;
    }
  }

  private async processJsonlUpdates(session: InternalSession): Promise<void> {
    if (!session.watchedFile) return;

    try {
      const file = Bun.file(session.watchedFile);
      const content = await file.text();
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        const lineHash = Bun.hash(line).toString();
        if (session.seenMessages.has(lineHash)) continue;
        session.seenMessages.add(lineHash);

        // Extract session name (slug)
        if (!session.slugFound) {
          const slug = this.extractSlug(line);
          if (slug) {
            session.slugFound = true;
            session.name = slug;
            console.log(`[SessionManager] Session ${session.id} name: ${slug}`);
            this.events.onSessionUpdate(session.id, slug);
          }
        }

        // Extract todos
        const todos = this.extractTodos(line);
        if (todos) {
          const todosHash = Bun.hash(JSON.stringify(todos)).toString();
          if (todosHash !== session.lastTodosHash) {
            session.lastTodosHash = todosHash;
            this.events.onTodos(session.id, todos);
          }
        }

        // Check for response completion
        if (this.isStopHookSummary(line)) {
          if (session.status !== 'idle') {
            session.status = 'idle';
            this.events.onSessionStatus(session.id, 'idle');
          }
          continue;
        }

        // Parse message
        const parsed = this.parseJsonlLine(line);
        if (parsed) {
          const messageTime = new Date(parsed.timestamp);
          if (messageTime < session.startedAt) continue;

          this.events.onMessage(session.id, parsed.role, parsed.content);

          if (parsed.role === 'user' && session.status !== 'running') {
            session.status = 'running';
            this.events.onSessionStatus(session.id, 'running');
          }
        }
      }
    } catch (err) {
      console.error('[SessionManager] Error processing JSONL:', err);
    }
  }

  private async startWatching(session: InternalSession): Promise<void> {
    const jsonlFile = await this.findActiveJsonlFile(session.projectDir);

    if (jsonlFile) {
      session.watchedFile = jsonlFile;
      this.claimedFiles.add(jsonlFile);
      console.log(`[SessionManager] Watching: ${jsonlFile}`);
      await this.processJsonlUpdates(session);
    } else {
      console.log(`[SessionManager] Waiting for JSONL in ${session.projectDir}`);
    }

    // Watch directory for changes
    try {
      session.watcher = watch(session.projectDir, { recursive: false }, async (_, filename) => {
        if (!filename?.endsWith('.jsonl')) return;

        if (!session.watchedFile) {
          const newFile = await this.findActiveJsonlFile(session.projectDir);
          if (newFile) {
            session.watchedFile = newFile;
            this.claimedFiles.add(newFile);
            console.log(`[SessionManager] Found JSONL: ${newFile}`);
          }
        }

        const filePath = `${session.projectDir}/${filename}`;
        if (session.watchedFile && filePath === session.watchedFile) {
          await this.processJsonlUpdates(session);
        }
      });
    } catch (err) {
      console.error('[SessionManager] Error setting up watcher:', err);
    }

    // Poll as backup
    const pollInterval = setInterval(async () => {
      if (!this.sessions.has(session.id)) {
        clearInterval(pollInterval);
        return;
      }

      if (!session.watchedFile) {
        const newFile = await this.findActiveJsonlFile(session.projectDir);
        if (newFile) {
          session.watchedFile = newFile;
          this.claimedFiles.add(newFile);
        }
      }

      if (session.watchedFile) {
        await this.processJsonlUpdates(session);
      }
    }, 1000);
  }

  private stopWatching(session: InternalSession): void {
    if (session.watcher) {
      session.watcher.close();
    }
    if (session.watchedFile) {
      this.claimedFiles.delete(session.watchedFile);
    }
  }

  private isStopHookSummary(line: string): boolean {
    try {
      const data = JSON.parse(line);
      return data.type === 'system' && data.subtype === 'stop_hook_summary';
    } catch {
      return false;
    }
  }

  private extractSlug(line: string): string | null {
    try {
      const data = JSON.parse(line);
      if (data.slug && typeof data.slug === 'string') {
        return data.slug;
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractTodos(line: string): TodoItem[] | null {
    try {
      const data = JSON.parse(line);
      if (data.todos && Array.isArray(data.todos) && data.todos.length > 0) {
        return data.todos.map((t: any) => ({
          content: t.content || '',
          status: t.status || 'pending',
          activeForm: t.activeForm,
        }));
      }
      return null;
    } catch {
      return null;
    }
  }

  private parseJsonlLine(line: string): ChatMessage | null {
    try {
      const data = JSON.parse(line);

      if (data.type !== 'user' && data.type !== 'assistant') return null;
      if (data.isMeta || data.subtype) return null;

      const message = data.message;
      if (!message || !message.role) return null;

      let content = '';
      if (typeof message.content === 'string') {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            content += block.text;
          }
        }
      }

      if (!content.trim()) return null;

      return {
        role: message.role as 'user' | 'assistant',
        content: content.trim(),
        timestamp: data.timestamp || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}
