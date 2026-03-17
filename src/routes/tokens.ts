import { Hono } from 'hono';
import type { Env, AuthUser, ApiKeyMeta } from '../types';
import { requireAuth, rateLimit } from '../middleware';
import { getTierLimits, isUnlimited } from '../lib/tiers';

const tokens = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const KEY_PREFIX_LIVE = 'wok_live_';
const KEY_PREFIX_TEST = 'wok_test_';

function generateRawToken(environment: 'live' | 'test'): string {
  const prefix = environment === 'live' ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex}`;
}

async function hashToken(raw: string): Promise<string> {
  const encoded = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function keyPrefix(raw: string): string {
  // Return first 16 chars for display (wok_live_a1b2c3d4)
  return raw.slice(0, 16);
}

// ── GET /v1/tokens — list user's API keys ─────────────────────────────────────
tokens.get('/', rateLimit('tokens'), requireAuth(), async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB
    .prepare(`
      SELECT k.id, k.name, k.key_prefix, k.environment, k.scopes,
             k.last_used_at, k.revoked_at, k.created_at,
             COALESCE(u.request_count, 0) as usage_this_month
      FROM api_keys k
      LEFT JOIN api_usage u ON u.key_id = k.id AND u.month = strftime('%Y-%m', 'now')
      WHERE k.user_id = ?
      ORDER BY k.created_at DESC
    `)
    .bind(user.id)
    .all();

  const limits = getTierLimits(user.plan);
  return c.json({
    data: {
      keys: rows.results,
      plan: user.plan,
      limits: {
        maxKeys: limits.maxApiKeys,
        requestsPerMonth: limits.requestsPerMonth,
        requestsPerMinute: limits.requestsPerMinute,
        scopes: limits.scopes,
      },
    },
    error: null,
  });
});

// ── POST /v1/tokens — create a new API key ────────────────────────────────────
tokens.post('/', rateLimit('tokens'), requireAuth(), async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    name?: string;
    scopes?: string[];
    environment?: 'live' | 'test';
  }>().catch(() => ({ name: undefined, scopes: undefined, environment: undefined }));

  const name = body.name?.trim();
  if (!name || name.length < 1 || name.length > 64) {
    return c.json({ data: null, error: { code: 'INVALID_REQUEST', message: 'Key name required (1–64 chars)', status: 400 } }, 400);
  }

  const environment = body.environment === 'test' ? 'test' : 'live';
  const limits = getTierLimits(user.plan);

  // Enforce max keys per tier
  if (limits.maxApiKeys !== -1) {
    const count = await c.env.DB
      .prepare('SELECT COUNT(*) as n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL')
      .bind(user.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= limits.maxApiKeys) {
      return c.json({
        data: null,
        error: {
          code: 'LIMIT_EXCEEDED',
          message: `Your ${user.plan} plan allows a maximum of ${limits.maxApiKeys} active API keys`,
          status: 403,
        },
      }, 403);
    }
  }

  // Validate requested scopes against tier
  const requestedScopes: string[] = Array.isArray(body.scopes) ? body.scopes : ['read'];
  const allowedScopes = limits.scopes;
  const invalidScopes = requestedScopes.filter((s: string) => !allowedScopes.includes(s));
  if (invalidScopes.length > 0) {
    return c.json({
      data: null,
      error: {
        code: 'INVALID_SCOPES',
        message: `Scopes not available on your plan: ${invalidScopes.join(', ')}`,
        status: 403,
      },
    }, 403);
  }

  const raw = generateRawToken(environment);
  const hash = await hashToken(raw);
  const prefix = keyPrefix(raw);
  const scopes = requestedScopes.join(',');

  await c.env.DB
    .prepare(`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, environment, scopes)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(user.id, name, hash, prefix, environment, scopes)
    .run();

  const created = await c.env.DB
    .prepare('SELECT id, name, key_prefix, environment, scopes, created_at FROM api_keys WHERE key_hash = ?')
    .bind(hash)
    .first();

  // The raw token is returned ONCE only — never stored, never recoverable
  return c.json({
    data: {
      ...created,
      token: raw,
      _notice: 'Store this token securely. It will not be shown again.',
    },
    error: null,
  }, 201);
});

