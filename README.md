# WokAPI

The WokSpec Platform API — shared authentication, identity, AI token routing, and infrastructure used across all WokSpec products.

[![Status](https://img.shields.io/badge/status-active-brightgreen)](https://status.wokspec.org)
[![Scope](https://img.shields.io/badge/scope-internal-blue)](#)
[![Live](https://img.shields.io/badge/live-api.wokspec.org-orange)](https://api.wokspec.org)

> **Note:** WokAPI is the internal backbone of the WokSpec platform. It is not a public API and is not currently open for third-party integrations.

## What It Does

WokAPI is the central services layer shared by every WokSpec product. It handles:

- **Authentication & identity** — JWT-based login, registration, session management
- **AI token routing** — Proxies and manages AI requests across the ecosystem (via Nqita)
- **Payments & billing** — Stripe checkout, subscription management, webhook handling
- **Rate limiting & session storage** — Edge-side KV-backed rate limiting and session state

## Architecture

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Framework | [Hono](https://hono.dev) v4 |
| Database | Cloudflare D1 (SQLite at the edge) |
| Cache / Sessions | Cloudflare KV (`KV_SESSIONS`) |
| Payments | Stripe |
| AI routing | Nqita — proxied via `/v1/ai/*` |
| Validation | Zod + `@hono/zod-validator` |

Requests hit a single Cloudflare Worker. Hono routes them to typed handlers. D1 is the source of truth for users/accounts; KV holds ephemeral session and rate-limit state.

## API Endpoints

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/auth/login` | Email/password login — returns access + refresh JWTs |
| `POST` | `/v1/auth/register` | Create a new account |
| `POST` | `/v1/auth/refresh` | Exchange a refresh token for a new access token |
| `POST` | `/v1/auth/logout` | Invalidate the current session |
| `GET`  | `/v1/auth/me` | Return the authenticated user's profile |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/sessions` | List active sessions for the current user |
| `DELETE` | `/v1/sessions/:id` | Revoke a specific session |

### AI Routing

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/ai/chat` | Conversational AI (proxied to Nqita) |
| `POST` | `/v1/ai/generate` | Content generation |
| `POST` | `/v1/ai/analyze` | Content analysis |

### Billing

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/billing/checkout` | Create a Stripe checkout session |
| `POST` | `/v1/billing/portal` | Open Stripe billing portal |
| `POST` | `/v1/billing/webhook` | Stripe webhook receiver |
| `GET`  | `/v1/billing/subscription` | Current subscription status |

## Auth Model

All protected routes require:

```http
Authorization: Bearer <access_token>
```

JWTs are signed with `JWT_SECRET` (shared with Nqita for cross-service verification). Access tokens expire in **7 days**; refresh tokens extend sessions to **30 days**.

## Local Development

```bash
npm install
npm run dev        # starts Wrangler dev server on http://localhost:8787
```

### Required Secrets

Set these with Wrangler before deploying or running locally with remote bindings:

```bash
wrangler secret put JWT_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Required Bindings (`wrangler.toml`)

```toml
[[d1_databases]]
binding = "DB"
database_name = "wokapi-db"
database_id   = "<your-d1-id>"

[[kv_namespaces]]
binding = "KV_SESSIONS"
id      = "<your-kv-id>"
```

## Deployment

```bash
npm run deploy    # wrangler deploy → Cloudflare Workers
```

Deploys to `api.wokspec.org` via the Cloudflare Worker defined in `wrangler.toml`.

## Related Repositories

| Repo | Description |
|------|-------------|
| [WokSite](https://github.com/wokspec/WokSite) | wokspec.org — ecosystem site and partners section |
| [WokStudio](https://github.com/wokspec/WokStudio) | AI creator studio |
| [WokPartners](https://github.com/wokspec/WokPartners) | Partner dashboard and B2B infrastructure |
| [Nqita](https://github.com/nqita/nqita) | AI companion and interface layer (sibling org) |
| [Autiladus](https://github.com/autiladus/autiladus) | Orchestration infrastructure (sibling org) |

## Internal Documentation

- [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) — project background and goals
- [`AGENT_RULES.md`](./AGENT_RULES.md) — AI agent usage rules
- [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) — ecosystem-wide overview
- [`docs/architecture.md`](./docs/architecture.md) — detailed API architecture
- [`docs/api.md`](./docs/api.md) — full endpoint reference
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution guidelines

## Contact

`hello@wokspec.org` · `security@wokspec.org`
