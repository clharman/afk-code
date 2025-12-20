import { authService, isDevToken } from './auth';
import { connectionRegistry, type ClientData, type ClientType } from './connections';
import { pushService } from './push';
import * as db from './db';
import type {
  DaemonMessage,
  RelayToDaemonMessage,
  MobileMessage,
  RelayToMobileMessage,
} from '../types';

const PORT = parseInt(process.env.RELAY_PORT || '8080');
const RELAY_PUBLIC_URL = process.env.RELAY_PUBLIC_URL || `http://localhost:${PORT}`;
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || '';

// In-memory store for pending device codes (in production, use Redis)
interface PendingDeviceCode {
  code: string;
  deviceName: string;
  createdAt: number;
  deviceToken?: string; // Set when verified
}
const pendingDeviceCodes = new Map<string, PendingDeviceCode>();
const DEVICE_CODE_EXPIRY = 10 * 60 * 1000; // 10 minutes

function generateDeviceCode(): string {
  // Generate 6-character alphanumeric code (easy to type)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function cleanupExpiredCodes() {
  const now = Date.now();
  for (const [code, data] of pendingDeviceCodes) {
    if (now - data.createdAt > DEVICE_CODE_EXPIRY) {
      pendingDeviceCodes.delete(code);
    }
  }
}

// Extract Clerk frontend API URL from publishable key
function getClerkFrontendApi(): string {
  if (!CLERK_PUBLISHABLE_KEY) return '';
  try {
    // Key format: pk_test_<base64> or pk_live_<base64>
    const base64Part = CLERK_PUBLISHABLE_KEY.split('_')[2];
    const decoded = atob(base64Part);
    // Remove trailing $ if present
    return decoded.replace(/\$$/, '');
  } catch {
    return '';
  }
}

async function handleDaemonMessage(
  ws: Bun.ServerWebSocket<ClientData>,
  message: DaemonMessage
): Promise<void> {
  switch (message.type) {
    case 'auth': {
      // Support dev token for testing
      if (isDevToken(message.token)) {
        connectionRegistry.registerConnection(ws, 'dev-user', 'daemon');
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        return;
      }

      const result = await authService.authenticateDaemon(message.token);
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'auth_error', message: result.error }));
        ws.close();
        return;
      }
      connectionRegistry.registerConnection(ws, result.userId!, 'daemon');
      ws.data.deviceId = result.deviceId;
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      break;
    }

    case 'session_start': {
      if (!ws.data.authenticated) return;
      connectionRegistry.registerSession(ws, {
        id: message.sessionId,
        name: message.name,
        cwd: message.cwd,
        port: 0, // Not relevant for relay
        status: 'running',
        startedAt: new Date(),
      });
      break;
    }

    case 'session_output': {
      if (!ws.data.authenticated) return;
      // Forward to subscribed mobile clients
      connectionRegistry.notifySubscribedClients(ws.data.userId, message.sessionId, {
        type: 'session_output',
        sessionId: message.sessionId,
        data: message.data,
      });
      break;
    }

    case 'session_message': {
      if (!ws.data.authenticated) return;
      console.log(`[Relay] Received message from daemon: session=${message.sessionId} role=${message.role}`);
      // Store message in history
      connectionRegistry.addMessage(message.sessionId, message.role, message.content);
      // Forward conversation message to subscribed mobile clients
      connectionRegistry.notifySubscribedClients(ws.data.userId, message.sessionId, {
        type: 'session_message',
        sessionId: message.sessionId,
        role: message.role,
        content: message.content,
      });
      break;
    }

    case 'session_status': {
      if (!ws.data.authenticated) return;
      connectionRegistry.updateSessionStatus(message.sessionId, message.status);

      // Send push notification if session goes idle and is tracked
      if (message.status === 'idle') {
        const session = connectionRegistry.getSessionsForUser(ws.data.userId)
          .find(s => s.id === message.sessionId);
        if (session && connectionRegistry.isSessionTracked(ws.data.userId, message.sessionId)) {
          pushService.sendSessionIdleNotification(ws.data.userId, message.sessionId, session.name);
        }
      }
      break;
    }

    case 'session_end': {
      if (!ws.data.authenticated) return;
      const session = connectionRegistry.getSessionsForUser(ws.data.userId)
        .find(s => s.id === message.sessionId);

      connectionRegistry.updateSessionStatus(message.sessionId, 'ended');

      // Send push notification if session was tracked
      if (session && connectionRegistry.isSessionTracked(ws.data.userId, message.sessionId)) {
        pushService.sendSessionEndedNotification(ws.data.userId, message.sessionId, session.name);
      }
      break;
    }
  }
}

