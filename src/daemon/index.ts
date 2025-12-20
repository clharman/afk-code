import { RelayClient } from './relay-client';
import { loadConfig } from '../cli/auth';
import { watch, type FSWatcher } from 'fs';
import { readFile, readdir } from 'fs/promises';
import type { Socket } from 'bun';

const DAEMON_SOCKET = '/tmp/snowfort-daemon.sock';

// Configuration
let RELAY_URL = process.env.SNOWFORT_RELAY_URL || 'ws://localhost:8080';
let RELAY_TOKEN = process.env.SNOWFORT_TOKEN || '';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface Session {
  id: string;
  name: string;
  cwd: string;
  projectDir: string;
  command: string[];
  socket: Socket<unknown>;
  status: 'running' | 'idle';
  watcher?: FSWatcher;
  watchedFile?: string;
  lastFileSize: number;
  seenMessages: Set<string>; // Track message UUIDs to avoid duplicates
}

// Active sessions
const sessions = new Map<string, Session>();

// Relay client
let relayClient: RelayClient | null = null;

async function loadDaemonConfig(): Promise<void> {
  const config = await loadConfig();

  if (config.deviceToken) {
    RELAY_TOKEN = config.deviceToken;
  }
  if (config.relayUrl) {
    RELAY_URL = config.relayUrl;
  }

  if (!RELAY_TOKEN) {
    console.log('[Daemon] No device token found, using dev mode');
    RELAY_TOKEN = 'dev-token';
  }
}

// Parse a JSONL line and extract message if it's a user or assistant message
function parseJsonlLine(line: string): ParsedMessage | null {
  try {
    const data = JSON.parse(line);

    // Skip non-message types
    if (data.type !== 'user' && data.type !== 'assistant') {
      return null;
    }

    // Skip meta/system messages
    if (data.isMeta || data.subtype) {
      return null;
    }

    const message = data.message;
    if (!message || !message.role) {
      return null;
    }

    // Extract content
    let content = '';
    if (typeof message.content === 'string') {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      // Assistant messages have content as array
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          content += block.text;
        }
      }
    }

    if (!content.trim()) {
      return null;
    }

    return {
      role: message.role as 'user' | 'assistant',
      content: content.trim(),
      timestamp: data.timestamp || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// Find the most recently modified JSONL file in the project directory
async function findLatestJsonlFile(projectDir: string): Promise<string | null> {
  try {
    const files = await readdir(projectDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) return null;

    // Get modification times
    const fileStats = await Promise.all(
      jsonlFiles.map(async (file) => {
        const path = `${projectDir}/${file}`;
        const stat = await Bun.file(path).stat();
        return { path, mtime: stat?.mtime || 0 };
      })
    );

    // Sort by mtime descending
    fileStats.sort((a, b) => (b.mtime as number) - (a.mtime as number));

    return fileStats[0]?.path || null;
  } catch (err) {
    console.error('[Daemon] Error finding JSONL file:', err);
    return null;
  }
}

// Read new content from JSONL file and parse messages
async function processJsonlUpdates(session: Session): Promise<void> {
  if (!session.watchedFile) return;

  try {
    const file = Bun.file(session.watchedFile);
    const content = await file.text();
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      // Create a hash of the line to track if we've seen it
      const lineHash = Bun.hash(line).toString();
      if (session.seenMessages.has(lineHash)) {
        continue;
      }
      session.seenMessages.add(lineHash);

      const parsed = parseJsonlLine(line);
      if (parsed && relayClient?.isConnected()) {
        console.log(`[Daemon] New ${parsed.role} message for session ${session.id}`);
        relayClient.sendMessage(session.id, parsed.role, parsed.content);

        // Update status based on message type
        const newStatus = parsed.role === 'assistant' ? 'idle' : 'running';
        if (newStatus !== session.status) {
          session.status = newStatus;
          relayClient.sendSessionStatus(session.id, newStatus);
        }
      }
    }
  } catch (err) {
    console.error('[Daemon] Error processing JSONL:', err);
  }
}

// Start watching the project directory for JSONL changes
async function startWatching(session: Session): Promise<void> {
  // Find the latest JSONL file
  const jsonlFile = await findLatestJsonlFile(session.projectDir);

  if (!jsonlFile) {
    console.log(`[Daemon] No JSONL file found in ${session.projectDir}, will watch directory`);
  } else {
    session.watchedFile = jsonlFile;
    console.log(`[Daemon] Watching ${jsonlFile}`);

    // Initial read
    await processJsonlUpdates(session);
  }

  // Watch the directory for changes
  try {
    session.watcher = watch(session.projectDir, { recursive: false }, async (eventType, filename) => {
      if (!filename?.endsWith('.jsonl')) return;

      const filePath = `${session.projectDir}/${filename}`;

      // If we're not watching a file yet, or a newer file appeared, switch to it
      if (!session.watchedFile || filePath !== session.watchedFile) {
        const latestFile = await findLatestJsonlFile(session.projectDir);
        if (latestFile && latestFile !== session.watchedFile) {
          console.log(`[Daemon] Switching to watch ${latestFile}`);
          session.watchedFile = latestFile;
          session.seenMessages.clear();
        }
      }

      // Process updates
      await processJsonlUpdates(session);
    });
  } catch (err) {
    console.error('[Daemon] Error setting up watcher:', err);
  }

  // Also poll periodically in case file watching misses updates
  const pollInterval = setInterval(async () => {
    if (!sessions.has(session.id)) {
      clearInterval(pollInterval);
      return;
    }

    // Check for new files
    const latestFile = await findLatestJsonlFile(session.projectDir);
    if (latestFile && latestFile !== session.watchedFile) {
      console.log(`[Daemon] Poll found new file: ${latestFile}`);
      session.watchedFile = latestFile;
    }

    if (session.watchedFile) {
      await processJsonlUpdates(session);
    }
  }, 1000);
}

