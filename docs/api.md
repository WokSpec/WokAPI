# WokAPI — Full API Reference

Base URL: `https://api.wokspec.org`

All protected endpoints require `Authorization: Bearer <jwt>` where the JWT is issued by WokAPI at login.

---

## Auth

### `POST /v1/auth/register`

Create a new account.

**Request body:**
```json
{ "email": "user@example.com", "password": "min8chars" }
```

**Response `200`:**
```json
{
  "user": { "id": "01J...", "email": "user@example.com" },
  "access_token": "eyJ...",
  "refresh_token": "tok_..."
}
```

**Errors:** `400` invalid body · `409` email already exists

---

### `POST /v1/auth/login`

**Request body:**
```json
{ "email": "user@example.com", "password": "..." }
```

**Response `200`:** same shape as `/register`

**Errors:** `400` invalid body · `401` wrong credentials

---

### `POST /v1/auth/refresh`

Exchange a refresh token for a new access token.

**Request body:**
```json
{ "refresh_token": "tok_..." }
```

**Response `200`:**
```json
{ "access_token": "eyJ...", "refresh_token": "tok_..." }
```

**Errors:** `401` expired or revoked

---

### `POST /v1/auth/logout`

Revoke the current session. Requires `Authorization` header.

**Response `204`:** no content

---

### `GET /v1/auth/me`

Return authenticated user's profile.

**Response `200`:**
```json
{
  "id": "01J...",
  "email": "user@example.com",
  "created_at": 1710000000
}
```

---

## Sessions

### `GET /v1/sessions`

List all active (non-revoked, non-expired) sessions for the authenticated user.

**Response `200`:**
```json
[
  { "id": "01J...", "created_at": 1710000000, "expires_at": 1710604800 }
]
```

---

### `DELETE /v1/sessions/:id`

Revoke a specific session by ID.

**Response `204`:** no content  
**Errors:** `404` session not found · `403` session belongs to another user

---

## AI (Proxy → Eral)

These routes proxy to Eral and forward the caller's JWT. Subscription tier determines model access and rate limits.

### `POST /v1/ai/chat`

**Request body:** forwarded directly to Eral `/v1/chat`  
```json
{
  "message": "string",
  "sessionId": "optional-session-id",
  "quality": "fast | balanced | best"
}
```

**Response:** streaming JSON or `200` with Eral's response body.

---

### `POST /v1/ai/generate`

**Request body:** forwarded to Eral `/v1/generate`
```json
{
  "prompt": "string",
  "transform": "improve | rewrite | expand | shorten | null",
  "quality": "fast | balanced | best"
}
```

---

### `POST /v1/ai/analyze`

**Request body:** forwarded to Eral `/v1/analyze`
```json
{
  "content": "string",
  "mode": "summarize | review | extract"
}
```

---

## Billing

### `POST /v1/billing/checkout`

Create a Stripe Checkout session to upgrade.

**Request body:**
```json
{ "plan": "builder | pro | enterprise" }
```

**Response `200`:**
```json
{ "url": "https://checkout.stripe.com/pay/..." }
```

---

### `POST /v1/billing/portal`

Open the Stripe Customer Portal for subscription management.

**Response `200`:**
```json
{ "url": "https://billing.stripe.com/..." }
```

---

### `POST /v1/billing/webhook`

Stripe webhook endpoint. Must be configured in the Stripe dashboard with `STRIPE_WEBHOOK_SECRET`.

**Handled events:**
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

**Response:** `200` on success, `400` on signature verification failure.

---

### `GET /v1/billing/subscription`

Return the authenticated user's current subscription.

**Response `200`:**
```json
{
  "plan": "free | builder | pro | enterprise",
  "status": "active | past_due | canceled",
  "current_period_end": 1715000000
}
```

---

## Error Format

All errors return consistent JSON:
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "JWT is expired or invalid"
  }
}
```

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing / invalid body |
| 401 | `UNAUTHORIZED` | No or invalid JWT |
| 403 | `FORBIDDEN` | Valid JWT, insufficient permission |
| 404 | `NOT_FOUND` | Resource doesn't exist |
| 409 | `CONFLICT` | Duplicate (e.g. email) |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Rate Limits

| Tier | Requests/min | AI calls/day |
|---|---|---|
| Free | 60 | 50 |
| Builder | 300 | 500 |
| Pro | 1000 | 5000 |
| Enterprise | Unlimited | Unlimited |
