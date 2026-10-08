# Project handoff: read this first

Last updated: 8 October 2026 (late evening). If you are a coding agent that has just been opened on this project, read this file completely, then the files listed in [Where to read next](#where-to-read-next). Then tell the user, in about ten lines, what you understood, and wait.

This file lives in the **backend** repo. The **frontend** repo has a shorter `PROJECT.md` that points here.

## 1. What this project is

A **white-label, multi-tenant matrimony platform for Bangladeshi marriage agencies**.

- The first agency (tenant) is **Marriage Solution BD (MSBD)**. Each agency gets its own hostname, branding and members; one deployment serves many agencies.
- **Bengali-first** and mobile-friendly. Every screen exists in Bengali (`bn`, the default) and English (`en`).
- **Roles:** `admin` and `agent` (agency staff) and `member` (the people looking for a match, or a parent registering for a son, daughter or relative).
- **Money:** basic access is free; members pay for subscriptions through **bKash** (each agency has its own merchant account); assisted-service fees are negotiated and recorded by hand by agents.
- **Scope:** 20 launch features, 14 full-depth and 6 thin, defined in `docs/design/launch-features.md`. Excluded on purpose: CMS, chat, PDF biodata, a tenant admin UI, a super-admin portal, agency SaaS billing.
- A **React Native mobile app** is planned for later. Nothing of it exists yet.

## 2. The people and how we work

- The **user** is a frontend-focused full-stack developer who builds **both repos**. They want production-grade work ("like the best production application"), not a demo.
- The **friend** (a Java developer) wrote the backend scaffold and the design documents in `docs/design/` and only helps occasionally. **Do not edit his documents** (everything in `docs/design/` except `authentication.md`, which is ours). Report disagreements instead of silently changing them.
- Working style the user asked for:
  - **Short answers, main points only.** No long explanations unless asked.
  - Work in **small vertical slices** (one user journey through database, backend and frontend), and **finish a phase in order** before starting the next.
  - **Statuses must be honest:** "In review" until the user has tried it in a real browser; "Done" only with evidence or the user's say-so.
  - After each task, update the tracker (below) and the docs.
  - **Never paste or print secrets** (the Google client secret, signing keys, database passwords). They live only in the backend `.env`.
  - Use **they/them** for people whose pronouns are not stated.
- The backend has strict engineering rules in [AGENTS.md](AGENTS.md) (layering, tests required for SQL and sessions, versioned migrations, security review before launch). Follow them.

## 3. Repositories and stack

| Repo | GitHub | Stack |
|---|---|---|
| `backend` (this one) | `shammya/matrimony-backend` | Node 24, TypeScript (strict), Fastify, PostgreSQL 17 with row-level security, Redis (sessions and one-time codes), MongoDB (event copy, optional), `sharp` for photos, S3-compatible storage |
| `frontend` | `shammya/launchpad-mvp` (branch `nextjs-migration`) | Next.js 16 (App Router), TypeScript, Tailwind 4, shadcn/ui, next-intl, TanStack Query, React Hook Form + Zod, Vitest, Playwright |

The two repos sit **side by side** (for example `…/matromony/backend` and `…/matromony/frontend`). The frontend generates its API types from `backend/docs/api/openapi.yaml`, so they must be next to each other.

How the agency is chosen: **the request's `Host` header**, mapped by `TENANT_HOSTS` in the backend `.env`. The browser calls `/api/v1/...` on the Next.js origin, a proxy route forwards it to the backend **with the original `Host`**. Never choose the agency from user input.

## 4. How to run it on a new machine

Needed: Node 24, PostgreSQL 17, Redis **6.2 or newer** (the code uses `GETDEL`; on Windows install Redis inside WSL, the Windows build is too old), optionally MongoDB (only the event worker and one integration test need it).

**Backend** (`backend/`):

1. `npm ci`
2. `cp .env.example .env` and fill it in. You must set: the `DATABASE_URL` and `MIGRATION_DATABASE_URL` roles, `SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`), `AUTH_JWT_PRIVATE_KEY` (`npm run auth:keygen`), `PORT=4000` (so it does not clash with Next.js on 3000), `TENANT_HOSTS`. For development also keep `MAIL_DRIVER=console` and `SMS_DRIVER=console` (emails and text messages are **printed in the backend terminal**). `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are optional: without them the Google button is simply hidden.
3. Start PostgreSQL and Redis (`docker compose up -d` works, or use local installs).
4. `npm run db:migrate` (uses `MIGRATION_DATABASE_URL`; migrations are numbered `001`…`009` and are never edited once applied).
5. Seed the local agency and runtime role with `scripts/local-seed.sql` (see README, "Local setup").
6. Create the first administrator: `scripts/provision-account.sql`, then `npm run auth:set-password -- --agency <uuid> --email <email>`.
7. `npm run dev` (API on 4000). `npm run dev:worker` is only for the MongoDB event copy.

**Frontend** (`frontend/`): `npm ci`, `cp .env.example .env.local` (`BACKEND_URL=http://127.0.0.1:4000`), `npm run dev`, open `http://localhost:3000`. The hostname `localhost` is the seeded agency.

