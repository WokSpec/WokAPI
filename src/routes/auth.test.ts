import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authRouter } from './auth';

// Mock the JWT module so /me tests don't need real Web Crypto state
vi.mock('../lib/jwt', () => ({
  signJWT: vi.fn().mockResolvedValue('mock.jwt.token'),
  verifyJWT: vi.fn().mockResolvedValue(null), // default: invalid token
}));

function makeApp() {
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  app.route('/v1/auth', authRouter);
  return app;
}

describe('GET /v1/auth/me', () => {
  it('returns 401 when no session cookie is present', async () => {
    const app = makeApp();
    const res = await app.request('/v1/auth/me');
    expect(res.status).toBe(401);
    const body = await res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
  });

  it('returns 401 when session cookie is invalid', async () => {
    const app = makeApp();
    const req = new Request('http://localhost/v1/auth/me', {
      headers: { cookie: 'wokspec_session=invalid.token.here' },
    });
    // Pass minimal env so c.env.JWT_SECRET doesn't throw (verifyJWT is mocked to return null)
    const res = await app.fetch(req, { JWT_SECRET: 'test-secret' });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('clears the session cookie', async () => {
    const app = makeApp();
    const res = await app.request('/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('wokspec_session=');
    expect(setCookie).toContain('Max-Age=0');
  });
});