function stopWatching(session: Session): void {
  if (session.watcher) {
    session.watcher.close();
  }
}

function handleSessionMessage(socket: Socket<unknown>, message: any): void {
  switch (message.type) {
    case 'session_start': {
      const session: Session = {
        id: message.id,
        name: message.name || message.command?.join(' ') || 'Unknown',
        cwd: message.cwd,
        projectDir: message.projectDir,
        command: message.command,
        socket,
        status: 'running',
        lastFileSize: 0,
        seenMessages: new Set(),
      };
      sessions.set(message.id, session);
      console.log(`[Daemon] Session started: ${message.id} - ${session.name}`);
      console.log(`[Daemon] Project dir: ${session.projectDir}`);

      // Notify relay
      if (relayClient?.isConnected()) {
        relayClient.sendSessionStart(message.id, session.name, session.cwd);
      }

      // Start watching JSONL files
      startWatching(session);
      break;
    }

    case 'session_end': {
      const session = sessions.get(message.sessionId);
      if (session) {
        console.log(`[Daemon] Session ended: ${message.sessionId}`);
        stopWatching(session);
        sessions.delete(message.sessionId);

        if (relayClient?.isConnected()) {
          relayClient.sendSessionEnd(message.sessionId);
        }
      }
      break;
    }
  }
}

function handleRelayMessage(message: any): void {
  switch (message.type) {
    case 'send_input': {
      // Forward input from mobile to the PTY
      const session = sessions.get(message.sessionId);
      if (session) {
        console.log(`[Daemon] Forwarding input to session ${message.sessionId}`);
        // Send text first, then Enter key separately after a brief delay
        session.socket.write(JSON.stringify({
          type: 'input',
          text: message.text,
        }) + '\n');

        // Small delay then send Enter to submit
        setTimeout(() => {
          session.socket.write(JSON.stringify({
            type: 'input',
            text: '\r',
          }) + '\n');
        }, 50);
      }
      break;
    }
  }
}

async function startUnixSocketServer(): Promise<void> {
  try {
    await Bun.$`rm -f ${DAEMON_SOCKET}`.quiet();
  } catch {}

  Bun.listen({
    unix: DAEMON_SOCKET,
    socket: {
      data(socket, data) {
        const messages = data.toString().split('\n').filter(Boolean);

        for (const msg of messages) {
          try {
            const parsed = JSON.parse(msg);
            handleSessionMessage(socket, parsed);
          } catch (error) {
            console.error('[Daemon] Error parsing message:', error);
          }
        }
      },
      error(socket, error) {
        console.error('[Daemon] Socket error:', error);
      },
      close(socket) {
        for (const [id, session] of sessions) {
          if (session.socket === socket) {
            console.log(`[Daemon] Session disconnected: ${id}`);
            stopWatching(session);
            sessions.delete(id);

            if (relayClient?.isConnected()) {
              relayClient.sendSessionEnd(id);
            }
            break;
          }
        }
      },
    },
  });

  console.log(`[Daemon] Unix socket server listening on ${DAEMON_SOCKET}`);
}

async function connectToRelay(): Promise<void> {
  console.log(`[Daemon] Connecting to relay at ${RELAY_URL}...`);

  relayClient = new RelayClient(RELAY_URL, RELAY_TOKEN);
  relayClient.setMessageHandler(handleRelayMessage);

  try {
    await relayClient.connect();
    console.log('[Daemon] Connected to relay');
  } catch (err) {
    console.warn('[Daemon] Failed to connect to relay:', (err as Error).message);
    console.warn('[Daemon] Running in offline mode (local only)');
  }
}

export async function startDaemon(): Promise<void> {
  console.log('[Daemon] Starting Snowfort daemon...');

  await loadDaemonConfig();
  await startUnixSocketServer();
  await connectToRelay();

  console.log('[Daemon] Ready.');
  console.log(`[Daemon] Relay: ${RELAY_URL}`);
  console.log(`[Daemon] Connected: ${relayClient?.isConnected() || false}`);

  await new Promise(() => {});
}

if (import.meta.main) {
  startDaemon().catch((error) => {
    console.error('[Daemon] Fatal error:', error);
    process.exit(1);
  });
}