**Checks before you hand work back:**

- Backend: `npm run check` (types, lint, dependency rules, unit and HTTP tests, build). Integration tests need real services: `TEST_DATABASE_URL` (database **named `matrimony_scaffold_test`**) and `TEST_REDIS_URL`, then `npm run test:integration`.
- Frontend: `npm run check`, then `npm run test:e2e` (browser tests against a stand-in backend, `tests/e2e/stub-backend.mjs`; first run `npx playwright install chromium`).
- Known, unrelated failures: 2 About-page browser tests (`public-pages.spec.ts`, the first line of the agency text appears twice). Do not "fix" them while doing other work; report them.

Neither repo's `.env`, `.env.local`, `storage/` or `node_modules/` is in git. A new machine has to recreate them.

## 5. The plan: phases and where we are

The 20 features are numbered as in `docs/design/launch-features.md` (1.1 … 5.3). The order is **foundation, then onboarding and approval, then discovery, then the paid loop, then hardening**. There are no dates, only this order.

Status key: **Done** = confirmed by the user in a real browser (or proven by tests where no screen exists). **Review** = built and tested, waiting for the user to try it. **-** = not started.

### Phase 0: Foundation (complete, except the items marked)

| Item | Backend | Frontend |
|---|---|---|
| Platform base, tenants, public config | Done | Done |
| Public shell, signed-in shell, role guards, language switch, theming | n/a | Done |
| i18n (bn/en parity, formats), form helpers | n/a | Done |
| Email + password login, session restore, refresh, logout | Done (login) / Review (restore, refresh) | Done (login) |
| Forgot / reset password | Review (user says it works) | Review |
| Account emails (console and SMTP drivers) | Review | n/a |
| Sign in with Google | Done | Done |
| Sign in with a phone number and code | **Review** (built 8 Oct) | **Review** |
| Add an email to a phone-only account (code to their own phone, then a link) | **Review** (built 8 Oct) | **Review** |
| Password at phone registration, login with phone + password, change password with a code to the phone | **Review** (built 8 Oct) | **Review** |
| Event log (outbox → MongoDB worker) | Review (worker never run here: no MongoDB) | n/a |
| Local environment | Done | Done |
| Tests and CI | n/a | Done (CI workflow written, never run on GitHub) |
| Device sessions for the mobile app | **Planned, deliberately skipped for now** | n/a |

### Phase 1: Public site (complete)

1.1 Homepage, 1.4 Success stories, 1.5 About and contact: **Done** on both sides. The pricing link on the homepage waits for 1.3 (Phase 4). Real agency content (logo, brand colour, branches, stories) still has to come from the client.

### Phase 2: Onboarding and approval (complete)

| Feature | Backend | Frontend |
|---|---|---|
| 1.2 Registration (email link, Google, phone) | Done (email, Google); Review (phone) | Review |
| 2.1 My Profile, edit requests, photos | Done | Done |
| 4.2 Approval queue (staff review profile changes and photos) | Done | Done |
| 4.3 Agent client management (assisted service) | Done | Done |

Not built in Phase 2: client photos, inviting staff by email.

### Phase 3: Discovery loop (not started)

3.1 Basic search, 3.2 Advanced search, 3.3 Profile detail and paywall, 2.2 My Matches, 2.3 Interest and mutual match, 2.4 Inbox.

### Phase 4: Money (not started)

1.3 Pricing page, 4.4 Plan management, 5.3 Feature gating and quotas, 5.1 bKash sandbox checkout, 5.2 Manual payment recording, 2.5 Payment status, 4.1 Admin dashboard counts.

### Phase 5: Hardening and launch (not started)

Tenant isolation proof, tests on the real stack (including MongoDB), **security review by an experienced person**, operations (backups, alerts, supervision), production deployment.

### Where the live tracker is

Two interactive tracker pages hold every feature's description, endpoints and a status with a note:

- Backend: https://claude.ai/artifact/RzGP4ky7jbKQMoUVA2WFYw
- Frontend: https://claude.ai/artifact/Ck84aYSJZ4krz5jTD9Rpnk

They belong to the original user's Claude account. **If you cannot open them, this file is the source of truth**: keep the tables above up to date instead, and tell the user so they can decide whether to rebuild the trackers.

## 6. Authentication (the largest piece of work so far)

The original design used an external identity provider (Auth0). On 7 October 2026 the user decided to drop it (cost, and phone sign-in needs a paid plan) and build the application's **own** sign-in. Full design, reasons and defences: [docs/design/authentication.md](docs/design/authentication.md). In short:

