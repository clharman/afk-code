import { authService } from './auth';
import { connectionRegistry, type ClientData, type ClientType } from './connections';
import type {
  DaemonMessage,
  RelayToDaemonMessage,
  MobileMessage,
  RelayToMobileMessage,
} from '../types';

const PORT = parseInt(process.env.RELAY_PORT || '8080');

function handleDaemonMessage(
  ws: Bun.ServerWebSocket<ClientData>,
  message: DaemonMessage
): void {
  switch (message.type) {
    case 'auth': {
      const userId = authService.validateToken(message.token);
      if (!userId) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
        ws.close();
        return;
      }
      connectionRegistry.registerConnection(ws, userId, 'daemon');
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

    case 'session_status': {
      if (!ws.data.authenticated) return;
      connectionRegistry.updateSessionStatus(message.sessionId, message.status);

      // TODO: If status is 'idle' and session is tracked, send push notification
      break;
    }

    case 'session_end': {
      if (!ws.data.authenticated) return;
      connectionRegistry.updateSessionStatus(message.sessionId, 'ended');
      break;
    }
  }
}

function handleMobileMessage(
  ws: Bun.ServerWebSocket<ClientData>,
  message: MobileMessage
): void {
  switch (message.type) {
    case 'auth': {
      const userId = authService.validateToken(message.token);
      if (!userId) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
        ws.close();
        return;
      }
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
  }
}

const server = Bun.serve<ClientData>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ...connectionRegistry.getStats() }), {
        headers: { 'Content-Type': 'application/json' },
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
console.log(`[Relay] Test token: test-token-123`);
