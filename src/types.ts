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
  // KV namespaces
  OAUTH_STATE: KVNamespace;
  KV_SESSIONS?: KVNamespace;
  TOKEN_CACHE: KVNamespace;  // hot-path cache for API key lookups
  // Stripe / email
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  // Product service URLs
  ERAL_API_URL?: string;
  // Plans (Stripe price IDs)
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_ENTERPRISE_MONTHLY?: string;
}

export interface AuthUser {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role: 'admin' | 'user' | 'client';
  org: string | null;
  plan: 'free' | 'pro' | 'enterprise';
  stripe_customer_id: string | null;
}

export type ApiKeyTier = 'free' | 'pro' | 'enterprise';

export interface ApiKeyMeta {
  key_id: string;
  user_id: string;
  plan: ApiKeyTier;
  scopes: string[];
  environment: 'live' | 'test';
}