// ── POST /v1/tokens/verify — internal M2M token validation ───────────────────
// Used by NQITA, WokStudio, and other internal services to validate a token
// and retrieve its metadata without counting the call as a metered request.
tokens.post('/verify', async (c) => {
  // Optional internal secret guard
  const internalSecret = c.env.INTERNAL_SECRET;
  if (internalSecret) {
    const provided = c.req.header('X-Wok-Internal-Secret');
    if (provided !== internalSecret) {
      return c.json({ valid: false, error: 'invalid_token' }, 401);
    }
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ valid: false, error: 'invalid_token' }, 401);
  }

  const raw = authHeader.slice(7);
  if (!raw.startsWith('wok_live_') && !raw.startsWith('wok_test_')) {
    return c.json({ valid: false, error: 'invalid_token' }, 401);
  }

  const encoded = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const kv = c.env.TOKEN_CACHE ?? c.env.OAUTH_STATE;
  const cacheKey = `token_meta:${hash}`;

  let meta: ApiKeyMeta | null = null;
  const cached = await kv.get(cacheKey, 'json') as ApiKeyMeta | null;
  if (cached) {
    meta = cached;
  } else {
    const row = await c.env.DB
      .prepare(`
        SELECT k.id, k.user_id, k.scopes, k.environment, u.plan
        FROM api_keys k
        JOIN users u ON k.user_id = u.id
        WHERE k.key_hash = ? AND k.is_active = 1
      `)
      .bind(hash)
      .first<{ id: string; user_id: string; scopes: string; environment: 'live' | 'test'; plan: string }>();

    if (!row) {
      return c.json({ valid: false, error: 'invalid_token' }, 401);
    }

    meta = {
      key_id: row.id,
      user_id: row.user_id,
      plan: row.plan as ApiKeyMeta['plan'],
      scopes: row.scopes.split(',').map(s => s.trim()),
      environment: row.environment,
    };

    await kv.put(cacheKey, JSON.stringify(meta), { expirationTtl: 300 });
  }

  return c.json({
    valid: true,
    key_id: meta.key_id,
    user_id: meta.user_id,
    plan: meta.plan,
    scopes: meta.scopes,
    environment: meta.environment,
  });
});

// ── DELETE /v1/tokens/:id — revoke an API key ─────────────────────────────────
tokens.delete('/:id', rateLimit('tokens'), requireAuth(), async (c) => {
  const user = c.get('user');
  const keyId = c.req.param('id');

  const row = await c.env.DB
    .prepare('SELECT id, key_hash FROM api_keys WHERE id = ? AND user_id = ?')
    .bind(keyId, user.id)
    .first<{ id: string; key_hash: string }>();

  if (!row) {
    return c.json({ data: null, error: { code: 'NOT_FOUND', message: 'API key not found', status: 404 } }, 404);
  }

  await c.env.DB
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?")
    .bind(keyId)
    .run();

  // Immediately evict from KV cache so revocation takes effect instantly
  const kv = c.env.TOKEN_CACHE ?? c.env.OAUTH_STATE;
  if (kv) {
    await kv.delete(`token_meta:${row.key_hash}`);
  }

  return c.json({ data: { revoked: true, id: keyId }, error: null });
});

// ── GET /v1/tokens/usage — current month usage ────────────────────────────────
tokens.get('/usage', rateLimit('tokens'), requireAuth(), async (c) => {
  const user = c.get('user');
  const limits = getTierLimits(user.plan);
  const month = new Date().toISOString().slice(0, 7);

  const usage = await c.env.DB
    .prepare(`
      SELECT k.id, k.name, k.key_prefix, COALESCE(u.request_count, 0) as requests
      FROM api_keys k
      LEFT JOIN api_usage u ON u.key_id = k.id AND u.month = ?
      WHERE k.user_id = ? AND k.revoked_at IS NULL
    `)
    .bind(month, user.id)
    .all();

  const totalRequests = (usage.results as Array<{ requests: number }>)
    .reduce((sum, r) => sum + r.requests, 0);

  return c.json({
    data: {
      month,
      total_requests: totalRequests,
      limit: limits.requestsPerMonth,
      unlimited: isUnlimited(user.plan),
      percent_used: isUnlimited(user.plan) ? null : Math.round((totalRequests / limits.requestsPerMonth) * 100),
      by_key: usage.results,
    },
    error: null,
  });
});

export { tokens as tokensRouter };
