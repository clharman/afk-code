import { useStore } from './store';
import type { RelayMessage, OutgoingMessage } from './types';

type TokenGetter = () => Promise<string | null>;

class RelayConnection {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private getToken: TokenGetter | null = null;

  constructor() {
    // Use environment variable or default to localhost
    const baseUrl = process.env.EXPO_PUBLIC_RELAY_URL || 'ws://localhost:8080';
    this.url = `${baseUrl}/ws/mobile`;
  }

  setUrl(url: string) {
    this.url = url;
  }

  // Set the token getter function for refreshing tokens on reconnect
  setTokenGetter(getter: TokenGetter) {
    this.getToken = getter;
  }

  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('[Relay] Connected');
          this.send({ type: 'auth', token });
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as RelayMessage;
            this.handleMessage(message, resolve, reject);
          } catch (err) {
            console.error('[Relay] Parse error:', err);
          }
        };

        this.ws.onclose = () => {
          console.log('[Relay] Disconnected');
          useStore.getState().setConnected(false);
          this.scheduleReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[Relay] Error:', error);
          reject(new Error('Connection failed'));
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(
    message: RelayMessage,
    onAuthSuccess?: () => void,
    onAuthFail?: (err: Error) => void
  ) {
    const store = useStore.getState();

    switch (message.type) {
      case 'auth_ok':
        store.setConnected(true);
        this.send({ type: 'list_sessions' });
        onAuthSuccess?.();
        break;

      case 'auth_error':
        store.setConnected(false);
        onAuthFail?.(new Error(message.message));
        break;

      case 'sessions_list':
        store.setSessions(message.sessions);
        break;

      case 'session_output':
        // Legacy output (ignored now, we use session_message)
        break;

      case 'session_message':
        store.appendMessage(message.sessionId, message.role, message.content);
        break;

      case 'session_status':
        store.updateSessionStatus(message.sessionId, message.status);
        break;

      case 'error':
        console.error('[Relay] Server error:', message.message);
        break;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(async () => {
      console.log('[Relay] Reconnecting...');
      try {
        // Get a fresh token for reconnection
        const token = this.getToken ? await this.getToken() : null;
        if (token) {
          await this.connect(token);
        } else {
          console.error('[Relay] No token available for reconnect');
        }
      } catch (err) {
        console.error('[Relay] Reconnect failed:', err);
      }
    }, 3000);
  }

  send(message: OutgoingMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  subscribeToSession(sessionId: string) {
    this.send({ type: 'subscribe', sessionId });
  }

  unsubscribeFromSession(sessionId: string) {
    this.send({ type: 'unsubscribe', sessionId });
  }

  sendInput(sessionId: string, text: string) {
    this.send({ type: 'send_input', sessionId, text });
  }

  refreshSessions() {
    this.send({ type: 'list_sessions' });
  }

  registerPushToken(pushToken: string) {
    this.send({ type: 'register_push_token', pushToken });
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const relay = new RelayConnection();
