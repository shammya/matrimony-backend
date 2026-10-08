# Matrimony backend

> New here, or a new machine or coding agent? Read [PROJECT.md](PROJECT.md) first: what this project is, the phase plan with what is done, how to run it, and the open decisions.

Resource-first Node.js 24 / TypeScript / Fastify scaffold for a multi-tenant matrimony platform. One API and one event-delivery worker; explicit dependency injection in `src/container.ts`.

Before making changes, read [AGENTS.md](AGENTS.md) for the team workflow, engineering rules, review expectations and developer handoff. [CLAUDE.md](CLAUDE.md) references the same guidance for Claude Code.

The [scaffold plan](docs/design/backend-scaffold-plan.md) records the architecture decisions. The [20-feature launch checklist](docs/design/launch-features.md) remains the product backlog. This scaffold implements infrastructure, public tenant configuration and an authenticated account endpoint—not the full launch features. Progress, each feature's endpoints and who uses them are tracked phase by phase in the [backend tracker](https://claude.ai/artifact/RzGP4ky7jbKQMoUVA2WFYw); the exact API contract is [docs/api/openapi.yaml](docs/api/openapi.yaml) (see [docs/api/README.md](docs/api/README.md)).

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
  process/                  Sign-in, account access (register, reset) and event-delivery orchestration
  security/                 Password hashing, access tokens, sealing of stored secrets
  db/
    config/                 PostgreSQL pool and tenant transactions
    entity/                 Database row validation
    raw/query/              Parameterized SQL
    raw/mapper/             Rows to business objects
    raw/repository/         Query execution
    service/                Database operations exposed to business code
  cache/                    Redis configuration and atomic session persistence
  mongo/                    Config, entity, repository and service for events
  storage/                  Uploaded files behind one interface: local disk or S3
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
6. Put a signing key in `.env` (`npm run auth:keygen`), then create the first administrator: insert the account with `scripts/provision-account.sql` and give it a password with `npm run auth:set-password` (see Authentication below). Nobody becomes an administrator by registering.
7. Start `npm run dev` and, in another terminal, `npm run dev:worker`.

`npm run build` produces `dist/`; `npm start` and `npm run start:worker` run compiled code. Production injects environment values from its secret manager; the running application never fetches or chooses secrets based on business logic. Startup validates configuration and connections before accepting traffic. The worker currently shares the same validated deployment configuration but does not connect to Redis.

## Authentication

The application runs its own sign-in: email and password today, Google next, phone codes after that. There is no external identity provider. [docs/design/authentication.md](docs/design/authentication.md) records why, how it works, what it protects against and what is still open; read it before changing anything here.

