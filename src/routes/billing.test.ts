import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { billingRouter } from './billing';

// Mock dependencies
vi.mock('../lib/resend', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  bookingConfirmEmail: vi.fn().mockReturnValue('mock-html'),
}));

// Mock requireAuth middleware to inject a user
vi.mock('../middleware', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../middleware')>();
  return {
    ...mod,
    requireAuth: () => async (c: any, next: any) => {
      c.set('user', { id: 'user-123', email: 'test@example.com' });
      await next();
    },
    rateLimit: () => async (c: any, next: any) => await next(), // Bypass rate limit
  };
});

function makeApp() {
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  app.route('/v1/billing', billingRouter);
  app.route('/v1/bookings', billingRouter);
  return app;
}

const mockD1 = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  run: vi.fn().mockResolvedValue({ success: true }),
  first: vi.fn().mockResolvedValue(null),
  all: vi.fn().mockResolvedValue({ results: [] }),
};

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
};

describe('POST /v1/billing/checkout', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a stripe checkout session', async () => {
    const app = makeApp();
    const mockSession = { id: 'sess_123', url: 'https://checkout.stripe.com/...' };
    
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockSession,
    });

    const res = await app.request('/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ type: 'consultation' }),
    }, {
      STRIPE_SECRET_KEY: 'sk_test_123',
      D1_MAIN: mockD1,
      KV_SESSIONS: mockKV,
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ data: { checkoutUrl: string } }>();
    expect(body.data.checkoutUrl).toBe(mockSession.url);
    expect(mockD1.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO consultation_bookings'));
  });

  it('works via /v1/bookings alias', async () => {
    const app = makeApp();
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'sess_abc', url: 'https://...' }),
    });

    const res = await app.request('/v1/bookings/checkout', {
      method: 'POST',
      body: JSON.stringify({ type: 'consultation' }),
    }, {
      STRIPE_SECRET_KEY: 'sk_test',
      D1_MAIN: mockD1,
      KV_SESSIONS: mockKV,
    });
    expect(res.status).toBe(200);
  });

  it('handles stripe errors', async () => {
    const app = makeApp();
    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Stripe error' } }),
    });

    const res = await app.request('/v1/billing/checkout', {
      method: 'POST',
    }, {
      STRIPE_SECRET_KEY: 'sk_test_123',
      D1_MAIN: mockD1,
      KV_SESSIONS: mockKV,
    });

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('STRIPE_ERROR');
  });
});

describe('POST /v1/billing/webhook', () => {
  it('returns 500 if webhook secret is missing', async () => {
    const app = makeApp();
    const res = await app.request('/v1/billing/webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'test' }),
      headers: { 'stripe-signature': 't=123,v1=sig' },
    }, {
      // No STRIPE_WEBHOOK_SECRET
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('CONFIG_ERROR');
  });

  it('returns 400 on invalid signature', async () => {
    const app = makeApp();
    const res = await app.request('/v1/billing/webhook', {
      method: 'POST',
      body: 'raw-body',
      headers: { 'stripe-signature': 't=123,v1=bad-sig' },
    }, {
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('EXPIRED_SIGNATURE');
  });
});

