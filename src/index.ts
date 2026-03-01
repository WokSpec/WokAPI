// WokAPI — canonical product registry and status aggregator for WokSpec
// Spec: .wok/specs/wokapi-v1.yaml

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRouter } from './routes/auth';

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
  {
    slug: 'eral',
    name: 'Eral',
    description: 'AI layer that integrates across all WokSpec products and external sites.',
    url: 'https://eral.wokspec.org',
    health_url: 'https://eral.wokspec.org/api/v1/status',
    status: 'live',
    tags: ['ai', 'assistant', 'integration'],
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
    origin: ['https://wokspec.org', 'https://www.wokspec.org', 'https://eral.wokspec.org'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
  }),
);

app.route('/v1/auth', authRouter);

// GET / — service info (HTML for browsers, JSON for API clients)
app.get('/', (c) => {
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('text/html')) {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WokAPI</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0a;
      color: #e8e8e8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      max-width: 560px;
      width: 100%;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #22c55e;
      border: 1px solid #22c55e33;
      background: #22c55e0d;
      padding: 3px 10px;
      border-radius: 999px;
      margin-bottom: 1.5rem;
    }
    h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 0.5rem; }
    .sub { color: #888; font-size: 0.95rem; margin-bottom: 2.5rem; line-height: 1.6; }
    .endpoints { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 2.5rem; }
    .ep {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: #141414;
      border: 1px solid #1f1f1f;
      border-radius: 8px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.82rem;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s;
    }
    .ep:hover { border-color: #333; }
    .method { color: #22c55e; font-weight: 700; min-width: 28px; }
    .path { color: #e8e8e8; }
    .desc { color: #555; margin-left: auto; font-family: inherit; font-size: 0.78rem; }
    .footer { color: #444; font-size: 0.8rem; }
    .footer a { color: #666; text-decoration: none; }
    .footer a:hover { color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">v1 · live</span>
    <h1>WokAPI</h1>
    <p class="sub">Platform API for WokSpec — product registry and real-time status for all Wok products.</p>
    <div class="endpoints">
      <a class="ep" href="/health">
        <span class="method">GET</span>
        <span class="path">/health</span>
        <span class="desc">API health</span>
      </a>
      <a class="ep" href="/v1/projects">
        <span class="method">GET</span>
        <span class="path">/v1/projects</span>
        <span class="desc">Product registry</span>
      </a>
      <a class="ep" href="/v1/status">
        <span class="method">GET</span>
        <span class="path">/v1/status</span>
        <span class="desc">Aggregate health</span>
      </a>
    </div>
    <p class="footer">
      <a href="https://wokspec.org">wokspec.org</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/WokSpec/WokAPI">GitHub</a>
    </p>
  </div>
</body>
</html>`);
  }

  return c.json({
    name: 'WokAPI',
    version: '1',
    description: 'WokSpec platform API — product registry and status.',
    docs: 'https://wokspec.org/docs',
    status: 'https://api.wokspec.org/v1/status',
    projects: 'https://api.wokspec.org/v1/projects',
  });
});

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
