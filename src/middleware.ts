import type { MiddlewareHandler } from 'hono';
import { verifyJWT } from './lib/jwt';
import type { Env, AuthUser } from './types';

// Validates the wokspec_session cookie and injects the user into context.
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
      .prepare('SELECT id, email, username, display_name, avatar_url, role, org FROM users WHERE id = ?')
      .bind(payload.sub)
      .first() as unknown as AuthUser;
    if (!row) return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'User not found', status: 401 } }, 401);

    c.set('user', row);
    await next();
  };

/**
 * KV-backed rate limiter for Cloudflare Workers.
 * Uses a fixed-window counter with expiration.
 */
export const rateLimit = (prefix: string, limit = 60, windowSeconds = 60): MiddlewareHandler<{ Bindings: Env }> =>
  async (c, next) => {
    const kv = c.env.OAUTH_STATE;
    if (!kv) return await next();

    const ip = c.req.header('cf-connecting-ip') ?? '127.0.0.1';
    // Bucketed key for fixed window: rl:prefix:ip:bucket_index
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rl:${prefix}:${ip}:${bucket}`;

    const count = await kv.get(key);
    const current = count ? parseInt(count, 10) : 0;

    if (current >= limit) {
      c.header('Retry-After', windowSeconds.toString());
      return c.json({
        data: null,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Rate limit exceeded. Please try again later.',
          status: 429
        }
      }, 429);
    }

    // Increment and set TTL. Expiration should be slightly longer than the window.
    await kv.put(key, (current + 1).toString(), { expirationTtl: Math.max(60, windowSeconds * 2) });

    await next();
  };
