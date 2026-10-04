# Matrimony backend

Resource-first Node.js 24 / TypeScript / Fastify scaffold for a multi-tenant matrimony platform. One API and one event-delivery worker; explicit dependency injection in `src/container.ts`.

Before making changes, read [AGENTS.md](AGENTS.md) for the team workflow, engineering rules, review expectations and developer handoff. [CLAUDE.md](CLAUDE.md) references the same guidance for Claude Code.

The [scaffold plan](docs/design/backend-scaffold-plan.md) records the architecture decisions. The [20-feature launch checklist](docs/design/launch-features.md) remains the product backlog. This scaffold implements infrastructure, public tenant configuration and an authenticated account endpoint—not the full launch features.

## Structure

```text
src/
  main.ts, worker.ts         Process entry points and graceful shutdown
  container.ts              Construct and connect dependencies once
  config/                   Validated environment and safe application logs
  controller/               Thin HTTP adapters and default-deny authentication
  io/                       Transport validation and response schemas
  bo/                       Business objects and typed event catalog
  factory/                  Business-to-response mapping
  service/                  Single-resource business operations
  process/                  OAuth/session and event-delivery orchestration
  security/                 OIDC client, JWT verification, refresh-secret encryption
  db/
    config/                 PostgreSQL pool and tenant transactions
    entity/                 Database row validation
    raw/query/              Parameterized SQL
    raw/mapper/             Rows to business objects
    raw/repository/         Query execution
    service/                Database operations exposed to business code
  cache/                    Redis configuration and atomic session persistence
  mongo/                    Config, entity, repository and service for events
  scheduler/                Small polling loop for the worker
  exception/                Safe application errors
migrations/                 Versioned SQL, run explicitly
scripts/                    Migration runner and local provisioning
```

Keep interfaces at external boundaries; avoid a matching interface/implementation pair for every class. Add domain subfolders within a layer as it grows. Do not add empty MQ, replica, billing or matching services ahead of their use cases. Dependency rules reject cycles, controller-to-repository imports and upward infrastructure dependencies.

## Local setup

1. Select Node 24 (`nvm use`), then `npm ci`.
2. `cp .env.example .env`; generate `SESSION_ENCRYPTION_KEY` with `openssl rand -hex 32`.
3. Start PostgreSQL, Redis and MongoDB: `docker compose up -d`. Docker is optional if these services are already available. The Compose credentials are development-only and ports bind to loopback.
4. Apply schema: `npm run db:migrate`. This uses **MIGRATION_DATABASE_URL**, not the runtime account. The command records checksums and serializes concurrent migrations. Never edit an applied migration; add a new file.
5. Seed the local tenant/runtime role:
   ```sh
   docker compose exec -T postgres psql -U postgres -d matrimony < scripts/local-seed.sql
   ```
6. Configure the OIDC provider described below, then link one tenant-local account using `scripts/provision-account.sql`. A verified identity never automatically becomes an administrator.
7. Start `npm run dev` and, in another terminal, `npm run dev:worker`.

`npm run build` produces `dist/`; `npm start` and `npm run start:worker` run compiled code. Production injects environment values from its secret manager; the running application never fetches or chooses secrets based on business logic. Startup validates configuration and connections before accepting traffic. The worker currently shares the same validated deployment configuration but does not connect to Redis or the identity provider.

## OAuth/OIDC contract

Use an HTTPS OIDC provider with S256 PKCE, confidential-client `client_secret_post` authentication, a revocation endpoint, **JWT** API access tokens (RS256 or ES256), and rotating refresh tokens. Configure an API audience matching `OIDC_AUDIENCE` and grant `OIDC_REQUIRED_SCOPE`. `OIDC_AUDIENCE` is a verification setting; configure the provider's API/scope mapping accordingly. Opaque access tokens are deliberately rejected.

Register `http://localhost:3000/api/v1/auth/callback` for development and each agency's exact HTTPS callback for production. Keep the issuer string identical to the token's `iss` and the account's `auth_issuer`. `auth_subject` is the stable provider subject, not an email address. Phone OTP delivery and self-registration will be added as the first identity feature; they are not supplied by this generic OAuth adapter.

