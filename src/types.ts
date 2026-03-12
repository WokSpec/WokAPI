export interface Env {
  // Auth
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  JWT_SECRET: string;
  ENVIRONMENT?: string;
  // D1 databases
  DB: D1Database;
  D1_MAIN: D1Database;
  D1_AUTH?: D1Database;
  // KV
  OAUTH_STATE: KVNamespace;
  KV_SESSIONS?: KVNamespace;
  // Stripe / email (used by bookings)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  ERAL_API_URL?: string;
}

export interface AuthUser {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}
