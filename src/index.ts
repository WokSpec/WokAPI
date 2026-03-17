// WokAPI — canonical product registry and status aggregator for WokSpec

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRouter } from './routes/auth';
import { aiRouter } from './routes/ai';
import { billingRouter } from './routes/billing';
import { tokensRouter } from './routes/tokens';
import { OPENAPI_SPEC } from './lib/openapi-spec';

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
    slug: 'wokspec',
    name: 'WokSpec',
    description: 'Main WokSpec web platform and landing site.',
    url: 'https://wokspec.org',
    health_url: 'https://wokspec.org',
    status: 'live',
    tags: ['web', 'platform'],
  },
  {
    slug: 'studio',
    name: 'Studio',
    description: 'AI-powered asset generator for brands and creators.',
    url: 'https://studio.wokspec.org',
    health_url: 'https://studio.wokspec.org/api/health',
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
    slug: 'orinadus',
    name: 'Orinadus',
    description: 'AI-powered research and author intelligence platform.',
    url: 'https://orinadus.wokspec.org',
    health_url: 'https://orinadus.wokspec.org',
    status: 'live',
    tags: ['ai', 'research', 'intelligence'],
  },
  {
    slug: 'nqita',
    name: 'NQITA',
    description: 'AI layer that integrates across all WokSpec products and external sites.',
    url: 'https://nqita.wokspec.org',
    health_url: 'https://nqita.wokspec.org',
    status: 'live',
    tags: ['ai', 'assistant', 'integration'],
  },
  {
    slug: 'studio',
    name: 'WokStudio',
    description: 'AI creator studio for images, video, and media generation workflows.',
    url: 'https://studio.wokspec.org',
    health_url: 'https://studio.wokspec.org/api/health',
    status: 'live',
    tags: ['ai', 'generation', 'creative'],
  },
];

// ── Health types ─────────────────────────────────────────────────────────────

interface HealthCheck {
  slug: string;
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  latencyMs: number | null;
  checkedAt: string;
  detail?: string;
}

// ── Probe helper ─────────────────────────────────────────────────────────────

async function probe(product: WokProduct): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString();
  const start = Date.now();
  try {
    const res = await fetch(product.health_url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'WokAPI-HealthCheck/1.0' },
    });
    const latencyMs = Date.now() - start;
    if (res.ok) return { slug: product.slug, status: 'ok', latencyMs, checkedAt };
    if (res.status >= 500) {
      return { slug: product.slug, status: 'down', latencyMs, checkedAt, detail: `HTTP ${res.status}` };
    }
    return { slug: product.slug, status: 'degraded', latencyMs, checkedAt, detail: `HTTP ${res.status}` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const detail = err instanceof Error ? err.message.slice(0, 120) : 'Unreachable';
    return { slug: product.slug, status: 'down', latencyMs, checkedAt, detail };
  }
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use(
  '*',
  cors({
    origin: [
      'https://wokspec.org',
      'https://www.wokspec.org',
      'https://studio.wokspec.org',
      'https://orinadus.wokspec.org',
      'https://nqita.wokspec.org',
      'https://chopsticks.wokspec.org',
      'https://dashboard.wokspec.org',
      'https://partners.wokspec.org',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

app.route('/v1/auth', authRouter);
app.route('/v1/ai', aiRouter);
app.route('/v1/billing', billingRouter);
app.route('/v1/bookings', billingRouter);
app.route('/v1/tokens', tokensRouter);

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
    <p class="sub">Platform API for WokSpec — product registry, AI services, and real-time status.</p>
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
      <a class="ep" href="/v1/ai/chat">
        <span class="method">POST</span>
        <span class="path">/v1/ai/chat</span>
        <span class="desc">AI Proxy</span>
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
    description: 'WokSpec platform API — product registry, AI services, and status.',
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
  const isDown = checks.some((chk) => chk.status === 'down');
  const isDegraded = checks.some((chk) => chk.status === 'degraded');
  const overall = isDown ? 'down' : isDegraded ? 'degraded' : 'ok';
  return c.json({ data: { overall, checks }, error: null });
});

// GET /v1/status/:slug — single product status
app.get('/v1/status/:slug', async (c) => {
  const product = PRODUCTS.find((p) => p.slug === c.req.param('slug'));
  if (!product) return c.json({ ok: false, error: 'Not found' }, 404);
  const check = await probe(product);
  return c.json(
    { data: check, error: null },
    check.status === 'down' ? 503 : 200,
  );
});

// GET /docs — Scalar API documentation UI
app.get('/docs', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WokAPI Docs</title>
</head>
<body>
  <script id="api-reference" data-url="https://api.wokspec.org/openapi.yaml"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`);
});

// GET /openapi.yaml — serve the OpenAPI spec
app.get('/openapi.yaml', async (c) => {
  // In Workers, we inline the spec as a static string (bundled at deploy time)
  // The spec is at src/openapi.yaml and must be imported as a text asset
  const spec = OPENAPI_SPEC;
  return new Response(spec, {
    headers: { 'Content-Type': 'application/yaml', 'Access-Control-Allow-Origin': '*' },
  });
});

export default app;
