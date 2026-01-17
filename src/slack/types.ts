export interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
  userId: string; // User to auto-invite to channels
}
