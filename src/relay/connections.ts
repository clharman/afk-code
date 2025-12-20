import type { ServerWebSocket } from 'bun';
import type { Session } from '../types';

export type ClientType = 'daemon' | 'mobile';

export interface ClientData {
  type: ClientType;
  userId: string;
  authenticated: boolean;
  subscribedSessions: Set<string>;
  deviceId?: string; // For daemon connections
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TrackedSession extends Session {
  daemonWs: ServerWebSocket<ClientData> | null;
  messages: ChatMessage[]; // Buffer of recent messages
}

class ConnectionRegistry {
  // User ID -> list of connected clients (daemons and mobile apps)
  private userConnections: Map<string, Set<ServerWebSocket<ClientData>>> = new Map();

  // Session ID -> session info + daemon connection
  private sessions: Map<string, TrackedSession> = new Map();

  // Track which sessions each user is tracking (for notifications)
  private userTrackedSessions: Map<string, Set<string>> = new Map();

  // Register a new connection
  registerConnection(ws: ServerWebSocket<ClientData>, userId: string, type: ClientType): void {
    ws.data.userId = userId;
    ws.data.type = type;
    ws.data.authenticated = true;
    ws.data.subscribedSessions = new Set();

    let connections = this.userConnections.get(userId);
    if (!connections) {
      connections = new Set();
      this.userConnections.set(userId, connections);
    }
    connections.add(ws);

    console.log(`[Connections] ${type} connected for user ${userId.slice(0, 8)}`);
  }

  // Remove a connection
  removeConnection(ws: ServerWebSocket<ClientData>): void {
    const { userId, type } = ws.data;
    if (!userId) return;

    const connections = this.userConnections.get(userId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        this.userConnections.delete(userId);
      }
    }

    // If this was a daemon, mark its sessions as disconnected
    if (type === 'daemon') {
      for (const [sessionId, session] of this.sessions) {
        if (session.daemonWs === ws) {
          session.daemonWs = null;
          session.status = 'ended';
          this.notifyMobileClients(userId, {
            type: 'session_status',
            sessionId,
            status: 'ended',
          });
        }
      }
    }

    console.log(`[Connections] ${type} disconnected for user ${userId.slice(0, 8)}`);
  }

  // Register a new session from a daemon
  registerSession(ws: ServerWebSocket<ClientData>, session: Omit<TrackedSession, 'daemonWs' | 'messages'>): void {
    const trackedSession: TrackedSession = {
      ...session,
      daemonWs: ws,
      messages: [],
    };
    this.sessions.set(session.id, trackedSession);

    // Notify mobile clients about new session
    this.notifyMobileClients(ws.data.userId, {
      type: 'sessions_list',
      sessions: this.getSessionsForUser(ws.data.userId),
    });

    console.log(`[Connections] Session ${session.id.slice(0, 8)} registered`);
  }

  // Update session status
  updateSessionStatus(sessionId: string, status: Session['status']): void {
    const session = this.sessions.get(sessionId);
    if (session && session.daemonWs) {
      session.status = status;

      // Notify subscribed mobile clients
      const userId = session.daemonWs.data.userId;
      this.notifySubscribedClients(userId, sessionId, {
        type: 'session_status',
        sessionId,
        status,
      });
    }
  }

  // Get all sessions for a user
  getSessionsForUser(userId: string): Session[] {
    const sessions: Session[] = [];
    for (const [_, session] of this.sessions) {
      if (session.daemonWs?.data.userId === userId) {
        const { daemonWs, ...sessionData } = session;
        sessions.push(sessionData);
      }
    }
    return sessions;
  }

  // Get daemon connection for a session
  getDaemonForSession(sessionId: string): ServerWebSocket<ClientData> | null {
    return this.sessions.get(sessionId)?.daemonWs || null;
  }

  // Subscribe a mobile client to a session's output
  subscribeToSession(ws: ServerWebSocket<ClientData>, sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.daemonWs?.data.userId !== ws.data.userId) {
      return false;
    }

    ws.data.subscribedSessions.add(sessionId);
    console.log(`[Connections] Mobile subscribed to session ${sessionId.slice(0, 8)}, now has ${ws.data.subscribedSessions.size} subscriptions`);

    // Send current session status
    ws.send(JSON.stringify({
      type: 'session_status',
      sessionId,
      status: session.status,
    }));

    // Replay message history
    for (const msg of session.messages) {
      ws.send(JSON.stringify({
        type: 'session_message',
        sessionId,
        role: msg.role,
        content: msg.content,
      }));
    }

    return true;
  }

  // Add a message to session history
  addMessage(sessionId: string, role: 'user' | 'assistant', content: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push({ role, content });
      // Keep only last 100 messages to avoid unbounded growth
      if (session.messages.length > 100) {
        session.messages = session.messages.slice(-100);
      }
    }
  }

  // Unsubscribe from a session
  unsubscribeFromSession(ws: ServerWebSocket<ClientData>, sessionId: string): void {
    ws.data.subscribedSessions.delete(sessionId);
  }

  // Track a session for push notifications
  trackSession(userId: string, sessionId: string): void {
    let tracked = this.userTrackedSessions.get(userId);
    if (!tracked) {
      tracked = new Set();
      this.userTrackedSessions.set(userId, tracked);
    }
    tracked.add(sessionId);
  }

  // Untrack a session
  untrackSession(userId: string, sessionId: string): void {
    const tracked = this.userTrackedSessions.get(userId);
    if (tracked) {
      tracked.delete(sessionId);
    }
  }

  // Check if session is tracked for notifications
  isSessionTracked(userId: string, sessionId: string): boolean {
    return this.userTrackedSessions.get(userId)?.has(sessionId) || false;
  }

  // Send message to all mobile clients of a user
  notifyMobileClients(userId: string, message: object): void {
    const connections = this.userConnections.get(userId);
    if (!connections) return;

    const data = JSON.stringify(message);
    for (const ws of connections) {
      if (ws.data.type === 'mobile' && ws.data.authenticated) {
        ws.send(data);
      }
    }
  }

  // Send message to mobile clients subscribed to a specific session
  notifySubscribedClients(userId: string, sessionId: string, message: object): void {
    const connections = this.userConnections.get(userId);
    if (!connections) {
      console.log(`[Connections] No connections for user ${userId.slice(0, 8)}`);
      return;
    }

    const data = JSON.stringify(message);
    let sent = 0;
    for (const ws of connections) {
      if (ws.data.type === 'mobile' && ws.data.subscribedSessions.has(sessionId)) {
        ws.send(data);
        sent++;
      }
    }
    console.log(`[Connections] Forwarded to ${sent} subscribed clients (session ${sessionId.slice(0, 8)})`);
  }

  // Get stats
  getStats(): { users: number; sessions: number; connections: number } {
    let totalConnections = 0;
    for (const conns of this.userConnections.values()) {
      totalConnections += conns.size;
    }
    return {
      users: this.userConnections.size,
      sessions: this.sessions.size,
      connections: totalConnections,
    };
  }
}

export const connectionRegistry = new ConnectionRegistry();