async function handleMobileMessage(
  ws: Bun.ServerWebSocket<ClientData>,
  message: MobileMessage
): Promise<void> {
  switch (message.type) {
    case 'auth': {
      // Support dev token for testing
      if (isDevToken(message.token)) {
        connectionRegistry.registerConnection(ws, 'dev-user', 'mobile');
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        return;
      }

      const result = await authService.authenticateMobile(message.token);
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'auth_error', message: result.error }));
        ws.close();
        return;
      }

      // In dev mode, use 'dev-user' to match daemon sessions
      const DEV_MODE = process.env.NODE_ENV !== 'production';
      const userId = DEV_MODE ? 'dev-user' : result.userId!;
      connectionRegistry.registerConnection(ws, userId, 'mobile');
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      break;
    }

    case 'list_sessions': {
      if (!ws.data.authenticated) return;
      const sessions = connectionRegistry.getSessionsForUser(ws.data.userId);
      ws.send(JSON.stringify({ type: 'sessions_list', sessions }));
      break;
    }

    case 'subscribe': {
      if (!ws.data.authenticated) return;
      const success = connectionRegistry.subscribeToSession(ws, message.sessionId);
      if (!success) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Session not found or not accessible',
        }));
      }
      break;
    }

    case 'unsubscribe': {
      if (!ws.data.authenticated) return;
      connectionRegistry.unsubscribeFromSession(ws, message.sessionId);
      break;
    }

    case 'send_input': {
      if (!ws.data.authenticated) return;
      // Forward to daemon
      const daemonWs = connectionRegistry.getDaemonForSession(message.sessionId);
      if (daemonWs) {
        daemonWs.send(JSON.stringify({
          type: 'send_input',
          sessionId: message.sessionId,
          text: message.text,
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Session daemon not connected',
        }));
      }
      break;
    }

    case 'track_session': {
      if (!ws.data.authenticated) return;
      connectionRegistry.trackSession(ws.data.userId, message.sessionId);
      break;
    }

    case 'untrack_session': {
      if (!ws.data.authenticated) return;
      connectionRegistry.untrackSession(ws.data.userId, message.sessionId);
      break;
    }

    case 'register_push_token': {
      if (!ws.data.authenticated) return;
      pushService.registerToken(ws.data.userId, message.pushToken);
      break;
    }
  }
}

