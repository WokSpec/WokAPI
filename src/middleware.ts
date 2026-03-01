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
      .prepare('SELECT id, email, username, display_name, avatar_url FROM users WHERE id = ?')
      .bind(payload.sub)
      .first<AuthUser>();
    if (!row) return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'User not found', status: 401 } }, 401);

    c.set('user', row);
    await next();
  };

// Minimal no-op rate limiter stub (extend with KV counters as needed).
export const rateLimit = (_key: string): MiddlewareHandler<{ Bindings: Env }> =>
  async (_c, next) => { await next(); };