| Endpoint                                                      | Protection / result                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                                            | Public, process liveness                                                                                                                                                                                                                                                            |
| `GET /health/ready`                                           | Public, PostgreSQL + Redis availability; 503 on failure                                                                                                                                                                                                                             |
| `GET /api/v1/public/tenant`                                   | Known active tenant; public branding/config only                                                                                                                                                                                                                                    |
| `POST /api/v1/auth/register`                                  | Public, same-origin. Emails a link; creates nothing. Always 202, whether or not the email has an account                                                                                                                                                                            |
| `POST /api/v1/auth/verify-email`                              | Public, same-origin. Opens the emailed link: creates the account and signs in like a login                                                                                                                                                                                          |
| `POST /api/v1/auth/login`                                     | Public, same-origin. Checks email and password, sets the HttpOnly session cookie, returns the tokens                                                                                                                                                                                |
| `POST /api/v1/auth/password/forgot`                           | Public, same-origin. Emails a reset link when the email has an account. Always 202                                                                                                                                                                                                  |
| `POST /api/v1/auth/password/reset`                            | Public, same-origin. New password from the emailed link; ends every session of the account                                                                                                                                                                                          |
| `GET /api/v1/auth/methods`                                    | Public. Which ways of signing in are on (`password`, `google`)                                                                                                                                                                                                                      |
| `POST /api/v1/auth/google/start`                              | Public, same-origin. Starts a Google sign-in or registration; returns Google's address and sets the single-use attempt cookie                                                                                                                                                       |
| `GET /api/v1/auth/google/callback`                            | Where Google sends the browser back. Sets the session cookie and redirects (to the dashboard, the password step, or login with an error code). Never returns tokens                                                                                                                 |
| `GET /api/v1/auth/google/pending`                             | Whose account is waiting for its password before Google is linked to it                                                                                                                                                                                                             |
| `GET /api/v1/auth/google/signup`                              | Who Google says is signing up, for the page that asks them to agree to the terms                                                                                                                                                                                                    |
| `POST /api/v1/auth/google/signup`                             | Public, same-origin. Agreements given: creates the member (no password) from Google's name and email, and signs in                                                                                                                                                                  |
| `POST /api/v1/auth/phone/start`                               | Public, same-origin. Sends a six-digit code by text message for a `purpose` (`login` or `register`). A code to log in goes only to a registered number; any other is told 404 `PHONE_NOT_REGISTERED`. Only allowed countries (Bangladesh by default). Limited per number and agency |
| `POST /api/v1/auth/phone/verify`                              | Public, same-origin. Checks the code: signs in (200) or asks the person to finish registering (202 and a cookie)                                                                                                                                                                    |
| `GET /api/v1/auth/phone/signup`                               | The proven number waiting to finish registering                                                                                                                                                                                                                                     |
| `POST /api/v1/auth/phone/signup`                              | Public, same-origin. Name and agreements: creates the member (no email, no password) and signs in                                                                                                                                                                                   |
| `GET /api/v1/me/sign-in-methods`                              | The signed-in account's email, phone (partly hidden), password and Google                                                                                                                                                                                                           |
| `POST /api/v1/me/phone/start`, `POST /api/v1/me/phone/verify` | Signed in. Add or change the account's number with a code                                                                                                                                                                                                                           |
| `POST /api/v1/auth/login`                                     | Public, same-origin. Email **or** phone number, with the password. Starts a session. No text message is sent                                                                                                                                                                        |
| `POST /api/v1/me/password`                                    | Signed in, with a verified phone. A new password, proved by a code to the account's own phone. Ends every session                                                                                                                                                                   |
| `POST /api/v1/me/reauth/start`                                | Signed in, phone-only account. Sends a code to the account's own phone, to prove it is the owner                                                                                                                                                                                    |
| `POST /api/v1/me/email/start`                                 | Signed in. With that code and an address, emails a link (the address is only added when the link is opened)                                                                                                                                                                         |
| `POST /api/v1/auth/email/confirm`                             | Public, same-origin. Opens that link: adds the verified email to the account that asked. Signs nobody in                                                                                                                                                                            |
| `POST /api/v1/auth/google/link`                               | Public, same-origin. Approves the link with the account's password and signs in like a login                                                                                                                                                                                        |
| `POST /api/v1/auth/session`                                   | Session cookie + same-origin `Origin`; returns an access token and the CSRF token. Used after a reload or in a new tab                                                                                                                                                              |
| `POST /api/v1/auth/refresh`                                   | Session cookie + same-origin `Origin` + `X-CSRF-Token`; returns a new access token                                                                                                                                                                                                  |
| `POST /api/v1/auth/logout`                                    | Same browser protection; ends the session                                                                                                                                                                                                                                           |
| `GET /api/v1/me`                                              | Bearer access token + live session + current local account                                                                                                                                                                                                                          |

New routes require authentication unless explicitly declared public. Staff routes declare allowed roles; resource ownership/assignment checks belong in the relevant use case. A role or agency inside a token, or sent by the client, is never an authorization source: the account is read from the database on every request.

**How a session works.** `POST /auth/login` creates a session: a random id in an HttpOnly cookie (`SameSite=Strict`, `__Host-` prefixed and `Secure` in production), with its state in Redis. The response carries a short-lived (default 10 minutes) ES256 **access token** and a **CSRF token**. The page keeps both in memory only; the API accepts the access token only while the session behind it is alive (Redis stores a hash of the token, never the token). Refresh issues a new access token for the same session and does not extend it: a session ends `SESSION_TTL_SECONDS` after sign-in. Sign-out, a password reset and a disabled account cut off the tokens at once. An account keeps at most `MAX_SESSIONS_PER_ACCOUNT` sessions; the oldest are signed out. Serialize refresh calls in the frontend: duplicate concurrent calls return `409 REFRESH_UNAVAILABLE`.

**Passwords.** Hashed with Argon2id (Node's built-in implementation, OWASP's minimum settings; the settings live inside each hash, and a stronger setting upgrades old hashes on the next sign-in). 10 to 128 characters, no composition rules, a short list of well-known passwords refused. Passwords are NFKC-normalised, so look-alike forms are one password. An unknown email, an account with no password and a wrong password all fail the same way and take about as long. After 5 wrong passwords for one email, sign-in for that email pauses for 15 minutes (the count follows the email, not the visitor, so it also protects emails that have no account).

**Registration.** `POST /auth/register` checks the answers and stores them sealed (AES-256-GCM, with the password already hashed) in Redis for 24 hours, then emails a link. No account exists yet, so an address nobody proved cannot be claimed, and nothing is stored in PostgreSQL for someone who never opens the link. Opening the link (`POST /auth/verify-email`) creates the member account, its password, the consent records (with the document versions that were agreed to) and an `account.registered` event in one transaction, and starts a session like a login (only the request that created the account gets one; an address that already has an account is refused like a used link). The role is always `member`. Because "this person is a member" is private on a matrimony site, registering with an address that already has an account answers exactly the same, and emails the owner a notice instead of a link. One address can be sent 3 emails of each kind per hour.