- **Three ways in, one kind of session:** email + password, Google, phone number + code. All end in the same server-side session (random id in an HttpOnly `Strict` cookie, state in Redis, 8 hours absolute), a short-lived ES256 access token kept only in browser memory, and a CSRF header on state-changing calls.
- **Passwords:** Argon2id. **Registration by email:** a link is emailed; the account is created only when the link is opened and the person confirms; that also signs them in.
- **Never link by email or phone alone.** A new way of proving identity is attached to an existing account only by its signed-in owner, or after the account's password.
- **Privacy:** answers do not reveal whether an email or phone number has an account.
- **Google:** direct (no Firebase). A login with no account asks the person to agree to the terms on a page, and one button creates the account.
- **Phone:** six-digit code, 5 minutes, single use, 5 guesses; one code a minute and 5 an hour per number, 2000 a day per agency. A new number gets a page for name, **password** and terms (the password is required, so the member can later log in with the number and it, with no text message, which also saves SMS cost); the member has no email at first.
- **Phone and password login:** `POST /auth/login` takes an email or a phone number (one of them) with the password; same answers and the same pause after five wrong passwords, counted per number.
- **Choosing a new password with a code:** a signed-in member with a verified phone can set a new password with a code to that phone (`POST /me/password`); it ends every session. It is the recovery path for a phone member without an email.
- **Adding an email to a phone-only account:** needs a code sent to the account's own phone (so a stolen session is not enough), then a link sent to the new address; opening the link stores it, verified, and signs nobody in. A password is then set with the usual forgot-password link. An existing email is never replaced.
- **Development senders:** emails and texts are printed in the backend terminal (`MAIL_DRIVER=console`, `SMS_DRIVER=console`). The configuration refuses both in production.

Not built in authentication: a real SMS gateway and a real email service, the production Google consent screen, changing an existing email, changing a password while signed in, a list of devices, two-factor for staff, device sessions for the mobile app, and the **security review**.

## 7. Decisions still open (the user or the client must answer)

- **Real email service** (SES, Brevo, SendGrid, Mailgun…) and a verified sender domain.
- **SMS gateway** that reaches Bangladeshi numbers reliably, with price and sender-name registration.
- **Google consent screen to production** (needs a published privacy policy and each agency's callback address).
- **How the mobile app finds its agency:** one branded app per agency, or one shared app where the person picks.
- **Sign-in defaults chosen without the client:** 8-hour sessions, 10-character passwords, 5 wrong passwords pause an email for 15 minutes, 3 emails an hour per address, 10 devices per account, phone code limits.
- **Biodata fields and option lists** (religion, education, income bands…): My Profile runs on development defaults listed on its tracker card.
- **Plans, prices, durations, quotas**, **bKash sandbox credentials**, **real agency content**, **the final terms and privacy texts** (placeholders now, versioned in `src/bo/registration.ts`).
- **Is MongoDB needed for launch?** Nothing reads the events yet; the PostgreSQL outbox already keeps them.
- **Digit style** in Bengali pages (Latin digits for now; one switch in the frontend).
- The `public_config` shape is a draft for the friend to review.

## 8. Things that will trip you up

- `docs/design/` (except `authentication.md`) is the friend's. Do not rewrite it.
- `docs/api/openapi.yaml` is a **pure contract** (routes, fields, error codes). Feature stories belong in the tracker, not there. It uses CRLF line endings; an unquoted `: ` in a summary breaks the frontend type generator.
- Never edit an applied migration. Add a new numbered file; migrations are run explicitly, never at startup.
- Services and processes must be `async` (guards throw as rejected promises). Cursors for lists use a microsecond `position` string.
- Real-database tests matter: a mock cannot prove row-level security, constraints or atomicity. A Postgres "inconsistent types for parameter" error has already been caught this way.
- Rate limits live in Redis and survive test runs: integration tests use random client addresses for that reason.
- Keep the frontend's stand-in backend (`tests/e2e/stub-backend.mjs`) in step with `openapi.yaml` in the same change.
- Long shell heredocs with quotes break easily on Windows; write scripts to a file instead.

## 9. Where to read next

1. [AGENTS.md](AGENTS.md): the rules for working in this repo.
2. [README.md](README.md): structure, endpoints, setup.
3. [docs/design/authentication.md](docs/design/authentication.md): the sign-in design.
4. [docs/design/launch-features.md](docs/design/launch-features.md) and [core-entities.md](docs/design/core-entities.md): what the 20 features are and the data behind them (friend's).
5. [docs/api/openapi.yaml](docs/api/openapi.yaml): the API contract.
6. In the frontend repo: `PROJECT.md`, `docs/architecture.md` and `docs/design-guidelines.md`.

## 10. Keeping this file true

When you finish a task, update section 5 (statuses), section 6 or 7 if they changed, and the "Last updated" date. Say what is verified and what is not. A wrong status here misleads the next person more than a missing one.
