import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from './index';

describe('WokAPI Registry & Health', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /v1/projects returns the product list', async () => {
    const res = await app.request('/v1/projects');
    expect(res.status).toBe(200);
    const body = await res.json<{ projects: any[] }>();
    expect(body.projects.length).toBeGreaterThan(0);
    expect(body.projects.find(p => p.slug === 'wokgen')).toBeDefined();
  });

  it('GET /v1/status aggregates health correctly', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
    });

    const res = await app.request('/v1/status');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { overall: string; checks: any[] } }>();
    expect(body.data.overall).toBe('ok');
    expect(body.data.checks.length).toBeGreaterThan(0);
  });

  it('GET /v1/status reports "down" if a product is unreachable', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('Unreachable'));

    const res = await app.request('/v1/status');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { overall: string } }>();
    expect(body.data.overall).toBe('down');
  });
});
