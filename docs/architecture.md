# WokAPI — Architecture

## Overview

WokAPI is a Cloudflare Worker application built with the [Hono](https://hono.dev) framework. It is the single source of truth for identity and commerce across the WokSpec platform. No other product stores user credentials or payment information — they delegate entirely to WokAPI.

The Worker runs globally at Cloudflare edge PoPs, meaning it processes requests within milliseconds of users worldwide with no cold-start latency.

---

## System Components

```
                Internet
                   │
         ┌─────────▼─────────┐
         │  Cloudflare Edge   │  (global PoPs)
         │     WokAPI Worker  │
         │     (Hono router)  │
         └────────┬───────────┘
                  │
       ┌──────────┼──────────────┐
       │          │              │
  ┌────▼───┐  ┌───▼──┐  ┌───────▼───────┐
  │  D1 DB │  │  KV  │  │  Nikita Worker  │
  │(SQLite)│  │(sess)│  │  (AI proxy)   │
  └────────┘  └──────┘  └───────────────┘
                  │
             ┌────▼────┐
             │  Stripe  │
             │(payments)│
             └──────────┘
```

---

## Data Model (D1 / SQLite)

### `users`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT (ULID) | Primary key |
| `email` | TEXT | Unique, lowercased |
| `password_hash` | TEXT | bcrypt |
| `github_id` | INTEGER | OAuth link |
| `google_id` | TEXT | OAuth link |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |

### `sessions`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT (ULID) | Primary key |
| `user_id` | TEXT | FK → users |
| `token_hash` | TEXT | SHA-256 of refresh token |
| `expires_at` | INTEGER | Unix timestamp |
| `revoked` | INTEGER | 0/1 boolean |

### `subscriptions`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Stripe subscription ID |
| `user_id` | TEXT | FK → users |
| `plan` | TEXT | free \| builder \| pro \| enterprise |
| `status` | TEXT | Stripe status string |
| `current_period_end` | INTEGER | Unix timestamp |

---

## Auth Flow

### Email/Password Login
```
POST /v1/auth/login
  → validate credentials (bcrypt compare)
  → issue access JWT (7-day, HS256, JWT_SECRET)
  → issue refresh token (opaque, stored hashed in sessions table)
  → return { access_token, refresh_token }
```

### GitHub OAuth
```
GET /v1/auth/github          → redirect to GitHub with client_id + state
GET /v1/auth/github/callback → exchange code → fetch profile
                             → upsert user (github_id match)
                             → issue tokens same as email flow
```

### Token Verification
All protected routes run a `verifyJWT` middleware:
```
Authorization: Bearer <jwt>
  → decode HS256 with JWT_SECRET
  → check exp claim
  → attach user_id to context
  → if invalid: 401 Unauthorized
```

The same `JWT_SECRET` is deployed to the Nikita Worker so Nikita can independently verify tokens without a round-trip to WokAPI.

---

## AI Proxy

WokAPI proxies AI calls to Nikita under `/v1/ai/*`. The proxy:
1. Verifies the caller's JWT
2. Checks subscription tier for rate/model limits
3. Forwards to `https://nikita.wokspec.org/v1/{endpoint}` with the JWT passed as-is
4. Streams the response back (where applicable)

This means products only need to know one base URL (`api.wokspec.org`) and receive consistent AI behaviour gated by subscription.

---

## Stripe Integration

### Checkout Flow
```
POST /v1/billing/checkout { plan: "pro" }
  → create Stripe Checkout Session (mode: subscription)
  → return { url } — redirect client to Stripe-hosted page
  → on success: Stripe webhook fires
```

### Webhook Handler (`POST /v1/billing/webhook`)
```
Events handled:
  checkout.session.completed  → activate subscription in D1
  customer.subscription.updated → update plan/status in D1
  customer.subscription.deleted → downgrade to free in D1
```

Webhook signature is verified with `STRIPE_WEBHOOK_SECRET` before any database write.

---

## KV Usage

`KV_SESSIONS` stores fast-lookup session metadata keyed by `session:<id>`:
- Written on login / token refresh
- Checked before D1 for revocation status (O(1) edge read)
- Deleted on explicit logout or revocation

---

## Key Design Decisions

**Why Cloudflare D1 and not an external DB?**  
WokAPI is latency-critical (auth sits in every request path). D1 runs inside Cloudflare's network, colocated with the Worker, giving microsecond SQLite reads without a TCP round-trip to an external host.

**Why Hono?**  
Hono is built for edge runtimes and has no Node.js dependencies. It compiles to a small bundle and starts instantly. The router and middleware surface is similar to Express, making it familiar.

**Why HS256 and not RS256?**  
A shared secret is simpler to manage when the verifying parties (WokAPI and Nikita) are both internal services owned by WokSpec. RS256 would require distributing a public key and adds unnecessary complexity for this trust model.
