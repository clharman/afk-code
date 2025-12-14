import { randomBytes } from 'crypto';

// Simple token-based auth for MVP
// In production, use proper JWT or OAuth

interface User {
  id: string;
  token: string;
  createdAt: Date;
}

class AuthService {
  private users: Map<string, User> = new Map();
  private tokenToUserId: Map<string, string> = new Map();

  generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  createUser(): User {
    const id = randomBytes(16).toString('hex');
    const token = this.generateToken();
    const user: User = { id, token, createdAt: new Date() };

    this.users.set(id, user);
    this.tokenToUserId.set(token, id);

    return user;
  }

  validateToken(token: string): string | null {
    return this.tokenToUserId.get(token) || null;
  }

  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  // For development: create a known test user
  createTestUser(token: string): User {
    const id = 'test-user';
    const user: User = { id, token, createdAt: new Date() };

    this.users.set(id, user);
    this.tokenToUserId.set(token, id);

    return user;
  }
}

export const authService = new AuthService();

// Create a test user for development
authService.createTestUser('test-token-123');
