-- Migration 001: API token infrastructure
-- Adds plan tiers, developer API keys, usage metering, and subscription tracking.

-- ── Extend users table ────────────────────────────────────────────────────────
-- plan: 'free' | 'pro' | 'enterprise'
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'
  CHECK(plan IN ('free', 'pro', 'enterprise'));
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN plan_expires_at TEXT;

-- ── Developer API keys ────────────────────────────────────────────────────────
-- key_hash: SHA-256 of the raw token — never store the raw key
-- key_prefix: first 12 chars for display (e.g. wok_live_a1b2)
-- scopes: comma-separated list from: read, write, ai, admin
-- environment: 'live' (production) or 'test' (sandbox, no billing effects)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'live' CHECK(environment IN ('live', 'test')),
  scopes TEXT NOT NULL DEFAULT 'read',
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);

-- ── Monthly usage counters ────────────────────────────────────────────────────
-- Incremented via INSERT OR IGNORE ... ON CONFLICT DO UPDATE using waitUntil()
-- month: 'YYYY-MM' format for easy range queries
CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(key_id, month)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_user_month ON api_usage(user_id, month);

-- ── Stripe subscription records ───────────────────────────────────────────────
-- id is the Stripe subscription ID (sub_xxx)
-- Synced via webhooks: customer.subscription.created/updated/deleted
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete')),
  plan TEXT NOT NULL CHECK(plan IN ('pro', 'enterprise')),
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
