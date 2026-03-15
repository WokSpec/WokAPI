# WokAPI — Agent Reference

> **Critical infrastructure.** WokAPI is the authentication backbone for all WokSpec products. Read this before touching any code. A mistake here can break login for every WokSpec app simultaneously.

---

## Table of Contents

1. [What This Repo Is](#1-what-this-repo-is)
2. [Hard Constraints — Do Not Break](#2-hard-constraints--do-not-break)
3. [Tech Stack](#3-tech-stack)
4. [Repository Layout](#4-repository-layout)
5. [Hono + Cloudflare Workers Patterns](#5-hono--cloudflare-workers-patterns)
6. [OAuth Flow Design](#6-oauth-flow-design)
7. [JWT Structure and Verification](#7-jwt-structure-and-verification)
8. [Product Registry](#8-product-registry)
9. [How Other Apps Authenticate Against WokAPI](#9-how-other-apps-authenticate-against-wokapi)
10. [Route Reference](#10-route-reference)
11. [Database Schema](#11-database-schema)
12. [Environment Variables / Cloudflare Bindings](#12-environment-variables--cloudflare-bindings)
13. [How to Add a New OAuth Provider](#13-how-to-add-a-new-oauth-provider)
14. [How to Add a New Product to the Registry](#14-how-to-add-a-new-product-to-the-registry)
15. [Security Considerations](#15-security-considerations)
16. [Bookings / Stripe Integration](#16-bookings--stripe-integration)
17. [Common Gotchas and Pitfalls](#17-common-gotchas-and-pitfalls)
18. [Commit Conventions](#18-commit-conventions)
19. [CI/CD Notes](#19-cicd-notes)
20. [Agent-Specific Guidance](#20-agent-specific-guidance)

---

## 1. What This Repo Is

**WokAPI** (`api.wokspec.org`) is the **canonical authentication and product registry service** for the entire WokSpec platform. It is a single Cloudflare Worker built with [Hono](https://hono.dev/).

### Responsibilities

1. **OAuth authentication** — handles the full OAuth2 flows for GitHub, Google, and Discord. Issues WokSpec-branded JWTs after successful authentication.
2. **JWT issuance and refresh** — mints short-lived access tokens and long-lived refresh tokens. Manages session persistence via Cloudflare D1 (SQLite).
3. **Product registry** — authoritative list of all WokSpec products (Studio, Chopsticks, WokPost, Eral) with their URLs and health check endpoints.
4. **Aggregate health status** — probes all products and returns a unified `ok | degraded | down` status.
5. **Bookings** — Stripe Checkout for WokSpec consultation slots, with HMAC-verified webhook processing.

### Deployed at

`https://api.wokspec.org` — custom domain on Cloudflare Workers via `wrangler.toml`.

### Cross-Product Auth Contract

Every WokSpec product verifies user identity by presenting a WokSpec JWT (issued by WokAPI) to the appropriate auth middleware. The JWT is set as the `wokspec_session` HTTP-only cookie by WokAPI after a successful OAuth flow. Products read and verify this cookie directly using the shared `JWT_SECRET`.

---

## 2. Hard Constraints — Do Not Break

### 2.1 The `/v1/me` Contract

**THIS IS THE MOST CRITICAL CONSTRAINT IN THE ENTIRE REPO.**

All WokSpec apps that need to verify user identity call `GET /v1/auth/me` (or verify the `wokspec_session` cookie locally using the shared JWT secret). The response shape and the JWT payload structure are the cross-app contract. **Any change to these WILL break every downstream product.**

Protected fields in the JWT payload (Canonical):
- `sub` — the user's canonical ID (UUID hex)
- `email` — user's verified email
- `username` — user's handle
- `display_name` — display name
- `avatar_url` — avatar URL
- `role` — 'admin' | 'user' | 'client'
- `org` — organization identifier or null
- `iss` — 'https://api.wokspec.org'
- `aud` — 'https://wokspec.org'
- `iat` — issued-at timestamp
- `exp` — expiry timestamp

Do not remove, rename, or change the type of any of these claims.

### 2.2 CORS Allowlist

CORS origins are an explicit allowlist in `src/index.ts`:
```typescript
origin: ['https://wokspec.org', 'https://www.wokspec.org', 'https://eral.wokspec.org'],
```

**Never replace this with a wildcard `*`** — doing so would allow any website to make credentialed requests to WokAPI and potentially steal session cookies.

To add a new origin, append it to the array. Do not use regex patterns or dynamic origins.

### 2.3 OAuth State Validation (CSRF Protection)

Every OAuth flow stores a nonce-bearing state in Cloudflare KV (`KV_SESSIONS`) with a 5-minute TTL. The callback handler validates this state before proceeding. **Never skip or weaken the state validation.** Removing it opens WokAPI to CSRF attacks that could sign users into attacker-controlled accounts.

### 2.4 JWT Signing Secret

The `JWT_SECRET` Cloudflare Worker secret is the **shared secret** between WokAPI and all WokSpec products. Rotating it invalidates all active user sessions across the entire platform simultaneously. Never commit it, log it, or expose it in responses.

### 2.5 Redirect Destination Validation

OAuth redirects are validated against `ALLOWED_REDIRECT_ORIGINS` in `src/routes/auth.ts`. Any `redirect_to` parameter that doesn't match the allowlist is silently replaced with `https://wokspec.org`. Never allow arbitrary `redirect_to` URLs.

### 2.6 Stripe Webhook HMAC

The bookings webhook at `POST /v1/bookings/webhook` verifies the Stripe signature using HMAC-SHA256 before processing any event. Do not process webhook payloads without this verification.

---

## 3. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Cloudflare Workers | Edge runtime, no Node.js built-ins by default |
| Framework | Hono | Lightweight router designed for edge runtimes |
| Language | TypeScript | Compiled by `wrangler` build |
| Auth | Custom JWT (HMAC-SHA256) | Web Crypto API — no external JWT lib |
| Validation | Zod + @hono/zod-validator | Schema validation for request bodies |
| Storage: sessions | Cloudflare D1 (SQLite) | `DB` binding for auth, `D1_MAIN` for app data |
| Storage: OAuth state | Cloudflare KV | `OAUTH_STATE` binding, 5-min TTL nonces |
| Email | Resend | Used by bookings confirmation |
| Payments | Stripe | Checkout + webhook for consultation bookings |
| Compatibility | `nodejs_compat` flag | Enables Node.js API polyfills in Workers |
| Deploy | `wrangler deploy` | Custom domain: `api.wokspec.org` |

**Cloudflare Workers limitations to be aware of:**
- No filesystem access
- No `process.env` — use `c.env.*` (Cloudflare bindings)
- `fetch()` is the native HTTP client (no `node-fetch`, `axios`, etc.)
- CPU time limit per request (50ms for free, 30s on paid plan)
- Crypto is available via `crypto.subtle` (Web Crypto API)

---

## 4. Repository Layout

```
WokAPI/
├── src/
│   ├── index.ts              # Hono app, CORS, product registry, health, main routes
│   ├── middleware.ts         # requireAuth() — JWT cookie validation; rateLimit() stub
│   ├── types.ts              # Env interface (Cloudflare bindings), AuthUser type
│   ├── routes/
│   │   ├── auth.ts           # GitHub/Google/Discord OAuth + JWT issuance (480 lines)
│   │   ├── auth.test.ts      # Auth route tests
│   │   └── bookings.ts       # Stripe Checkout + HMAC-verified webhook
│   ├── lib/
│   │   ├── constants.ts      # CONSULTATION_PRICE_CENTS and other shared constants
│   │   ├── jwt.ts            # signJWT / verifyJWT — pure HMAC-SHA256 via Web Crypto
│   │   └── resend.ts         # Email sending (booking confirmation)
│   └── db/
│       └── schema.sql        # Cloudflare D1 schema (users, oauth_accounts, sessions)
├── .github/
│   ├── workflows/ci-cd.yml   # CI (typecheck, test) + deploy on push to main
│   ├── CODEOWNERS
│   ├── dependabot.yml
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── wrangler.toml             # Cloudflare Workers deploy config
├── tsconfig.json
└── package.json
```

---

## 5. Hono + Cloudflare Workers Patterns

### App Setup

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// CORS must be applied before all routes
app.use('*', cors({ origin: [...EXPLICIT_ALLOWLIST], credentials: true }));

// Mount sub-routers
app.route('/v1/auth', authRouter);
app.route('/v1/bookings', bookingsRouter);
```

### Accessing Bindings

Cloudflare bindings (D1, KV, secrets) are accessed via `c.env`:

```typescript
// D1 query
const row = await c.env.DB
  .prepare('SELECT id, email FROM users WHERE id = ?')
  .bind(userId)
  .first<{ id: string; email: string }>();

// KV read/write
await c.env.OAUTH_STATE.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });
const val = await c.env.OAUTH_STATE.get(`oauth_state:${state}`);

// Accessing secrets
const secret = c.env.JWT_SECRET;
```

### Context Variables

Inject middleware-derived values into context:

```typescript
// In middleware
c.set('user', row);

// In downstream handler
const user = c.get('user'); // AuthUser
```

### Response Patterns

```typescript
// JSON success
return c.json({ data: result, error: null });

// JSON error (typed error shape)
return c.json({
  data: null,
  error: { code: 'INVALID_STATE', message: 'Invalid OAuth state', status: 400 }
}, 400);

// Redirect
return c.redirect(url.toString());
```

### TypeScript Generics

Always parameterize Hono with the Env and Variables types:

```typescript
const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
```

---

## 6. OAuth Flow Design

WokAPI implements the Authorization Code flow for all three providers. The flow is identical across providers:

### Flow Steps

```
1. Client → GET /v1/auth/{provider}?redirect_to=https://studio.wokspec.org
2. WokAPI: validate redirect_to against ALLOWED_REDIRECT_ORIGINS
3. WokAPI: generate state = btoa(JSON.stringify({ redirectTo, redirectExtension, nonce: uuid }))
4. WokAPI: store state in KV with 5-min TTL
5. WokAPI: redirect → {provider OAuth URL}?state={state}&...
6. User authenticates with provider
7. Provider → GET /v1/auth/{provider}/callback?code={code}&state={state}
8. WokAPI: validate state (KV lookup, then delete to prevent replay)
9. WokAPI: exchange code for access token with provider
10. WokAPI: fetch user profile from provider API
11. WokAPI: upsert user in D1 (users + oauth_accounts tables)
12. WokAPI: issue JWT access token + refresh token
13. WokAPI: set HTTP-only cookies, redirect to redirect_to
```

### Redirect Extension Mode

When `redirect_extension=true` is passed, tokens are appended as URL params to the callback URL instead of set as cookies. This supports the Eral browser extension and any cross-origin integration where cookies cannot be shared:

```
redirect_to=https://eral.wokspec.org/auth/callback?accessToken=...&refreshToken=...
```

This is also used when `redirect_to` is a non-`wokspec.org` origin (e.g., `eral.wokspec.org`).

### State Parameter Structure

```typescript
interface OAuthState {
  redirectTo: string;       // Validated redirect destination
  redirectExtension: boolean; // Whether to pass tokens in URL params
  nonce: string;            // crypto.randomUUID() — prevents state reuse
}
```

### Providers

| Provider | Scopes | Email fetch |
|----------|--------|-------------|
| GitHub | `read:user user:email` | Falls back to `/user/emails` if profile email is null |
| Google | `openid email profile` | Always available in ID token userinfo |
| Discord | `identify email` | Required — returns 400 if no verified email |

---

## 7. JWT Structure and Verification

### Algorithm

**HS256** (HMAC-SHA256) using the Web Crypto API. Implementation in `src/lib/jwt.ts` — no external JWT library. The implementation is minimal but complete: signs, verifies, and checks `exp`.

### Token Lifecycle

| Token | TTL | Storage |
|-------|-----|---------|
| Access token | Short-lived (configured in constants) | `wokspec_session` HTTP-only cookie |
| Refresh token | Long-lived (configured in constants) | `wokspec_refresh` HTTP-only cookie, hash stored in D1 `sessions` table |

### JWT Payload Claims

```typescript
{
  sub: string;         // User ID (hex UUID from D1)
  email: string;       // Verified email
  username: string;    // User handle
  display_name: string; // Display name from OAuth provider
  avatar_url: string | null; // Avatar URL
  role: 'admin' | 'user' | 'client';
  org: string | null;  // Organization identifier
  iss: 'https://api.wokspec.org';
  aud: 'https://wokspec.org';
  iat: number;         // Issued at (Unix seconds)
  exp: number;         // Expiry (Unix seconds)
}
```

**DO NOT add or remove claims without updating all WokSpec apps that verify these tokens.**

### Cookie Names and Paths

```typescript
wokspec_session   // Access token — Path=/, HttpOnly, Secure, SameSite=Lax
wokspec_refresh   // Refresh token — Path=/v1/auth, HttpOnly, Secure, SameSite=Lax
```

The refresh token cookie is scoped to `/v1/auth` so it's only sent to WokAPI, never to other origins.

### Token Refresh Flow

1. Client sends `POST /v1/auth/refresh` (cookie or JSON body for extension)
2. WokAPI hashes the refresh token and looks it up in D1 `sessions` table
3. Verifies `expiresAt` > now
4. Fetches user from D1
5. **Rotates** the refresh token (deletes old session, creates new one)
6. Returns new access + refresh tokens

### Signing / Verifying

```typescript
import { signJWT, verifyJWT } from './lib/jwt';

// Sign
const token = await signJWT({ sub: user.id, email, display_name, exp: ... }, env.JWT_SECRET);

// Verify (returns null if invalid or expired)
const payload = await verifyJWT(token, env.JWT_SECRET);
if (!payload || typeof payload.sub !== 'string') {
  return c.json({ error: 'Unauthorized' }, 401);
}
```

---

## 8. Product Registry

The product registry is a static array in `src/index.ts`. It is the authoritative list of all WokSpec products.

### Product Shape

```typescript
interface WokProduct {
  slug: string;        // Unique identifier, e.g.  "studio"
  name: string;        // Display name
  description: string; // Short description
  url: string;         // Product URL
  health_url: string;  // Health check endpoint (polled by /v1/status)
  status: 'live' | 'beta' | 'archived';
  tags: string[];      // e.g. ['ai', 'generation', 'assets']
}
```

### Current Products

| Slug | Name | URL | Status |
|------|------|-----|--------|
| `wokgen` | Studio | studio.wokspec.org | live |
| `chopsticks` | Chopsticks | chopsticks.wokspec.org | live |
| `wokhei` | WokHei | hei.wokspec.org | live |
| `eral` | Eral | eral.wokspec.org | live |

### Health Probing

`GET /v1/status` calls all health URLs concurrently with a 5-second `AbortSignal.timeout`. The aggregate status is:
- `ok` — all products returned 2xx
- `degraded` — some returned 4xx/5xx
- `down` — at least one is unreachable or returned 5xx

### API Routes

```
GET /v1/projects        → full registry list
GET /v1/projects/:slug  → single product
GET /v1/status          → aggregate health (probes all health_url endpoints)
GET /v1/status/:slug    → single product health
GET /health             → fast WokAPI self-health (no external calls)
```

---

## 9. How Other Apps Authenticate Against WokAPI

### Method 1: Cookie-based (web apps)

After the OAuth flow, WokAPI sets `wokspec_session` and `wokspec_refresh` cookies on the response. Web apps within `*.wokspec.org` receive these cookies automatically (SameSite=Lax means the cookies travel on top-level cross-site navigations but not on AJAX).

To verify a user in a downstream app (e.g., Studio's middleware):

```typescript
// Extract the wokspec_session cookie
const token = getCookieValue(c.req.header('cookie'), 'wokspec_session');

// Verify using the shared JWT_SECRET
const payload = await verifyJWT(token, env.JWT_SECRET); // Use WokAPI's lib/jwt.ts
if (!payload) return unauthorized();

// payload.sub = user ID, payload.email = email, etc.
```

### Method 2: Extension / Cross-Origin (redirect_extension=true)

The Eral browser extension and similar cross-origin integrations receive tokens as URL parameters at their callback URL. They store tokens locally and present the access token as a bearer token or cookie on subsequent requests.

### The `requireAuth()` Middleware

Within WokAPI itself, the `requireAuth()` middleware in `src/middleware.ts` validates the `wokspec_session` cookie and injects the DB user into context:

```typescript
import { requireAuth } from '../middleware';

router.post('/protected-route', requireAuth(), async (c) => {
  const user = c.get('user'); // AuthUser: { id, email, username, display_name, avatar_url }
});
```

---

## 10. Route Reference

### Auth Routes (`/v1/auth/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/auth/github` | Initiate GitHub OAuth |
| `GET` | `/v1/auth/github/callback` | GitHub OAuth callback |
| `GET` | `/v1/auth/google` | Initiate Google OAuth |
| `GET` | `/v1/auth/google/callback` | Google OAuth callback |
| `GET` | `/v1/auth/discord` | Initiate Discord OAuth |
| `GET` | `/v1/auth/discord/callback` | Discord OAuth callback |
| `POST` | `/v1/auth/refresh` | Rotate refresh token, issue new access token |
| `POST` | `/v1/auth/logout` | Invalidate session, clear cookies |

### Product Registry Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/projects` | None | Full product registry |
| `GET` | `/v1/projects/:slug` | None | Single product info |
| `GET` | `/v1/status` | None | Aggregate health check |
| `GET` | `/v1/status/:slug` | None | Single product health |

### Bookings Routes (`/v1/bookings/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/bookings/checkout` | Required | Create Stripe Checkout session |
| `POST` | `/v1/bookings/webhook` | Stripe sig | Stripe webhook (HMAC-SHA256 verified) |

### Utility

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Fast self-health |
| `GET` | `/` | None | HTML landing (browsers) or JSON (API clients) |

---

## 11. Database Schema

WokAPI uses **Cloudflare D1** (SQLite). Schema in `src/db/schema.sql`.

### Tables

**users** — canonical user records:
```sql
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email        TEXT UNIQUE,
  username     TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
```

**oauth_accounts** — linked OAuth provider accounts:
```sql
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK(provider IN ('github', 'google', 'discord')),
  provider_user_id TEXT NOT NULL,
  access_token     TEXT,
  refresh_token    TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id)
);
```

**sessions** — refresh token sessions:
```sql
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

> `D1_MAIN` is used for app-level data (e.g., consultation bookings). The auth tables above are in the `DB` binding (wokspec-auth database).

### D1 Query Patterns

```typescript
// Single row
const user = await c.env.DB
  .prepare('SELECT id, email, display_name FROM users WHERE email = ?')
  .bind(email)
  .first<{ id: string; email: string; display_name: string }>();

// Upsert (SQLite ON CONFLICT)
await c.env.DB
  .prepare(`
    INSERT INTO users (id, email, display_name, avatar_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      display_name = excluded.display_name,
      avatar_url   = excluded.avatar_url,
      updated_at   = datetime('now')
  `)
  .bind(id, email, displayName, avatarUrl)
  .run();

// Delete
await c.env.DB
  .prepare('DELETE FROM sessions WHERE id = ?')
  .bind(sessionId)
  .run();
```

---

## 12. Environment Variables / Cloudflare Bindings

WokAPI uses **Cloudflare Worker bindings** instead of `process.env`. All values are accessed via `c.env.*`. They are set via `wrangler secret put` for secrets and `wrangler.toml` for bindings.

### Required Secrets (`wrangler secret put <NAME>`)

```
GITHUB_CLIENT_ID         GitHub OAuth App client ID
GITHUB_CLIENT_SECRET     GitHub OAuth App client secret
GOOGLE_CLIENT_ID         Google OAuth client ID
GOOGLE_CLIENT_SECRET     Google OAuth client secret
DISCORD_CLIENT_ID        Discord application client ID
DISCORD_CLIENT_SECRET    Discord application client secret
JWT_SECRET               Shared HMAC-SHA256 signing secret (32+ chars)
STRIPE_SECRET_KEY        Stripe API secret key (sk_live_...)
STRIPE_WEBHOOK_SECRET    Stripe webhook signing secret (whsec_...)
RESEND_API_KEY           Resend API key for booking emails
ENVIRONMENT              "production" or "development"
```

### Required Bindings (`wrangler.toml`)

```toml
[[kv_namespaces]]
binding = "OAUTH_STATE"          # KV for OAuth state nonces
id = "<your-kv-id>"

[[d1_databases]]
binding = "DB"                   # D1 for auth (users, sessions, oauth_accounts)
database_name = "wokspec-auth"
database_id = "<your-d1-id>"

# D1_MAIN for app data (consultation_bookings, etc.) — add separately if needed
```

### TypeScript Env Type

Defined in `src/types.ts`. Keep in sync with `wrangler.toml` bindings and secrets.

```typescript
export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  JWT_SECRET: string;
  DB: D1Database;
  D1_MAIN: D1Database;
  OAUTH_STATE: KVNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  ENVIRONMENT?: string;
}
```

---

## 13. How to Add a New OAuth Provider

**Prerequisite:** Create an OAuth application in the provider's developer console. Get a client ID and secret.

### Step-by-Step

**1. Add credentials to `src/types.ts`**
```typescript
export interface Env {
  // ... existing
  <PROVIDER>_CLIENT_ID: string;
  <PROVIDER>_CLIENT_SECRET: string;
}
```

**2. Add secrets via wrangler**
```bash
wrangler secret put <PROVIDER>_CLIENT_ID
wrangler secret put <PROVIDER>_CLIENT_SECRET
```

**3. Add initiation route in `src/routes/auth.ts`**
```typescript
auth.get('/<provider>', rateLimit('auth'), async (c) => {
  const redirectTo = sanitizeRedirectTo(c.req.query('redirect_to'));
  const redirectExtension = c.req.query('redirect_extension') === 'true';
  const state = btoa(JSON.stringify({ redirectTo, redirectExtension, nonce: crypto.randomUUID() }));
  await c.env.KV_SESSIONS.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });

  const url = new URL('<PROVIDER_AUTH_URL>');
  url.searchParams.set('client_id', c.env.<PROVIDER>_CLIENT_ID);
  url.searchParams.set('redirect_uri', 'https://api.wokspec.org/v1/auth/<provider>/callback');
  url.searchParams.set('scope', '<required scopes>');
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
});
```

**4. Add callback route**
```typescript
auth.get('/<provider>/callback', rateLimit('auth'), async (c) => {
  // 1. Validate code + state (ALWAYS — do not skip)
  // 2. Delete state from KV (prevent replay)
  // 3. Exchange code for access token
  // 4. Fetch user profile (must obtain: email, display_name, avatar_url)
  // 5. Require verified email — return 400 if absent
  // 6. upsertUser(c.env.DB, { email, displayName, avatarUrl })
  // 7. upsertOAuthAccount(c.env.DB, { userId, provider: '<provider>', ... })
  // 8. return issueTokensAndRedirect(c, user, redirectTo, redirectExtension)
});
```

**5. Update `oauth_accounts` schema CHECK constraint**
```sql
-- src/db/schema.sql
provider TEXT NOT NULL CHECK(provider IN ('github', 'google', 'discord', '<provider>'))
```
Apply with: `wrangler d1 execute wokspec-auth --file src/db/schema.sql --remote`

**6. Update CODEOWNERS if needed** for the new route file.

---

## 14. How to Add a New Product to the Registry

**Prerequisite:** The product must have a health check URL that returns 2xx when healthy.

**In `src/index.ts`, add to the `PRODUCTS` array:**

```typescript
{
  slug: 'your-product-slug',      // kebab-case, unique, permanent
  name: 'Your Product Name',
  description: 'One-sentence description.',
  url: 'https://yourproduct.wokspec.org',
  health_url: 'https://yourproduct.wokspec.org/api/health',
  status: 'live',                  // or 'beta' for soft launch
  tags: ['ai', 'relevant-tag'],
},
```

**Also add the product origin to the CORS allowlist if it needs to make credentialed requests to WokAPI:**

```typescript
// src/index.ts — cors() origin array
origin: [
  'https://wokspec.org',
  'https://www.wokspec.org',
  'https://eral.wokspec.org',
  'https://yourproduct.wokspec.org',  // Add here
],
```

**And to `ALLOWED_REDIRECT_ORIGINS` in `src/routes/auth.ts` if users will OAuth-authenticate from that product:**

```typescript
const ALLOWED_REDIRECT_ORIGINS = [
  'https://wokspec.org',
  // ...existing...
  'https://yourproduct.wokspec.org',  // Add here
];
```

---

## 15. Security Considerations

### Token Expiry

Access tokens should be short-lived (minutes to hours). Refresh tokens should be long-lived (days to weeks) but rotated on each use (already implemented — see `POST /v1/auth/refresh`). Constants for TTLs are in `src/lib/constants.ts`.

### CORS

The CORS allowlist must be an explicit set of origins. Never use `*` on a credentialed endpoint. The current allowlist:
- `https://wokspec.org`
- `https://www.wokspec.org`
- `https://eral.wokspec.org`

### Webhook HMAC Verification

Stripe webhooks are verified by reconstructing the expected HMAC-SHA256 signature from the raw body + timestamp and comparing with the `stripe-signature` header value. The raw body must be read with `c.req.text()` — never parse as JSON before verification.

### OAuth State / CSRF

State is stored in KV with `expirationTtl: 300` (5 minutes). After validation, the state key is immediately deleted (`KV.delete(key)`) to prevent replay attacks.

### Secrets Never in Source

All OAuth credentials, JWT secrets, and API keys are Cloudflare Worker secrets set via `wrangler secret put`. They are never committed to source. The `wrangler.toml` only contains non-secret binding IDs (KV namespace IDs, D1 database IDs — these are safe to commit).

### Rate Limiting

The `rateLimit()` middleware in `src/middleware.ts` is implemented using Cloudflare KV bucketed counters. It supports fixed-window rate limiting per IP by indexing keys with a time-based bucket (e.g., `rl:prefix:ip:timestamp_bucket`).

```typescript
// Example usage:
auth.get('/github', rateLimit('auth', 60, 60), async (c) => { ... });
```

### Session Pruning

`pruneExpiredSessions()` is called fire-and-forget on token refresh. It deletes sessions where `expires_at < datetime('now')`. This prevents unbounded session table growth.

---

## 16. Bookings / Stripe Integration

`src/routes/bookings.ts` handles consultation slot purchases.

### Flow

1. `POST /v1/bookings/checkout` — authenticated user initiates checkout
   - Creates a Stripe Checkout Session for `CONSULTATION_PRICE_CENTS` ($50 USD)
   - Records a `pending` booking in `D1_MAIN.consultation_bookings`
   - Returns `{ checkoutUrl, sessionId }` — client redirects to Stripe Checkout

2. `POST /v1/bookings/webhook` — Stripe sends `checkout.session.completed`
   - **HMAC-SHA256 verification first** — rejects without valid `stripe-signature`
   - Sends confirmation email via Resend
   - Marks booking as confirmed in D1

### Stripe Signature Verification

```typescript
// Reconstruct the signed payload
const signedPayload = `${timestamp}.${body}`;
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(STRIPE_WEBHOOK_SECRET), ...);
const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
// Compare expected vs v1 from stripe-signature header
```

---

## 17. Common Gotchas and Pitfalls

### No `process.env` in Workers

Cloudflare Workers do not have `process.env`. All configuration comes from `c.env.*`. If you see `process.env` anywhere in WokAPI source, that's a bug.

### D1 Binding Names

The `wrangler.toml` uses `binding = "DB"` but the `types.ts` `Env` interface defines both `DB` and `D1_MAIN`. The `D1_AUTH` name referenced in some auth.ts imports is an alias — make sure the binding name in `wrangler.toml` matches the `Env` interface. Mismatched names will throw runtime errors in Workers.

### KV Consistency

Cloudflare KV is **eventually consistent** (changes propagate globally within ~60s). For OAuth state (5-minute TTL), this is acceptable — but do not use KV for data that requires strong consistency.

### D1 is SQLite

D1 uses SQLite semantics. Key differences from PostgreSQL:
- No `RETURNING` clause support in older D1 versions
- `datetime('now')` instead of `NOW()`
- `lower(hex(randomblob(16)))` for UUID-like IDs
- `ON CONFLICT` syntax is SQLite's `UPSERT` — not the PostgreSQL variant

### `wrangler dev` vs Production

`wrangler dev` runs a local Worker simulator. KV and D1 are local SQLite files in `.wrangler/`. Secrets set via `wrangler secret put` are NOT available in local dev — use a `.dev.vars` file locally (never commit it).

### `nodejs_compat` Flag

The `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml` enables Node.js built-in polyfills. This is required for some crypto operations. Do not remove it.

### JWT Secret Rotation

Rotating `JWT_SECRET` immediately invalidates all active sessions across ALL WokSpec products. Coordinate with all product teams and announce downtime if rotation is needed.

### Refresh Token Body vs Cookie

`POST /v1/auth/refresh` and `POST /v1/auth/logout` accept the refresh token from either the cookie (web) or the JSON request body (browser extension). This dual path is intentional — do not remove the body fallback.

---

## 18. Commit Conventions

Follow **Conventional Commits**:

```
<type>(<scope>): <short description>

[optional body]

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

**Types:**
- `feat` — new feature or endpoint
- `fix` — bug fix
- `chore` — maintenance, deps, config
- `refactor` — restructuring without behavior change
- `docs` — documentation only
- `perf` — performance improvement
- `style` — formatting only (no logic change)
- `test` — tests only
- `ci` — CI/CD workflow changes
- `security` — security hardening (use for auth/CORS/HMAC changes)

**Scopes:** `auth`, `registry`, `bookings`, `jwt`, `cors`, `middleware`, `db`, `ci`

**Examples:**
```
feat(auth): add Discord OAuth provider
fix(jwt): prevent token reuse after refresh rotation
security(cors): tighten CORS allowlist to named origins only
chore(deps): bump hono to 4.x
feat(registry): add WokPost to product registry
```

---

## 19. CI/CD Notes

### Workflow (`ci-cd.yml`)

The existing CI/CD pipeline (added in `ci: add CI/CD workflow`) covers:
- **Typecheck:** `npx tsc --noEmit`
- **Lint:** ESLint
- **Test:** runs `src/routes/auth.test.ts`
- **Deploy:** `wrangler deploy` on push to `main` only

### Secrets in CI

The following secrets must be set in the GitHub repository secrets for CI/CD to work:
- `CLOUDFLARE_API_TOKEN` — for `wrangler deploy`
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID

Production Worker secrets (`JWT_SECRET`, OAuth keys, etc.) are managed separately via `wrangler secret put` and are stored in Cloudflare — they are NOT GitHub secrets.

### Deployment

Deploy is automatic on push to `main`:
```bash
wrangler deploy  # Deploys to api.wokspec.org (custom_domain = true in wrangler.toml)
```

Manual deploy:
```bash
npm run deploy   # or: npx wrangler deploy
```

### Local Development

```bash
npm run dev      # wrangler dev — starts local Worker on localhost:8787
```

Create `.dev.vars` (gitignored) with local values:
```
JWT_SECRET=local-dev-secret
GITHUB_CLIENT_ID=your-local-oauth-app-id
GITHUB_CLIENT_SECRET=your-local-oauth-app-secret
```

---

## 20. Agent-Specific Guidance

### For All Agents

- **The `/v1/me` endpoint contract is immutable.** Do not change the JWT payload structure or the auth cookie names.
- **CORS must remain an explicit allowlist.** Never suggest `origin: '*'` for a credentialed endpoint.
- **State validation is mandatory.** Every OAuth callback must validate the state parameter against KV before proceeding.
- **Secrets are Cloudflare Worker secrets.** Never suggest `process.env` — always `c.env.*`.
- **Do not commit `.dev.vars`.** It is (and must remain) in `.gitignore`.

### For Sweep

- If asked to add a new OAuth provider, follow Section 13 exactly, including the D1 schema CHECK constraint update.
- If asked to add a new product, follow Section 14 — update PRODUCTS array, CORS allowlist, and ALLOWED_REDIRECT_ORIGINS.
- Do not modify the JWT payload shape without flagging it as a breaking change for downstream products.
- Do not weaken the OAuth state CSRF check.

### For Claude / Copilot

- When writing a new protected route, always use `requireAuth()` middleware — do not inline the session check.
- When writing D1 queries, use parameterized `.bind()` — never string interpolation in SQL.
- When modifying the Stripe webhook handler, preserve the HMAC-SHA256 verification block before any other processing.
- When adding a new KV key pattern, document the key shape and TTL in a code comment.

### What NOT to Do

- ❌ Do not change `wokspec_session` cookie name — all downstream apps depend on it
- ❌ Do not add `*` to the CORS origin list
- ❌ Do not skip OAuth state validation
- ❌ Do not process Stripe webhook events without verifying the signature
- ❌ Do not use `process.env` — use `c.env.*`
- ❌ Do not add JWT claims or change their types without a coordinated cross-product migration
- ❌ Do not store secrets in `wrangler.toml` — they go in `wrangler secret put`
- ❌ Do not add new auth patterns (e.g., API keys, magic links) without updating the `requireAuth()` middleware
- ❌ Do not use `console.log()` with sensitive data (tokens, secrets, emails in plaintext)