**Forgotten password.** `POST /auth/password/forgot` emails a one-hour, single-use link when the address has an active account (the answer is the same either way). `POST /auth/password/reset` sets the password, records `auth.password_reset`, ends every session of the account and emails the owner that it changed.

**Sign-in with a phone number.** Turned on by `SMS_DRIVER=console` (development: the text, with its code, is printed in the backend terminal; production refuses it until a real gateway is added behind `SmsSender`). A code is six digits, works once for 5 minutes, survives four wrong guesses and is stored only as a keyed fingerprint. Asking answers the same for every number; one code a minute and five an hour per number and 2000 a day per agency bound the cost. A right code signs in the number's account, or, with no account, leads to a page for a name and the terms before a member (no email, no password) is created. A number is added to an existing account only by its signed-in owner with a code, and never attaches on the number alone. See [authentication](docs/design/authentication.md).

**Sign-in with Google.** Turned on by `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (both, or neither). The authorization-code flow with PKCE, state and nonce: the attempt is sealed in Redis for 5 minutes and carried by a single-use cookie, and the ID token's issuer, audience, nonce, expiry and **signature** (against Google's published keys) are all checked. Only an email Google has confirmed counts. Google's own tokens are never stored; after the identity is known the session, tokens and role lookup are exactly those of a password login. Rules: an identity already linked signs in; a login with no account creates nothing until the person agrees to the terms on the page that follows Google (`/signup-google`); registering with Google needs the same agreements as an email registration, checked before leaving; the new member has no password (`forgot password` can add one). **Google is never attached to an existing account because the emails match.** The person is sent to the password step and must give that account's password (wrong ones share the sign-in pause); an account with no password cannot be linked until one is set. Each agency's exact callback address (`https://<host>/api/v1/auth/google/callback`) must be registered with Google, with no wildcards.

**Email delivery.** `MAIL_DRIVER=console` prints each email, with its link, in the backend terminal (development only; production refuses it). `MAIL_DRIVER=smtp` sends through any SMTP service with `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS` (`starttls` by default; `none` is refused in production), `SMTP_USER` and `SMTP_PASSWORD`. Emails are plain text in Bengali or English and name the agency. The links point at the host the request arrived on, which must be a configured agency hostname; a forwarded header can never change them.

**Keys and secrets.** `AUTH_JWT_PRIVATE_KEY` signs access tokens: generate one with `npm run auth:keygen`, keep it in the secret manager, and use a different key for each environment. Replacing it signs everyone out of their current access tokens (sessions continue; the next refresh signs a new token). `SESSION_ENCRYPTION_KEY` seals the pending registrations.

**Operator commands.** An administrator or staff member who cannot use "forgot password" yet gets a password with
`npm run auth:set-password -- --agency <uuid> --email <email>` (add `--account <uuid>` to also write the email onto an account that has none). It reads the password without echoing it and uses the migration connection. A verified identity never automatically becomes an administrator.

Use same-origin frontend/API routing. Forwarded-host headers are ignored. Configure the ingress to preserve the allowlisted Host, strip spoofed forwarding headers and perform per-client rate limiting. The API also uses Redis-backed limits; with `trustProxy: false`, requests through one proxy share its IP bucket. Do not change to `trustProxy: true` without a bounded trusted-proxy configuration. Production requires HTTPS ingress, secure host-only cookies, verified database/Mongo TLS and `rediss://`.

The terms and privacy texts are **drafts** (`TERMS_VERSION` and `PRIVACY_VERSION` in `src/bo/registration.ts`, texts in the frontend message files). Change the versions when the final text is published; each acceptance is stored with the version it was given for.

## Database and crucial events

Each process owns one bounded PostgreSQL pool; the worker also owns one MongoClient pool. API requests never create pools. Every domain query runs in a transaction with transaction-local `app.agency_id`. Runtime roles cannot be superusers or bypass RLS. Runtime grants currently allow account/tenant reads and outbox operations; feature write grants are introduced with their use cases. Migration credentials must never be provided to the HTTP request layer.

For an approval/payment/interest workflow, call `EventDbService.append(tx, event)` inside the same transaction as its business mutation. The event catalog accepts only IDs, event type/version, timestamp and correlation ID—not arbitrary payloads, biodata or tokens. PostgreSQL commits both or neither. The worker leases one due event per agency, idempotently upserts Mongo by event ID, and acknowledges only its current lease. Failed delivery retries with bounded backoff/jitter; exhausted events remain in PostgreSQL. Mongo downtime does not prevent the API from committing events.

Authentication spans Redis and PostgreSQL, so it is not a distributed transaction. Login/refresh events record the authorized operation before session persistence and do not prove token delivery to a browser. Logout prioritizes local revocation even if the subsequent audit write fails; that failure produces an HTTP/server error and needs operational investigation. Domain events do have transaction-level durability.

