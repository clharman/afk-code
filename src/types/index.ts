// Session information
export interface Session {
  id: string;
  name: string;
  cwd: string;
  port: number;
  status: 'running' | 'idle' | 'ended';
  startedAt: Date;
}

// Todo item from Claude Code
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

// Daemon <-> Relay messages
export type DaemonMessage =
  | { type: 'auth'; token: string }
  | { type: 'session_start'; sessionId: string; name: string; cwd: string }
  | { type: 'session_update'; sessionId: string; name?: string }
  | { type: 'session_todos'; sessionId: string; todos: TodoItem[] }
  | { type: 'session_output'; sessionId: string; data: string }
  | { type: 'session_message'; sessionId: string; role: 'user' | 'assistant'; content: string }
  | { type: 'session_status'; sessionId: string; status: 'running' | 'idle' }
  | { type: 'session_end'; sessionId: string };

export type RelayToDaemonMessage =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; message: string }
  | { type: 'send_input'; sessionId: string; text: string }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string };

// Mobile <-> Relay messages
export type MobileMessage =
  | { type: 'auth'; token: string }
  | { type: 'list_sessions' }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'send_input'; sessionId: string; text: string }
  | { type: 'track_session'; sessionId: string }
  | { type: 'untrack_session'; sessionId: string }
  | { type: 'register_push_token'; pushToken: string };

export type RelayToMobileMessage =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; message: string }
  | { type: 'sessions_list'; sessions: Session[] }
  | { type: 'session_update'; sessionId: string; name?: string }
  | { type: 'session_todos'; sessionId: string; todos: TodoItem[] }
  | { type: 'session_output'; sessionId: string; data: string }
  | { type: 'session_message'; sessionId: string; role: 'user' | 'assistant'; content: string }
  | { type: 'session_status'; sessionId: string; status: 'running' | 'idle' | 'ended' };
