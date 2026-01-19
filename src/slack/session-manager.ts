/**
 * Session manager for Slack bot - handles JSONL watching and Unix socket communication
 * This replaces the need for the daemon + relay.
 */

import { watch, type FSWatcher } from 'fs';
import { readdir, readFile, stat, unlink } from 'fs/promises';
import { createServer, type Server, type Socket } from 'net';
import { createHash } from 'crypto';
import type { TodoItem } from '../types.js';

const DAEMON_SOCKET = '/tmp/afk-code-daemon.sock';

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  projectDir: string;
  status: 'running' | 'idle' | 'ended';
  startedAt: Date;
}

interface InternalSession extends SessionInfo {
  socket: Socket;
  watcher?: FSWatcher;
  watchedFile?: string;
  seenMessages: Set<string>;
  slugFound: boolean;
  lastTodosHash: string;
  inPlanMode: boolean;
  initialFileStats: Map<string, number>; // path -> mtime at session start
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: any;
}

export interface ToolResultInfo {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface SessionEvents {
  onSessionStart: (session: SessionInfo) => void;
  onSessionEnd: (sessionId: string) => void;
  onSessionUpdate: (sessionId: string, name: string) => void;
  onSessionStatus: (sessionId: string, status: 'running' | 'idle' | 'ended') => void;
  onMessage: (sessionId: string, role: 'user' | 'assistant', content: string) => void;
  onTodos: (sessionId: string, todos: TodoItem[]) => void;
  onToolCall: (sessionId: string, tool: ToolCallInfo) => void;
  onToolResult: (sessionId: string, result: ToolResultInfo) => void;
  onPlanModeChange: (sessionId: string, inPlanMode: boolean) => void;
}

function hash(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  private claimedFiles = new Set<string>();
  private events: SessionEvents;
  private server: Server | null = null;

  constructor(events: SessionEvents) {
    this.events = events;
  }

  async start(): Promise<void> {
    // Remove old socket file
    try {
      await unlink(DAEMON_SOCKET);
    } catch {}

    // Start Unix socket server
    this.server = createServer((socket) => {
      let messageBuffer = '';

      socket.on('data', (data) => {
        messageBuffer += data.toString();
        const lines = messageBuffer.split('\n');
        messageBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            this.handleSessionMessage(socket, parsed);
          } catch (error) {
            console.error('[SessionManager] Error parsing message:', error);
          }
        }
      });

      socket.on('error', (error) => {
        console.error('[SessionManager] Socket error:', error);
      });

      socket.on('close', () => {
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
      });
    });

