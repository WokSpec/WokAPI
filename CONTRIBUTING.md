# Contributing to WokAPI

WokAPI is the internal platform API for WokSpec. Contributions are by team members only.

## Running Locally

### Prerequisites

- Node.js 20+ and npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`
- Cloudflare account with D1 and KV access
- `wrangler login` completed

### Setup

```bash
git clone git@github.com:wokspec/WokAPI.git
cd WokAPI
npm install
```

### Configure local secrets

For local development, set secrets in `.dev.vars` (Wrangler reads this automatically, never commit it):

```env
JWT_SECRET=your-local-jwt-secret
STRIPE_SECRET_KEY=sk_test_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx
```

### Start the dev server

```bash
npm run dev        # Wrangler dev server on http://localhost:8787
```

### Running tests

```bash
npm run test       # Vitest unit tests
npm run typecheck  # TypeScript type checking
npm run lint       # ESLint
```

## Branching

| Branch | Purpose |
|--------|---------|
| `main` | Production — deploys to api.wokspec.org |
| `dev` | Active development |
| `feat/*` | Feature branches — branch from `dev` |
| `fix/*` | Bug fix branches |

## Pull Request Process

1. Branch from `dev`: `git checkout -b feat/your-change dev`
2. Make your changes. Keep PRs focused — one concern per PR.
3. Run `npm run typecheck && npm run lint && npm run test` — all must pass.
4. Open a PR targeting `dev` with a clear description.
5. Maintainers review and merge. Only maintainers promote to `main`.

## Adding a New Endpoint

1. Define the route handler in `src/routes/`.
2. Add Zod validation schemas in `src/schemas/`.
3. Register the route in `src/index.ts`.
4. Write unit tests.
5. Update [`docs/api.md`](./docs/api.md) with the new endpoint.

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add /v1/identity/verify endpoint
fix: handle expired refresh token edge case
chore: update hono to 4.12.2
docs: document billing webhook flow
```

## Questions

`hello@wokspec.org` · `security@wokspec.org` for security issues
