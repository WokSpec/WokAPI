# WokAPI — Deployment Runbook

## Environments

| Environment | Worker name | URL |
|---|---|---|
| Production | `wokapi` | `api.wokspec.org` |
| Preview | `wokapi-preview` | `wokapi-preview.wokspec.workers.dev` |

---

## Prerequisites

- Cloudflare account with Workers, D1, and KV enabled
- `wrangler` CLI installed and authenticated (`wrangler login`)
- Stripe account with webhook endpoint configured
- Eral deployed and accessible at `https://eral.wokspec.org`

---

## First-Time Setup

### 1. Create D1 Database
```bash
wrangler d1 create wokapi-db
# Copy the database_id from output into wrangler.toml
```

### 2. Create KV Namespace
```bash
wrangler kv namespace create KV_SESSIONS
# Copy the namespace id into wrangler.toml
```

### 3. Run Migrations
```bash
wrangler d1 execute wokapi-db --file=migrations/001_init.sql
wrangler d1 execute wokapi-db --file=migrations/002_subscriptions.sql
```

### 4. Set Secrets
```bash
wrangler secret put JWT_SECRET           # openssl rand -base64 32
wrangler secret put STRIPE_SECRET_KEY    # from Stripe dashboard
wrangler secret put STRIPE_WEBHOOK_SECRET  # from Stripe webhook config
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put ERAL_URL             # https://eral.wokspec.org
```

### 5. Deploy
```bash
npm run deploy   # wrangler deploy
```

### 6. Configure Stripe Webhook
In the Stripe dashboard, add a webhook pointing to:
```
https://api.wokspec.org/v1/billing/webhook
```

Events to subscribe:
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

---

## CI/CD

Every push to `main` triggers `.github/workflows/deploy.yml`:
1. `npm ci`
2. `npm run lint`
3. `npx tsc --noEmit`
4. `wrangler deploy`

Secrets are stored as GitHub Actions repository secrets: `CF_API_TOKEN`, `CF_ACCOUNT_ID`.

---

## Local Development

```bash
npm install
npm run dev      # wrangler dev — runs on http://localhost:8787
```

In dev mode, D1 and KV run as local SQLite files in the `.wrangler/state` directory. Stripe webhooks can be forwarded locally using the Stripe CLI:

```bash
stripe listen --forward-to localhost:8787/v1/billing/webhook
```

---

## Database Migrations

Migrations live in `migrations/` as numbered SQL files. Run them in order:

```bash
wrangler d1 execute wokapi-db --file=migrations/NNN_description.sql
```

To create a new migration:
1. Add `migrations/NNN_your_change.sql`
2. Apply locally: `wrangler d1 execute wokapi-db --local --file=migrations/NNN_your_change.sql`
3. Apply to production after PR merge

---

## Monitoring

- **Error rates:** Cloudflare Workers analytics dashboard
- **Request volume:** `wrangler tail` for real-time log streaming
- **Stripe:** Stripe Dashboard → Developers → Events

---

## Rollback

Cloudflare keeps previous deployment versions. To roll back:
```bash
wrangler deployments list
wrangler rollback <deployment-id>
```

D1 does not have built-in point-in-time recovery. For schema changes, write reversible migrations.
