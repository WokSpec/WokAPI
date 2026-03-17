import type { MiddlewareHandler } from 'hono';
import { verifyJWT } from './lib/jwt';
import type { Env, AuthUser, ApiKeyMeta } from './types';
import { getTierLimits, isUnlimited } from './lib/tiers';

// ── Session auth (cookie) ─────────────────────────────────────────────────────
export const requireAuth = (): MiddlewareHandler<{ Bindings: Env; Variables: { user: AuthUser } }> =>
  async (c, next) => {
    const cookieHeader = c.req.header('cookie') ?? '';
    const match = cookieHeader.match(/wokspec_session=([^;]+)/);
    const token = match?.[1];
    if (!token) return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated', status: 401 } }, 401);

    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    if (!payload || typeof payload.sub !== 'string') {
      return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid session', status: 401 } }, 401);
    }

    const row = await c.env.DB
      .prepare('SELECT id, email, username, display_name, avatar_url, role, org, plan, stripe_customer_id FROM users WHERE id = ?')
      .bind(payload.sub)
      .first() as unknown as AuthUser;
    if (!row) return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'User not found', status: 401 } }, 401);

    c.set('user', row);
    await next();
  };

// ── API key auth (Bearer token) ───────────────────────────────────────────────
// Validates wok_live_xxx / wok_test_xxx tokens via KV cache → D1 fallback.
// On success, injects both 'user' and 'apiKey' into context.
export const requireApiKey = (): MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: AuthUser; apiKey: ApiKeyMeta };
}> =>
  async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer wok_')) {
      return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Valid API key required (Bearer wok_live_xxx)', status: 401 } }, 401);
    }

    const raw = authHeader.slice(7); // strip 'Bearer '
    const encoded = new TextEncoder().encode(raw);
    const buf = await crypto.subtle.digest('SHA-256', encoded);
    const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

    const kv = c.env.TOKEN_CACHE ?? c.env.OAUTH_STATE;
    const cacheKey = `token_meta:${hash}`;

    // Fast path: KV cache
    let meta: ApiKeyMeta | null = null;
    const cached = await kv.get(cacheKey, 'json') as ApiKeyMeta | null;
    if (cached) {
      meta = cached;
    } else {
      // Slow path: D1 lookup
      const row = await c.env.DB
        .prepare(`
          SELECT k.id, k.user_id, k.scopes, k.environment, k.revoked_at,
                 u.plan
          FROM api_keys k
          JOIN users u ON u.id = k.user_id
          WHERE k.key_hash = ?
        `)
        .bind(hash)
        .first<{
          id: string; user_id: string; scopes: string;
          environment: 'live' | 'test'; revoked_at: string | null; plan: string;
        }>();

      if (!row) {
        return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid API key', status: 401 } }, 401);
      }
      if (row.revoked_at) {
        return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'API key has been revoked', status: 401 } }, 401);
      }

      meta = {
        key_id: row.id,
        user_id: row.user_id,
        plan: row.plan as ApiKeyMeta['plan'],
        scopes: row.scopes.split(',').map(s => s.trim()),
        environment: row.environment,
      };

      // Cache for 5 minutes
      await kv.put(cacheKey, JSON.stringify(meta), { expirationTtl: 300 });
    }

    // Load full user
    const user = await c.env.DB
      .prepare('SELECT id, email, username, display_name, avatar_url, role, org, plan, stripe_customer_id FROM users WHERE id = ?')
      .bind(meta.user_id)
      .first() as unknown as AuthUser;
    if (!user) {
      return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'User not found', status: 401 } }, 401);
    }

    // Update last_used_at + increment monthly usage asynchronously (non-blocking)
    const ctx = c.executionCtx;
    if (ctx?.waitUntil) {
      const month = new Date().toISOString().slice(0, 7);
      ctx.waitUntil(
        Promise.all([
          c.env.DB
            .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
            .bind(meta.key_id)
            .run(),
          c.env.DB
            .prepare(`
              INSERT INTO api_usage (key_id, user_id, month, request_count)
              VALUES (?, ?, ?, 1)
              ON CONFLICT(key_id, month) DO UPDATE SET request_count = request_count + 1
            `)
            .bind(meta.key_id, meta.user_id, month)
            .run(),
        ])
      );
    }

    c.set('user', user);
    c.set('apiKey', meta);

    // Enforce monthly usage limit (skip for enterprise / unlimited)
    if (!isUnlimited(meta.plan)) {
      const limits = getTierLimits(meta.plan);
      const month = new Date().toISOString().slice(0, 7);
      const usage = await c.env.DB
        .prepare('SELECT COALESCE(SUM(request_count), 0) as total FROM api_usage WHERE user_id = ? AND month = ?')
        .bind(meta.user_id, month)
        .first<{ total: number }>();
      if ((usage?.total ?? 0) >= limits.requestsPerMonth) {
        return c.json({
          data: null,
          error: {
            code: 'USAGE_LIMIT_EXCEEDED',
            message: `Monthly request limit of ${limits.requestsPerMonth.toLocaleString()} reached. Upgrade your plan at dashboard.wokspec.org/tokens`,
            status: 429,
          },
        }, 429);
      }
    }

    await next();
  };

// ── Tier-aware rate limiter ───────────────────────────────────────────────────
// Buckets by: API key ID (if present) → user ID → IP address.
// Applies per-minute limits based on the user's plan tier.
export const rateLimit = (routePrefix: string, fallbackLimit = 60, windowSeconds = 60): MiddlewareHandler<{ Bindings: Env }> =>
  async (c, next) => {
    const kv = c.env.OAUTH_STATE;
    if (!kv) return await next();

    // Determine bucket identity + limit from context
    const apiKey = (c.get as (key: string) => unknown)('apiKey') as ApiKeyMeta | undefined;
    const user = (c.get as (key: string) => unknown)('user') as AuthUser | undefined;

    let bucketId: string;
    let limit: number;

    if (apiKey) {
      const tierLimits = getTierLimits(apiKey.plan);
      bucketId = `key:${apiKey.key_id}`;
      limit = tierLimits.requestsPerMinute;
    } else if (user) {
      const tierLimits = getTierLimits(user.plan ?? 'free');
      bucketId = `user:${user.id}`;
      limit = tierLimits.requestsPerMinute;
    } else {
      bucketId = `ip:${c.req.header('cf-connecting-ip') ?? '127.0.0.1'}`;
      limit = fallbackLimit;
    }

    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rl:${routePrefix}:${bucketId}:${bucket}`;

    const count = await kv.get(key);
    const current = count ? parseInt(count, 10) : 0;
    const remaining = Math.max(0, limit - current - 1);
    const resetAt = (Math.floor(Date.now() / 1000 / windowSeconds) + 1) * windowSeconds;

    c.header('X-RateLimit-Limit', limit.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', resetAt.toString());

    if (current >= limit) {
      c.header('Retry-After', windowSeconds.toString());
      return c.json({
        data: null,
        error: { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded. Please try again later.', status: 429 },
      }, 429);
    }

    await kv.put(key, (current + 1).toString(), { expirationTtl: Math.max(60, windowSeconds * 2) });
    await next();
  };