| Endpoint | Protection / result |
|---|---|
| `GET /health/live` | Public, process liveness |
| `GET /health/ready` | Public, PostgreSQL + Redis availability; 503 on failure |
| `GET /api/v1/public/tenant` | Known active tenant; public branding/config only |
| `GET /api/v1/auth/authorize` | Creates browser-bound 5-minute state/nonce/PKCE challenge; returns provider URL |
| `GET /api/v1/auth/callback` | Consumes challenge once, exchanges code, verifies identity and local account; returns access token/CSRF token JSON and sets HttpOnly session cookie |
| `POST /api/v1/auth/refresh` | Session cookie + same-origin `Origin` + `X-CSRF-Token`; returns rotated access token |
| `POST /api/v1/auth/logout` | Same browser protection; invalidates local session, attempts provider revocation |
| `GET /api/v1/me` | Bearer JWT + active tenant-bound session + current local account |

New routes require authentication unless explicitly declared public. Staff routes declare allowed roles; resource ownership/assignment checks belong in the relevant use case. JWT roles or user-supplied agency IDs are never authorization sources.

The callback is an API JSON contract; a frontend callback handoff is not built here. Keep access tokens in frontend memory. The CSRF token may be retained in tab session storage to permit refresh after reload; the browser never sees the refresh token. Refresh secrets are encrypted in Redis; cookies contain random session identifiers. Refresh replaces the previous access-token mapping. Serialize refresh calls in the frontend: duplicate concurrent calls return `409 REFRESH_UNAVAILABLE`. A timeout or crashed refresh flow requires login rather than risking refresh-token reuse. Local logout takes effect immediately for subsequent API calls; already running requests may finish. Provider revocation failure is logged, without restoring the local session.

Use same-origin frontend/API routing. Forwarded-host headers are ignored. Configure the ingress to preserve the allowlisted Host, strip spoofed forwarding headers and perform per-client rate limiting. The API also uses Redis-backed limits; with `trustProxy: false`, requests through one proxy share its IP bucket. Do not change to `trustProxy: true` without a bounded trusted-proxy configuration. Production requires HTTPS ingress, secure host-only cookies, verified database/Mongo TLS and `rediss://`.

## Database and crucial events

Each process owns one bounded PostgreSQL pool; the worker also owns one MongoClient pool. API requests never create pools. Every domain query runs in a transaction with transaction-local `app.agency_id`. Runtime roles cannot be superusers or bypass RLS. Runtime grants currently allow account/tenant reads and outbox operations; feature write grants are introduced with their use cases. Migration credentials must never be provided to the HTTP request layer.

For an approval/payment/interest workflow, call `EventDbService.append(tx, event)` inside the same transaction as its business mutation. The event catalog accepts only IDs, event type/version, timestamp and correlation ID—not arbitrary payloads, biodata or tokens. PostgreSQL commits both or neither. The worker leases one due event per agency, idempotently upserts Mongo by event ID, and acknowledges only its current lease. Failed delivery retries with bounded backoff/jitter; exhausted events remain in PostgreSQL. Mongo downtime does not prevent the API from committing events.

Authentication spans the provider, Redis and PostgreSQL, so it is not a distributed transaction. Login/refresh events record the authorized operation before session persistence and do not prove token delivery to a browser. Logout prioritizes local revocation even if the subsequent audit write fails; that failure produces an HTTP/server error and needs operational investigation. Domain events do have transaction-level durability.

Alert on `EVENT_DELIVERY_FAILED` with `exhausted: true`, worker absence, and the oldest undelivered outbox row. Investigate provider/storage failures before replaying an exhausted row; reset its attempts/next-attempt time through an authorized tenant-scoped operator transaction. Define retention and purge delivered outbox rows only after the required audit retention period. Mongo event reads are not exposed by the scaffold; future reads must filter by agency and authorization.

## Verification and deployment

```sh
npm run check        # TypeScript, ESLint, dependency rules, unit/HTTP tests, build
npm audit
```

Integration checks require an **isolated** PostgreSQL database named `matrimony_scaffold_test`, Redis and MongoDB:

```sh
TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/matrimony_scaffold_test \
TEST_REDIS_URL=redis://localhost:6379 \
TEST_MONGO_URL=mongodb://localhost:27017 \
npm run test:integration
```

These tests create schemas/test roles and rows in that named test database. They verify real RLS/rollback, pooled-context reset, Redis refresh races, outbox lease fencing and Mongo idempotency. External OIDC exchanges still require acceptance testing against the configured provider. See [validation record](docs/design/scaffold-validation.md).

The Dockerfile runs compiled code as a non-root user. Run the same image with `node dist/worker.js` for the worker. Run migrations from a separate operator/release environment before deployment, never automatically during API startup. Roll back application images only while the schema remains backward-compatible; there is no destructive automatic down migration. Budget database connections as replicas × pool limit, and provision managed-service backups, alerts and worker supervision before live launch.
