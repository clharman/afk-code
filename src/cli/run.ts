import { randomUUID } from 'crypto';
import { spawn } from 'bun';
import { spawn as spawnPty } from '@zenyr/bun-pty';
import type { Socket } from 'bun';
import { homedir } from 'os';

const DAEMON_SOCKET = '/tmp/snowfort-daemon.sock';

// Get Claude's project directory for the current working directory
function getClaudeProjectDir(cwd: string): string {
  // Claude encodes paths by replacing / with -
  const encodedPath = cwd.replace(/\//g, '-');
  return `${homedir()}/.claude/projects/${encodedPath}`;
}

// Connect to daemon and maintain bidirectional communication
async function connectToDaemon(
  sessionId: string,
  projectDir: string,
  cwd: string,
  command: string[],
  onInput: (text: string) => void
): Promise<{ close: () => void } | null> {
  try {
    let messageBuffer = '';

    const socket = await Bun.connect({
      unix: DAEMON_SOCKET,
      socket: {
        data(socket, data) {
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
        },
        error(socket, error) {
          console.error('[Session] Daemon connection error:', error);
        },
        close(socket) {},
      },
    });

    // Tell daemon about this session
    socket.write(JSON.stringify({
      type: 'session_start',
      id: sessionId,
      projectDir,
      cwd,
      command,
      name: command.join(' '),
    }) + '\n');

    return {
      close: () => {
        socket.write(JSON.stringify({ type: 'session_end', sessionId }) + '\n');
        socket.end();
      },
    };
  } catch {
    return null;
  }
}

export async function run(command: string[]): Promise<void> {
  const sessionId = randomUUID().slice(0, 8);
  const cwd = process.cwd();
  const projectDir = getClaudeProjectDir(cwd);

  // Use bun-pty for full terminal features + remote input
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const pty = spawnPty(command[0], command.slice(1), {
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
      pty.write(text);
    }
  );

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  pty.onData((data: string) => {
    process.stdout.write(data);
  });

  process.stdin.on('data', (data: Buffer) => {
    pty.write(data.toString());
  });

  process.stdout.on('resize', () => {
    pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  await new Promise<void>((resolve) => {
    pty.onExit(() => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      daemon?.close();
      resolve();
    });
  });
}