Alert on `EVENT_DELIVERY_FAILED` with `exhausted: true`, worker absence, and the oldest undelivered outbox row. Investigate provider/storage failures before replaying an exhausted row; reset its attempts/next-attempt time through an authorized tenant-scoped operator transaction. Define retention and purge delivered outbox rows only after the required audit retention period. Mongo event reads are not exposed by the scaffold; future reads must filter by agency and authorization.

## Uploaded files (member photos)

Files are stored through one interface (`src/storage/service/file-storage.ts`), so where they live is configuration, not code:

| `STORAGE_DRIVER`  | Use                                                                                          | Settings                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local` (default) | Development and a single server                                                              | `STORAGE_LOCAL_DIR` (default `./storage`, git-ignored)                                                                                                                                                                                    |
| `s3`              | Production. Amazon S3 or any S3-compatible store (Cloudflare R2, DigitalOcean Spaces, MinIO) | `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE=true` for non-AWS stores, optional `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (without them the AWS credential chain, for example an instance role, is used) |

To move to S3, create a **private** bucket, set the values above and restart. Existing files must be copied across under the same keys (`agency/profile/photo.size.webp`); the database stores only the key. Production refuses to start with `local`, because a second server could not see the first one's files. The S3 driver is tested against a stand-in client, so verify it once against the real bucket before launch.

Photos are never public. The API checks who is asking and streams the image; a bucket must not allow public reads. Uploads are decoded and re-encoded as WebP, which removes location and camera data and anything hidden in the file.

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

These tests create schemas/test roles and rows in that named test database. They verify real RLS/rollback, pooled-context reset, Redis refresh races, outbox lease fencing and Mongo idempotency. The sign-in flows have their own PostgreSQL and Redis tests (`test/integration/registration.test.ts`, `auth-state.test.ts`, `auth-flow.test.ts`); email delivery is tested against a local SMTP server, so it still needs a first run against the real mail service. See [validation record](docs/design/scaffold-validation.md).

The Dockerfile runs compiled code as a non-root user. Run the same image with `node dist/worker.js` for the worker. Run migrations from a separate operator/release environment before deployment, never automatically during API startup. Roll back application images only while the schema remains backward-compatible; there is no destructive automatic down migration. Budget database connections as replicas × pool limit, and provision managed-service backups, alerts and worker supervision before live launch.

## Approval queue and client management

Routes (staff only): `GET /api/v1/reviews`, `/reviews/summary`, `/reviews/:id`, `/reviews/:id/photo`, `POST /reviews/:id/approve` and `/reject`; `GET/POST /api/v1/staff/clients`, `GET/PUT /staff/clients/:profileId`, `POST .../submit`, `.../edit-requests`, `.../status`, `DELETE .../pending-review`, `PUT .../assignment` (admin only), `GET /api/v1/admin/staff` (admin only). The contract is in `docs/api/openapi.yaml`.

Rules, enforced in the services (`review-service.ts`, `client-service.ts`, `profile-service.ts`) and by the database:

- **Who sees what.** An admin sees everything. An agent sees the requests assigned to them and unassigned ones, and only their own clients.
- **Four eyes.** Nobody decides a request they sent themselves, except an admin (`REVIEW_OWN_SUBMISSION`).
- **Stale requests.** A request records the profile version it was made against. If the profile has changed, or the reviewer's `profileVersion` is not the current one, approval is refused with 409 `REVIEW_OUT_OF_DATE`. Deciding locks the rows, so two reviewers cannot both decide.
- **Rejecting** a change to a published profile leaves the profile untouched. Approving a photo publishes it and makes it the main photo if there is none.
- **Clients.** An assisted client has no login (`owner_account_id` is NULL, `service_mode = 'assisted'`) and is edited by staff through the same review flow as a member. Staff can see a self-service member and change its status, never its content (`PROFILE_SELF_SERVICE`). Status moves follow `STATUS_MOVES` in `src/bo/access.ts`; a closed profile is final. Only an admin assigns a client, to an active admin or agent.
- **Migration 006** changes the version trigger so that changing only `assigned_agent_id` does not bump the profile version (which would make waiting requests stale); any other update still does.
- **Paging** uses a cursor built from a microsecond `position` string, because JavaScript dates lose microseconds and the last row would otherwise repeat.

Staff are invited from the Staff page: `GET/POST /api/v1/admin/staff/invitations`, `POST /api/v1/admin/staff/invitations/:id/resend`, `DELETE /api/v1/admin/staff/invitations/:id` (admins only), and the invited person uses the public `POST /api/v1/auth/staff-invitation/preview` and `/accept` (see [authentication](docs/design/authentication.md)).

Not built yet: client photos, disabling or removing staff, changing a staff member's role.