const server = Bun.serve<ClientData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        ...connectionRegistry.getStats(),
        push: pushService.getStats(),
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Device registration API
    if (url.pathname === '/api/devices' && req.method === 'POST') {
      try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
          return new Response(JSON.stringify({ error: 'Missing authorization' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const token = authHeader.slice(7);

        // Verify Clerk token
        const result = await authService.authenticateMobile(token);
        if (!result.success) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Get device name from body
        const body = await req.json() as { name: string };
        const deviceName = body.name || 'Unknown Device';

        // Create device in database
        const device = await db.createDevice(result.userId!, deviceName);
        if (!device) {
          return new Response(JSON.stringify({ error: 'Failed to create device' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          deviceToken: device.device_token,
          deviceId: device.id,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error('[Relay] Device registration error:', err);
        return new Response(JSON.stringify({ error: 'Internal error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Device code flow - Step 1: Request a code
    if (url.pathname === '/api/device-code' && req.method === 'POST') {
      cleanupExpiredCodes();

      const body = await req.json() as { deviceName?: string };
      const code = generateDeviceCode();

      pendingDeviceCodes.set(code, {
        code,
        deviceName: body.deviceName || 'Unknown Device',
        createdAt: Date.now(),
      });

      return new Response(JSON.stringify({
        code,
        verification_url: `${RELAY_PUBLIC_URL}/auth/device?code=${code}`,
        expires_in: DEVICE_CODE_EXPIRY / 1000,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Device code flow - Step 2: Poll for completion
    if (url.pathname.startsWith('/api/device-code/') && req.method === 'GET') {
      const code = url.pathname.split('/').pop()!;
      const pending = pendingDeviceCodes.get(code);

      if (!pending) {
        return new Response(JSON.stringify({ error: 'Code not found or expired' }), {
          status: 410,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (Date.now() - pending.createdAt > DEVICE_CODE_EXPIRY) {
        pendingDeviceCodes.delete(code);
        return new Response(JSON.stringify({ error: 'Code expired' }), {
          status: 410,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (pending.deviceToken) {
        // Code has been verified, return the device token
        pendingDeviceCodes.delete(code);
        return new Response(JSON.stringify({ device_token: pending.deviceToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Still waiting
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Device code flow - Step 3: Verify code with Clerk token
    if (url.pathname === '/api/device-code/verify' && req.method === 'POST') {
      try {
        const body = await req.json() as { code: string; token: string };
        const pending = pendingDeviceCodes.get(body.code);

        if (!pending) {
          return new Response(JSON.stringify({ error: 'Invalid or expired code' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Verify Clerk token
        const result = await authService.authenticateMobile(body.token);
        if (!result.success) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Create device in database
        const device = await db.createDevice(result.userId!, pending.deviceName);
        if (!device) {
          return new Response(JSON.stringify({ error: 'Failed to create device' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Store token for CLI to pick up
        pending.deviceToken = device.device_token;

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error('[Relay] Device verification error:', err);
        return new Response(JSON.stringify({ error: 'Verification failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Device auth page - Shows Clerk sign-in and code verification
    if (url.pathname === '/auth/device') {
      const code = url.searchParams.get('code') || '';
      return new Response(deviceAuthPage(code), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws/daemon') {
      const success = server.upgrade(req, {
        data: { type: 'daemon' as ClientType, userId: '', authenticated: false, subscribedSessions: new Set() },
      });
      return success ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    if (url.pathname === '/ws/mobile') {
      const success = server.upgrade(req, {
        data: { type: 'mobile' as ClientType, userId: '', authenticated: false, subscribedSessions: new Set() },
      });
      return success ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log(`[Relay] WebSocket opened: ${ws.data.type}`);
    },

    message(ws, message) {
      try {
        const data = JSON.parse(message.toString());

        if (ws.data.type === 'daemon') {
          handleDaemonMessage(ws, data as DaemonMessage);
        } else {
          handleMobileMessage(ws, data as MobileMessage);
        }
      } catch (err) {
        console.error('[Relay] Error parsing message:', err);
      }
    },

    close(ws) {
      connectionRegistry.removeConnection(ws);
    },

    error(ws, error) {
      console.error('[Relay] WebSocket error:', error);
    },
  },
});

console.log(`[Relay] Server running on http://localhost:${PORT}`);
console.log(`[Relay] Daemon WebSocket: ws://localhost:${PORT}/ws/daemon`);
console.log(`[Relay] Mobile WebSocket: ws://localhost:${PORT}/ws/mobile`);
console.log(`[Relay] Health check: http://localhost:${PORT}/health`);
console.log(`[Relay] Device auth: http://localhost:${PORT}/auth/device`);
console.log(`[Relay] Test token: test-token-123`);

// HTML page for device authentication with Clerk
function deviceAuthPage(code: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Snowfort - Link Device</title>
  <script
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${CLERK_PUBLISHABLE_KEY}"
    src="https://${getClerkFrontendApi()}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
    type="text/javascript"
  ></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f1a;
      color: #fff;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container {
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #9ca3af;
      margin-bottom: 32px;
    }
    .code-display {
      background: #1a1a2e;
      border: 2px solid #6366f1;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .code-label {
      color: #9ca3af;
      font-size: 14px;
      margin-bottom: 8px;
    }
    .code {
      font-size: 32px;
      font-weight: bold;
      letter-spacing: 4px;
      color: #6366f1;
    }
    #clerk-auth {
      margin: 24px 0;
    }
    .status {
      padding: 16px;
      border-radius: 8px;
      margin-top: 24px;
    }
    .status.success {
      background: #065f46;
      color: #6ee7b7;
    }
    .status.error {
      background: #7f1d1d;
      color: #fca5a5;
    }
    .status.loading {
      background: #1e3a5f;
      color: #93c5fd;
    }
    .hidden { display: none; }
    .manual-code {
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2a2a4a;
    }
    .manual-code input {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 12px 16px;
      color: #fff;
      font-size: 18px;
      text-align: center;
      letter-spacing: 4px;
      text-transform: uppercase;
      width: 100%;
      margin-top: 8px;
    }
    .manual-code input:focus {
      outline: none;
      border-color: #6366f1;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Link Device to Snowfort</h1>
    <p class="subtitle">Sign in to link your computer</p>

    <div class="code-display ${code ? '' : 'hidden'}" id="code-section">
      <div class="code-label">Device Code</div>
      <div class="code" id="device-code">${code}</div>
    </div>

    <div class="manual-code ${code ? 'hidden' : ''}" id="manual-section">
      <p class="code-label">Enter the code from your terminal:</p>
      <input type="text" id="code-input" maxlength="6" placeholder="XXXXXX" autocomplete="off">
    </div>

    <div id="clerk-auth"></div>

    <div id="status" class="status hidden"></div>
  </div>

  <script>
    let deviceCode = '${code}';
    const statusEl = document.getElementById('status');
    const codeInput = document.getElementById('code-input');
    const codeSection = document.getElementById('code-section');
    const manualSection = document.getElementById('manual-section');
    const deviceCodeEl = document.getElementById('device-code');

    // Handle manual code input
    if (codeInput) {
      codeInput.addEventListener('input', (e) => {
        const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        e.target.value = val;
        if (val.length === 6) {
          deviceCode = val;
          deviceCodeEl.textContent = val;
          codeSection.classList.remove('hidden');
          manualSection.classList.add('hidden');
        }
      });
    }

    function showStatus(message, type) {
      statusEl.textContent = message;
      statusEl.className = 'status ' + type;
    }

    async function verifyDevice(token) {
      if (!deviceCode) {
        showStatus('Please enter a device code first', 'error');
        return;
      }

      showStatus('Linking device...', 'loading');

      try {
        const response = await fetch('/api/device-code/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: deviceCode, token }),
        });

        const data = await response.json();

        if (response.ok) {
          showStatus('Device linked successfully! You can close this window and return to your terminal.', 'success');
        } else {
          showStatus(data.error || 'Failed to link device', 'error');
        }
      } catch (err) {
        showStatus('Network error. Please try again.', 'error');
      }
    }

    // Wait for Clerk to load (it auto-initializes from script data attribute)
    window.addEventListener('load', async () => {
      // Wait a moment for Clerk to initialize
      let attempts = 0;
      while (!window.Clerk && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }

      if (!window.Clerk) {
        showStatus('Failed to load authentication', 'error');
        return;
      }

      const clerk = window.Clerk;

      // Wait for Clerk to be ready
      await clerk.load();

      if (clerk.user) {
        // Already signed in, get token and verify
        const token = await clerk.session.getToken();
        await verifyDevice(token);
      } else {
        // Mount sign-in
        clerk.mountSignIn(document.getElementById('clerk-auth'), {
          afterSignInUrl: window.location.href,
          afterSignUpUrl: window.location.href,
        });

        // Listen for sign-in
        clerk.addListener(async ({ user }) => {
          if (user) {
            const token = await clerk.session.getToken();
            await verifyDevice(token);
          }
        });
      }
    });
  </script>
</body>
</html>`;
}