    this.server.listen(DAEMON_SOCKET, () => {
      console.log(`[SessionManager] Listening on ${DAEMON_SOCKET}`);
    });
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      this.stopWatching(session);
    }
    this.sessions.clear();
    if (this.server) {
      this.server.close();
    }
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

  private async handleSessionMessage(socket: Socket, message: any): Promise<void> {
    switch (message.type) {
      case 'session_start': {
        // Snapshot existing JSONL files before creating session
        const initialFileStats = await this.snapshotJsonlFiles(message.projectDir);

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
          inPlanMode: false,
          initialFileStats,
        };

        this.sessions.set(message.id, session);
        console.log(`[SessionManager] Session started: ${message.id} - ${session.name}`);
        console.log(`[SessionManager] Snapshot: ${initialFileStats.size} existing JSONL files`);

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

  private async snapshotJsonlFiles(projectDir: string): Promise<Map<string, number>> {
    const stats = new Map<string, number>();
    try {
      const files = await readdir(projectDir);
      for (const f of files) {
        if (f.endsWith('.jsonl') && !f.startsWith('agent-')) {
          const path = `${projectDir}/${f}`;
          const fileStat = await stat(path);
          stats.set(path, fileStat.mtimeMs);
        }
      }
    } catch {
      // Directory might not exist yet
    }
    return stats;
  }

  private async hasConversationMessages(path: string): Promise<boolean> {
    try {
      const content = await readFile(path, 'utf-8');
      // Check if file contains actual conversation messages (not just metadata)
      return content.includes('"type":"user"') || content.includes('"type":"assistant"');
    } catch {
      return false;
    }
  }

  private async findActiveJsonlFile(session: InternalSession): Promise<string | null> {
    try {
      const files = await readdir(session.projectDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'));

      const allPaths = jsonlFiles
        .map((f) => `${session.projectDir}/${f}`)
        .filter((path) => !this.claimedFiles.has(path));

      if (allPaths.length === 0) return null;

      // Get current file stats
      const fileStats = await Promise.all(
        allPaths.map(async (path) => {
          const fileStat = await stat(path);
          return { path, mtime: fileStat.mtimeMs };
        })
      );

      // Sort by mtime descending - prefer most recently modified
      fileStats.sort((a, b) => b.mtime - a.mtime);

      // Look for files that are either:
      // 1. Modified since our snapshot (for --continue case) - check first!
      // 2. New (didn't exist in our snapshot)
      // Only consider files with actual conversation messages
      for (const { path, mtime } of fileStats) {
        const initialMtime = session.initialFileStats.get(path);

        if (initialMtime !== undefined && mtime > initialMtime) {
          // Existing file that was modified after session start (--continue case)
          if (await this.hasConversationMessages(path)) {
            console.log(`[SessionManager] Found modified JSONL (--continue): ${path}`);
            return path;
          }
        }
      }

      // Then check new files
      for (const { path } of fileStats) {
        const initialMtime = session.initialFileStats.get(path);

        if (initialMtime === undefined) {
          // New file that didn't exist when session started
          if (await this.hasConversationMessages(path)) {
            console.log(`[SessionManager] Found new JSONL: ${path}`);
            return path;
          }
        }
      }

      // No valid conversation file found yet
      return null;
    } catch {
      return null;
    }
  }

  private async processJsonlUpdates(session: InternalSession): Promise<void> {
    if (!session.watchedFile) return;

    try {
      const content = await readFile(session.watchedFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        const lineHash = hash(line);
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
          const todosHash = hash(JSON.stringify(todos));
          if (todosHash !== session.lastTodosHash) {
            session.lastTodosHash = todosHash;
            this.events.onTodos(session.id, todos);
          }
        }

        // Detect plan mode changes
        const planModeStatus = this.detectPlanMode(line);
        if (planModeStatus !== null && planModeStatus !== session.inPlanMode) {
          session.inPlanMode = planModeStatus;
          console.log(`[SessionManager] Session ${session.id} plan mode: ${planModeStatus}`);
          this.events.onPlanModeChange(session.id, planModeStatus);
        }

        // Extract tool calls from assistant messages
        const toolCalls = this.extractToolCalls(line);
        for (const tool of toolCalls) {
          this.events.onToolCall(session.id, tool);
        }

        // Extract tool results from user messages
        const toolResults = this.extractToolResults(line);
        for (const result of toolResults) {
          this.events.onToolResult(session.id, result);
        }

        // Parse and forward messages
        const parsed = this.parseJsonlLine(line);
        if (parsed) {
          const messageTime = new Date(parsed.timestamp);
          if (messageTime < session.startedAt) continue;

          this.events.onMessage(session.id, parsed.role, parsed.content);
        }
      }
    } catch (err) {
      console.error('[SessionManager] Error processing JSONL:', err);
    }
  }

  private async startWatching(session: InternalSession): Promise<void> {
    const jsonlFile = await this.findActiveJsonlFile(session);

    if (jsonlFile) {
      session.watchedFile = jsonlFile;
      this.claimedFiles.add(jsonlFile);
      console.log(`[SessionManager] Watching: ${jsonlFile}`);
      await this.processJsonlUpdates(session);
    } else {
      console.log(`[SessionManager] Waiting for JSONL changes in ${session.projectDir}`);
    }

    // Watch directory for changes
    try {
      session.watcher = watch(session.projectDir, { recursive: false }, async (_, filename) => {
        if (!filename?.endsWith('.jsonl')) return;

        if (!session.watchedFile) {
          const newFile = await this.findActiveJsonlFile(session);
          if (newFile) {
            session.watchedFile = newFile;
            this.claimedFiles.add(newFile);
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
        const newFile = await this.findActiveJsonlFile(session);
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

  private detectPlanMode(line: string): boolean | null {
    try {
      const data = JSON.parse(line);
      if (data.type !== 'user') return null;

      const content = data.message?.content;
      if (typeof content !== 'string') return null;

      // Check for plan mode activation
      if (content.includes('<system-reminder>') && content.includes('Plan mode is active')) {
        return true;
      }

      // Check for plan mode exit (ExitPlanMode was called)
      if (content.includes('Exited Plan Mode') || content.includes('exited plan mode')) {
        return false;
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractToolCalls(line: string): ToolCallInfo[] {
    try {
      const data = JSON.parse(line);
      if (data.type !== 'assistant') return [];

      const content = data.message?.content;
      if (!Array.isArray(content)) return [];

      const tools: ToolCallInfo[] = [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          tools.push({
            id: block.id,
            name: block.name,
            input: block.input || {},
          });
        }
      }
      return tools;
    } catch {
      return [];
    }
  }

  private extractToolResults(line: string): ToolResultInfo[] {
    try {
      const data = JSON.parse(line);
      if (data.type !== 'user') return [];

      const content = data.message?.content;
      if (!Array.isArray(content)) return [];

      const results: ToolResultInfo[] = [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          // Content can be string or array of text blocks
          let text = '';
          if (typeof block.content === 'string') {
            text = block.content;
          } else if (Array.isArray(block.content)) {
            text = block.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n');
          }

          results.push({
            toolUseId: block.tool_use_id,
            content: text,
            isError: block.is_error === true,
          });
        }
      }
      return results;
    } catch {
      return [];
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
