# WokAPI (WokSpec org)

> Repo of record: https://github.com/wokspec/wokapi  
> Other products: WokHei/Studio stay in WokSpec; Autiladus → https://github.com/autiladus/autiladus; Nikita/nqita → https://github.com/nqita/nqita

Core API for WokSpec. Handles auth, sessions, payments, and AI routing across all WokSpec products.

**Live:** [api.wokspec.org](https://api.wokspec.org)

---

![Status](https://img.shields.io/badge/status-active-green) ![Scope](https://img.shields.io/badge/scope-private-blue)

## Related
- WokSpec.org (site/dashboard)
- WokStudio (design/build suite)
- WokHei (news)
- Nqita (sibling org) — https://github.com/nqita/nqita
- Autiladus (sibling org) — https://github.com/autiladus/autiladus

## Repository documentation

- [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md)
- [`AGENT_RULES.md`](./AGENT_RULES.md)
- [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md)
- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/api.md`](./docs/api.md)


## Stack

- **Runtime:** Cloudflare Workers
- **Framework:** [Hono](https://hono.dev)
- **Database:** Cloudflare D1 (SQLite at the edge)
- **Cache / Sessions:** Cloudflare KV
- **Payments:** Stripe
- **AI routing:** Nikita (proxied via `/v1/ai/*`)

---

## API Routes

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/auth/login` | Email/password login — returns JWT |
| `POST` | `/v1/auth/register` | Create account |
| `POST` | `/v1/auth/refresh` | Refresh JWT |
| `POST` | `/v1/auth/logout` | Invalidate session |
| `GET`  | `/v1/auth/me` | Current user |

### Sessions
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/sessions` | List active sessions |
| `DELETE` | `/v1/sessions/:id` | Revoke session |

### AI (proxy to Nikita)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/ai/chat` | Conversational AI |
| `POST` | `/v1/ai/generate` | Content generation |
| `POST` | `/v1/ai/analyze` | Content analysis |

### Payments
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/billing/checkout` | Create Stripe checkout session |
| `POST` | `/v1/billing/portal` | Open billing portal |
| `POST` | `/v1/billing/webhook` | Stripe webhook handler |
| `GET`  | `/v1/billing/subscription` | Current subscription status |

---

## Development

```bash
npm install
npm run dev       # local dev on :8787 via wrangler
npm run deploy    # deploy to Cloudflare Workers
```

### Required secrets

```bash
wrangler secret put JWT_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Required bindings (wrangler.toml)

```toml
[[d1_databases]]
binding = "DB"
database_name = "wokapi-db"
database_id   = "<your-d1-id>"

[[kv_namespaces]]
binding = "KV_SESSIONS"
id      = "<your-kv-id>"
```

---

## Auth model

All protected routes require `Authorization: Bearer <jwt>`. JWTs are signed with `JWT_SECRET` (shared with Nikita). Tokens expire in 7 days; refresh tokens extend to 30 days.
