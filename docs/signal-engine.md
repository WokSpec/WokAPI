# Signal Engine — MVP Design

1) Purpose and overview

The Signal Engine ingests, scores, stores, and surfaces operational "signals" (anomalies, incidents, vulnerabilities, user reports) so teams can detect and respond to emerging problems quickly. The MVP will provide a simple authenticated ingestion API, a durable store for signals, a lightweight trend detection job that computes impact scores, and read endpoints for signals and trends.

2) Signal data model

Fields (name: type) and brief notes:

- id: string (UUID) — unique signal id (server-generated if omitted)
- type: string — enum: "anomaly", "incident", "vulnerability", "report", etc.
- sources: string[] — list of source identifiers (e.g., "prometheus", "snyk", "user-report")
- summary: string — short human-readable summary
- impact_score: number (0-10) — computed or provided; normalized to 0-10
- related_entities: string[] — e.g., ["service:payments", "team:billing"]
- timestamp: string (ISO 8601) — event time (UTC)
- evidence: object[] — array of evidence objects (type, url, snippet, metadata)
- raw_payload: object (JSON) — original raw payload for audit/debug
- created_at: string (ISO 8601)
- updated_at: string (ISO 8601)

Example signal JSON:

{
  "type": "anomaly",
  "sources": ["metrics:prometheus", "alert:ops-squad"],
  "summary": "Spike in 5xx rate for payments-service",
  "impact_score": 6.8,
  "related_entities": ["service:payments", "team:billing"],
  "timestamp": "2026-03-16T12:34:56Z",
  "evidence": [
    {"type":"metric","name":"http_5xx_rate","value":0.12,"window":"5m"},
    {"type":"log","snippet":"panic: nil pointer"}
  ]
}

3) Ingestion API endpoints (examples)

POST /api/signals  (requires Authorization: Bearer <API_TOKEN>)
Request (application/json):

{
  "type": "anomaly",
  "sources": ["metrics:prometheus"],
  "summary": "Increased error rate in payments",
  "related_entities": ["service:payments"],
  "timestamp": "2026-03-16T12:34:56Z",
  "evidence": [{"type":"metric","name":"http_5xx_rate","value":0.12}]
}

Responses:
- 201 Created
{
  "id": "uuid-v4",
  "type": "anomaly",
  "impact_score": 6.5,
  "created_at": "2026-03-16T12:35:01Z"
}
- 400 Bad Request — validation error
- 401 Unauthorized — invalid/missing API token

GET /api/signals
Query params: limit, offset, since, type, entity, min_score
Response 200 OK (paginated):
{
  "items": [ { /* signal objects */ } ],
  "meta": {"total": 123, "limit": 25, "offset": 0}
}

GET /api/signals/:id
Response 200 OK:
{
  /* full signal object including evidence and raw_payload */
}

GET /api/trends
Query params: window (e.g., "1h", "24h"), entity, limit
Response 200 OK (example):
[
  {
    "entity": "service:payments",
    "trend_score": 8.1,
    "signals_count": 12,
    "top_signals": ["uuid-1","uuid-2"]
  }
]

4) Storage & infra options for MVP: tradeoffs

- Cloudflare Durable Objects
  - Pros: strong single-object consistency, good for per-entity coordination/locks, small-scale stateful logic.
  - Cons: not ideal for full-text search or querying across many signals; scaling across many objects adds complexity.

- D1 (Cloudflare's SQLite-backed SQL DB)
  - Pros: SQL queries, ACID, easy migrations, good for structured queries and analytics at small-medium scale; integrates with Workers.
  - Cons: currently single-region / quota limits depending on plan; JSON fields stored as text.

- SQLite (local / container)
  - Pros: zero-dependency for local dev, fast, simple.
  - Cons: not distributed for production; requires migration to D1 or other DB for production.

- Workers KV
  - Pros: extremely fast, globally distributed key-value store, cheap for small data and caching.
  - Cons: eventual consistency, poor for querying/filtering large sets, not suitable as primary analytical store.

MVP recommendation: persist signals in D1 (signals table) for durability and SQL queries. Use Durable Objects only if you need per-entity locks/coordination (e.g., leader election for trend job). Use Workers KV as edge cache for top trends.

Suggested schema (D1/SQLite):

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  sources TEXT,
  summary TEXT,
  impact_score REAL,
  related_entities TEXT,
  timestamp TEXT,
  evidence TEXT,
  raw_payload TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_signals_timestamp ON signals(timestamp);
CREATE INDEX idx_signals_impact ON signals(impact_score);

5) Basic trend detection approach and scoring heuristics

Overview:
- Run a periodic worker (cron trigger) every 1-5 minutes that aggregates recent signals by entity, tag, or service.
- Compute features per bucket: recent_count (volume), velocity (growth vs baseline), avg_source_score (reliability), avg_severity (if provided), unique_source_count, recency.

Simple normalized scoring (MVP):
- Normalize numeric features to [0,1]. Example: norm_volume = min(1, log(1 + count_recent) / log(1 + baseline_threshold)).
- Weighted sum -> raw_score = w_v*norm_volume + w_vel*norm_velocity + w_s*avg_source_score + w_sev*avg_severity + w_u*norm_unique_sources
- impact_score = round(clamp(raw_score * 10, 0, 10), 1)

Example weights (tunable):
- w_v (volume) = 0.35
- w_vel (velocity) = 0.25
- w_s (source reliability) = 0.2
- w_sev (severity) = 0.1
- w_u (unique sources) = 0.1

Heuristics:
- Apply exponential decay to older signals so recent activity dominates.
- Boost score when multiple independent sources report the same issue.
- Cap and floor scores; surface high-confidence signals with source reliability > 0.8.

6) Security & auth notes

- Authentication: Bearer API tokens with scopes (signals:write, signals:read, signals:admin). Store tokens in secrets (Workers secrets / env).
- Authorization: enforce scope checks and per-tenant isolation (tenant_id in signal or token claims).
- Rate limiting: per-token and per-IP quotas (e.g., 60 req/min with burst to 120). Return 429 when exceeded.
- Validation & size limits: limit raw_payload and evidence sizes, validate allowed fields, sanitize input to avoid injection.
- Auditing & logging: log ingestion events and maintain raw_payload for debugging; redact PII.
- Secrets & deployment: keep DB creds / tokens in environment secrets, rotate tokens periodically.

7) Next steps & roadmap for implementation (MVP)

Minimum implementable steps:
1. Create D1 schema and migrations (signals table + indexes).
2. Implement POST /api/signals with input validation, auth, insert into D1, and immediate impact_score calculation (fast heuristic).
3. Implement GET /api/signals and GET /api/signals/:id with pagination and filters.
4. Implement a Cron Worker to aggregate recent signals and compute trends; store top trends in a cached table or KV.
5. Add basic tests (unit + integration against a local SQLite/D1 test instance).
6. Add rate-limiting middleware and token-based auth.
7. Deploy to staging, monitor for ingestion rate and query performance; iterate on scoring weights and thresholds.

Roadmap (post-MVP):
- Add per-tenant quotas & billing integration
- Enrich source reliability scoring, integrate signal deduplication
- Add UI/dashboard for trends and drill-down
- Alerting / notification hooks (webhooks, Slack)

