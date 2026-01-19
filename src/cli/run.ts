import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { createConnection, type Socket } from 'net';
import * as pty from 'node-pty';

const DAEMON_SOCKET = '/tmp/afk-code-daemon.sock';

// Get Claude's project directory for the current working directory
function getClaudeProjectDir(cwd: string): string {
  // Claude encodes paths by replacing / with -
  const encodedPath = cwd.replace(/\//g, '-');
  return `${homedir()}/.claude/projects/${encodedPath}`;
}

// Connect to daemon and maintain bidirectional communication
function connectToDaemon(
  sessionId: string,
  projectDir: string,
  cwd: string,
  command: string[],
  onInput: (text: string) => void
): Promise<{ close: () => void } | null> {
  return new Promise((resolve) => {
    const socket = createConnection(DAEMON_SOCKET);
    let messageBuffer = '';

    socket.on('connect', () => {
      // Tell daemon about this session
      socket.write(JSON.stringify({
        type: 'session_start',
        id: sessionId,
        projectDir,
        cwd,
        command,
        name: command.join(' '),
      }) + '\n');

      resolve({
        close: () => {
          socket.write(JSON.stringify({ type: 'session_end', sessionId }) + '\n');
          socket.end();
        },
      });
    });

    socket.on('data', (data) => {
      messageBuffer += data.toString();

      const lines = messageBuffer.split('\n');
      messageBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'input' && msg.text) {
            onInput(msg.text);
          }
        } catch {}
      }
    });

    socket.on('error', (error) => {
      // Daemon not running - that's okay, run without it
      resolve(null);
    });
  });
}

export async function run(command: string[]): Promise<void> {
  const sessionId = randomUUID().slice(0, 8);
  const cwd = process.cwd();
  const projectDir = getClaudeProjectDir(cwd);

  // Use node-pty for full terminal features + remote input
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const ptyProcess = pty.spawn(command[0], command.slice(1), {
    name: process.env.TERM || 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  const daemon = await connectToDaemon(
    sessionId,
    projectDir,
    cwd,
    command,
    (text) => {
      ptyProcess.write(text);
    }
  );

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  ptyProcess.onData((data: string) => {
    process.stdout.write(data);
  });

  const onStdinData = (data: Buffer) => {
    ptyProcess.write(data.toString());
  };
  process.stdin.on('data', onStdinData);

  process.stdout.on('resize', () => {
    ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  await new Promise<void>((resolve) => {
    ptyProcess.onExit(() => {
      // Clean up stdin
      process.stdin.removeListener('data', onStdinData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.unref();

      daemon?.close();
      resolve();
    });
  });
}
