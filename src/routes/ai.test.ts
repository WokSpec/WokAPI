import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { aiRouter } from './ai';

// Mock requireAuth
vi.mock('../middleware', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../middleware')>();
  return {
    ...mod,
    requireAuth: () => async (c: any, next: any) => {
      c.set('user', { id: 'user-123', email: 'test@example.com' });
      await next();
    },
    rateLimit: () => async (c: any, next: any) => await next(),
  };
});

function makeApp() {
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  app.route('/v1/ai', aiRouter);
  return app;
}

describe('POST /v1/ai/chat', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('proxies requests to ERAL_API_URL', async () => {
    const app = makeApp();
    const mockResponse = { choices: [{ message: { content: 'Hello' } }] };
    
    (globalThis.fetch as any).mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(mockResponse),
    });

    const res = await app.request('/v1/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'hi' }),
    }, {
      ERAL_API_URL: 'https://mock-nikita.api/v1/ai',
      JWT_SECRET: 'secret',
      KV_SESSIONS: { get: vi.fn(), put: vi.fn() },
    });

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://mock-nikita.api/v1/ai/chat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      })
    );
    
    // Check if X-WokSpec headers were added
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get('X-WokSpec-User-Id')).toBe('user-123');
    expect(headers.get('X-WokSpec-Email')).toBe('test@example.com');
  });

  it('returns 502 if upstream fails', async () => {
    const app = makeApp();
    (globalThis.fetch as any).mockRejectedValue(new Error('Network error'));

    const res = await app.request('/v1/ai/chat', {
      method: 'POST',
    }, {
      ERAL_API_URL: 'https://mock-nikita.api/v1/ai',
      JWT_SECRET: 'secret',
      KV_SESSIONS: { get: vi.fn(), put: vi.fn() },
    });

    expect(res.status).toBe(502);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UPSTREAM_ERROR');
  });
});
