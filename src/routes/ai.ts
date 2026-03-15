import { Hono } from 'hono';
import type { Env, AuthUser } from '../types';
import { requireAuth, rateLimit } from '../middleware';

const ai = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// Proxy AI requests to Eral
// The target URL should be configured via env, defaulting to Eral's public API
const ERAL_API_URL = 'https://eral.wokspec.org/api/v1';

ai.all('/*', rateLimit('ai'), requireAuth(), async (c) => {
  const user = c.get('user');
  const path = c.req.path.replace('/v1/ai', '');
  const targetUrl = `${c.env.ERAL_API_URL ?? ERAL_API_URL}${path}`;

  const method = c.req.method;
  const headers = new Headers();
  
  // Set required headers for Eral
  headers.set('Content-Type', c.req.header('Content-Type') ?? 'application/json');
  headers.set('X-WokSpec-User-Id', user.id);
  headers.set('X-WokSpec-Email', user.email ?? '');
  headers.set('X-Eral-Source', 'wokapi-proxy');

  // Forward the Bearer token for auth. 
  // We extract it from the cookie if it's not already in the Authorization header.
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    headers.set('Authorization', authHeader);
  } else {
    const cookieHeader = c.req.header('cookie') ?? '';
    const match = cookieHeader.match(/wokspec_session=([^;]+)/);
    if (match?.[1]) {
      headers.set('Authorization', `Bearer ${match[1]}`);
    }
  }

  try {
    const res = await fetch(targetUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? null : c.req.raw.body,
      redirect: 'manual',
    });

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  } catch (e) {
    console.error('[WokAPI AI Proxy Error]', e);
    return c.json({ data: null, error: { code: 'UPSTREAM_ERROR', message: 'AI service unreachable', status: 502 } }, 502);
  }
});

export { ai as aiRouter };
