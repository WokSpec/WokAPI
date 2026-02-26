// WokAPI — canonical product registry and status aggregator for WokSpec
// Spec: .wok/specs/wokapi-v1.yaml

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ── Product registry ─────────────────────────────────────────────────────────

interface WokProduct {
  slug: string;
  name: string;
  description: string;
  url: string;
  health_url: string;
  status: 'live' | 'beta' | 'archived';
  tags: string[];
}

const PRODUCTS: WokProduct[] = [
  {
    slug: 'wokgen',
    name: 'WokGen',
    description: 'AI-powered asset generator for brands and creators.',
    url: 'https://wokgen.wokspec.org',
    health_url: 'https://wokgen.wokspec.org/api/health',
    status: 'live',
    tags: ['ai', 'generation', 'assets'],
  },
  {
    slug: 'chopsticks',
    name: 'Chopsticks',
    description: 'Multi-feature Discord bot for communities and servers.',
    url: 'https://chopsticks.wokspec.org',
    health_url: 'https://chopsticks.wokspec.org',
    status: 'live',
    tags: ['discord', 'bot', 'community'],
  },
  {
    slug: 'wokpost',
    name: 'WokPost',
    description: 'AI-curated news and media publishing platform.',
    url: 'https://wokpost.wokspec.org',
    health_url: 'https://wokpost.wokspec.org',
    status: 'live',
    tags: ['ai', 'news', 'media'],
  },
];

// ── Health types ─────────────────────────────────────────────────────────────

interface HealthCheck {
  slug: string;
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  latency_ms: number | null;
  checked_at: string;
  detail?: string;
}

// ── Probe helper ─────────────────────────────────────────────────────────────

async function probe(product: WokProduct): Promise<HealthCheck> {
  const checked_at = new Date().toISOString();
  const start = Date.now();
  try {
    const res = await fetch(product.health_url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'WokAPI-HealthCheck/1.0' },
    });
    const latency_ms = Date.now() - start;
    if (res.ok) return { slug: product.slug, status: 'ok', latency_ms, checked_at };
    if (res.status >= 500) {
      return { slug: product.slug, status: 'down', latency_ms, checked_at, detail: `HTTP ${res.status}` };
    }
    return { slug: product.slug, status: 'degraded', latency_ms, checked_at, detail: `HTTP ${res.status}` };
  } catch (err) {
    const latency_ms = Date.now() - start;
    const detail = err instanceof Error ? err.message.slice(0, 120) : 'Unreachable';
    return { slug: product.slug, status: 'down', latency_ms, checked_at, detail };
  }
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use(
  '*',
  cors({
    origin: ['https://wokspec.org', 'https://www.wokspec.org'],
    allowMethods: ['GET', 'OPTIONS'],
  }),
);

// GET / — service info
app.get('/', (c) =>
  c.json({
    name: 'WokAPI',
    version: '1',
    description: 'WokSpec platform API — product registry and status.',
    docs: 'https://wokspec.org/docs',
    status: 'https://api.wokspec.org/v1/status',
    projects: 'https://api.wokspec.org/v1/projects',
  }),
);

// GET /health — fast health check (no external calls)
app.get('/health', (c) =>
  c.json({ ok: true, ts: new Date().toISOString() }),
);

// GET /v1/projects — product registry
app.get('/v1/projects', (c) =>
  c.json({ ok: true, projects: PRODUCTS }),
);

// GET /v1/projects/:slug — single product
app.get('/v1/projects/:slug', (c) => {
  const product = PRODUCTS.find((p) => p.slug === c.req.param('slug'));
  if (!product) return c.json({ ok: false, error: 'Not found' }, 404);
  return c.json({ ok: true, project: product });
});

// GET /v1/status — aggregate health across all products
app.get('/v1/status', async (c) => {
  const checks = await Promise.all(PRODUCTS.map(probe));
  const anyDown = checks.some((ch) => ch.status === 'down');
  const anyDegraded = checks.some((ch) => ch.status === 'degraded');
  const overallStatus: 'ok' | 'degraded' | 'down' = anyDown
    ? 'down'
    : anyDegraded
    ? 'degraded'
    : 'ok';

  return c.json(
    { ok: !anyDown, status: overallStatus, ts: new Date().toISOString(), checks },
    anyDown ? 503 : 200,
  );
});

// GET /v1/status/:slug — single product status
app.get('/v1/status/:slug', async (c) => {
  const product = PRODUCTS.find((p) => p.slug === c.req.param('slug'));
  if (!product) return c.json({ ok: false, error: 'Not found' }, 404);
  const check = await probe(product);
  return c.json(
    { ok: check.status === 'ok', ...check },
    check.status === 'down' ? 503 : 200,
  );
});

export default app;
