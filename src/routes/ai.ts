import { Hono } from 'hono';
import type { Env, AuthUser } from '../types';
import { requireAuth, rateLimit } from '../middleware';

const ai = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// Proxy AI requests to Eral
// The target URL should be configured via env, defaulting to Eral's public API
const ERAL_API_URL = 'https://eral.wokspec.org/api/v1/ai';

ai.all('/*', rateLimit('ai'), requireAuth(), async (c) => {
  const user = c.get('user');
  const path = c.req.path.replace('/v1/ai', '');
  const targetUrl = `${c.env.ERAL_API_URL ?? ERAL_API_URL}${path}`;

  const method = c.req.method;
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-WokSpec-User-Id', user.id);
  headers.set('X-WokSpec-Email', user.email ?? '');
  // Do not forward the original host or cookie
  headers.delete('Host');
  headers.delete('Cookie');
  headers.set('Authorization', `Bearer ${c.env.JWT_SECRET}`); // Internal service-to-service auth if needed

  try {
    const res = await fetch(targetUrl, {
      method,
      headers,
      body: c.req.raw.body,
      redirect: 'manual',
    });

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  } catch (e) {
    return c.json({ data: null, error: { code: 'UPSTREAM_ERROR', message: 'AI service unreachable', status: 502 } }, 502);
  }
});

export { ai as aiRouter };
