# Working in this repository

## Purpose and team

Build a reliable, understandable matrimony product for MSBD, with tenant isolation underneath. The product owner owns product direction, business rules, UX acceptance and commercial decisions. The developer owns implementation, tests and explaining the change. Coding agents assist both; generated code and an AI review are not evidence of correctness by themselves.

Keep the solution simple enough for the developer to maintain. Quality means correct behavior, clear boundaries, tested failures and safe operations—not more layers, tools or infrastructure.

These instructions apply throughout this backend repository. Follow the current user request and any applicable directory-specific instructions. If requirements, documentation and code disagree, identify the discrepancy; do not silently choose a new product rule or preserve a known bug.

## Read before changing code

1. Check the working tree and relevant existing code/tests. Preserve unrelated changes.
2. Read [README.md](README.md) for setup, architecture and current limitations.
3. For product work, read the relevant rows of the [launch checklist](docs/design/launch-features.md) and [core entities](docs/design/core-entities.md).
4. For infrastructure work, read the [scaffold plan](docs/design/backend-scaffold-plan.md). It supersedes the older NestJS and opaque-session proposal in the system-design document.
5. Treat executable migrations as the applied-schema history and design documents as intent. Investigate discrepancies before changing either. Historical validation reports do not prove a new change works.

Launch scope is **20 features: 14 full-depth and 6 thin**. Implement MSBD's workflows; do not add tenant administration UI, agency SaaS billing or other deferred features without a scope decision. An existing table, endpoint skeleton or mocked demo does not make a feature complete.

## Work one user journey at a time

Scale the process to the task. A small fix can use a few sentences; a consequential feature needs a short written design. Do not require a document, three alternatives or a permission round for every edit.

### 1. Understand and define acceptance

State the actor, desired outcome, business rules and exclusions. Write observable acceptance criteria before implementation. Clarify ambiguities that change price, permissions, data visibility, consent or user-visible behavior; proceed with independent work while clarification is pending. Resolve ordinary implementation details using existing conventions.

### 2. Define the experience and contract together

For user-facing work, cover the happy path plus loading, empty, validation, permission, pending and failure states. Preserve Bengali-first and mobile usability. Coordinate the UI and backend contract before either side depends on an invented response shape. The frontend is a separate repository; changes there require relevant task scope and its own instructions.

A feature brief in the issue/PR or `docs/features/<feature>.md` should answer:

- **Outcome:** actor, story, scope and acceptance examples.
- **Experience:** actions, states, error messages and recovery.
- **Contract:** endpoint/input/output/errors and the permitted actors/resources.
- **Data:** schema changes, invariants, transaction ownership and sensitive fields.
- **Failure behavior:** duplicate/concurrent requests, timeouts, partial success and retries.
- **Evidence:** tests, staging journey, rollout and rollback where applicable.

### 3. Make important decisions explicit

For a new dependency, external service, authentication change, tenant-boundary change or consequential data/payment design, record the problem, viable alternatives, recommendation, cost and failure/reversal implications. Compare alternatives only when they are meaningful. Reuse the accepted architecture unless evidence justifies changing it.

Identify changes needing an experienced backend/security reviewer before live release: authentication/session lifecycle, tenant isolation, private-data disclosure, payment/entitlement correctness, destructive migrations and production access. Prepare concrete code and test evidence for that review; continue safe implementation and local verification. Do not substitute the product owner's business approval or another AI's confidence for technical review, and do not declare a review completed when no reviewer has assessed it.

### 4. Implement a small vertical slice

Deliver a coherent operation through its transport, business and persistence layers. Keep patches reviewable and focused. For complex rules or reproducible bugs, start with a failing behavior test. Do not add speculative abstractions, empty modules, placeholder success responses or TODO-only implementations. If part of the requested behavior cannot be completed, identify it explicitly.

### 5. Verify, review and hand off

Test against acceptance criteria, inspect the diff, and verify relevant failure paths. For a complete feature, exercise its integrated frontend/backend journey in staging with synthetic accounts. A single manual happy-path run does not replace regression tests. Clearly distinguish implemented, locally verified, provider-tested, staging-accepted and released.

## Architecture and code rules

- Use Node 24, strict TypeScript, Fastify and the existing resource-first layout. Group domains inside layers as they grow. Keep one API and one worker codebase; do not introduce microservices, a generic event bus or another ORM/framework without demonstrated need.
- Wire dependencies in `src/container.ts`. Share one bounded PostgreSQL pool per process, one Redis client where needed and one MongoClient pool in the worker. Own startup checks and graceful shutdown centrally; never create pools per request.
- Controllers and schedulers validate/translate input, invoke a service/process and translate output. Business rules belong in `service/`; multi-resource workflows belong in `process/`.
- PostgreSQL access goes through `db/service` and the query/mapper/repository layers. Mongo access goes through its service/repository. Keep `io` transport contracts, `bo` business types and persistence entities distinct where their responsibilities differ; avoid gratuitous duplicate types and pass-through layers.
- Use interfaces at replaceable external boundaries. Do not create an interface/implementation pair for every class. Keep dependency direction enforceable with the existing dependency rules; do not relax rules to hide a violation.
- Prefer clear names, small cohesive functions, early returns and explicit errors. Comments explain a non-obvious reason or invariant. Avoid unexplained constants, broad type assertions, `any`, suppressed errors and unrelated refactors.
- Use `src/config/env.ts` for runtime configuration. Update `.env.example` with safe examples when adding variables. Never hardcode real credentials or print configuration/secrets. CLI scripts may read their documented command-specific environment directly.
- External calls need timeouts. Retry only operations known to be safe, with bounds/backoff/jitter. Do not silently swallow failure or turn an unknown outcome into success.

## Security and data invariants

### Identity and tenant access

- New business routes are protected by default. Public pages, health and the sign-in, registration and password-reset endpoints have explicit, documented exceptions and their own validation/abuse controls.
- Sign-in is the application's own (see [authentication](docs/design/authentication.md); it replaced the external OAuth/OIDC provider on 7 October 2026). Validate access-token signature, algorithm, issuer, audience, expiry and required scope, and require the live session behind it. Never treat a decoded-but-unverified JWT, a role or agency inside a token, or a client-supplied role as API authorization.
- Preserve the server-side session (random id in an HttpOnly cookie, state in Redis), absolute session expiry, CSRF/origin checks on every state-changing browser route, atomic refresh claims, local logout invalidation, and ending every session on a password reset. Passwords are only ever stored as Argon2id hashes; one-time tokens only as hashes or sealed. Responses that take an email address must not reveal whether it has an account. Never put tokens in URLs (an emailed one-time link is the only exception, and it is single use) or in persistent browser storage. When adding Google or phone sign-in, a new way of proving identity must never attach to an existing account by email or phone alone, and must create the same kind of session.
- Resolve agency context from the trusted hostname mapping. Re-read local account status/role and enforce ownership or agent assignment for the specific operation. An authenticated member is not authorized to access every row in their agency.
- Every tenant-owned query, relationship, event and future storage/cache key must preserve tenant isolation. Run PostgreSQL work on the same acquired connection inside a transaction with transaction-local agency context. RLS complements explicit predicates and business authorization; it does not replace them.
- Validate current state and authorization-sensitive conditions inside the write transaction when they can race. Use database constraints and appropriate locks for invariants; application checks alone are insufficient for concurrent writes. Never give the runtime a superuser, schema-owner workaround or RLS-bypass role.

### Transactions, payments and events

- One use case owns its transaction. Repositories accept that transaction instead of opening hidden nested transactions. Parameterize SQL, release connections on all paths and avoid external network calls while holding database locks.
- Use integer minor units and server-owned order/plan snapshots for money. Payment callbacks are signals, not proof. Verify provider account/environment, reference, amount, currency and final status server-side. Keep sandbox access and revenue separate from production.
- Define idempotency and concurrent-request behavior for payments, approvals, interests and quotas. Never blindly retry an ambiguous charge or grant access on a browser assertion. Preserve unresolved state for reconciliation.
- Append crucial domain events to the PostgreSQL outbox in the business transaction. Deliver to MongoDB with stable IDs, idempotent upserts and lease fencing. Delivery is at least once; do not promise distributed exactly-once behavior.
- Preserve the documented distinction between transactional domain events and authentication events spanning Redis/provider/PostgreSQL. Do not claim an atomic transaction across those systems.
- Use safe response projections and metadata-only logs/events. Exclude contact details, biodata, internal notes, tokens and arbitrary request bodies unless explicitly required in an authorized response. Use synthetic test data; do not send production secrets or member data to AI tools.

### Schema and operations

- Add versioned migrations; never rewrite an applied migration. Use separate operator credentials and explicit migration commands. Do not run production migrations during application startup.
- Prefer additive, backward-compatible changes. For destructive/backfill work, document data impact, backup/restore, deployment ordering and recovery before execution. Do not invent an automatic down migration that would discard user data.
- Bound page sizes, database queries, uploads and resource use. Avoid N+1 queries and full-table application filtering; add indexes from actual access patterns. Do not optimize through new infrastructure without evidence.
- Keep provider integration behavior grounded in official documentation and the configured sandbox contract. Do not invent API fields, signatures, callback guarantees or delivery guarantees.

## Verification expectations

| Change | Required evidence |
|---|---|
| Documentation-only | Check accuracy, referenced paths and diff; application tests need not run |
| Business rule or bug | Focused behavior tests, including the relevant regression/edge case |
| Route or permissions | HTTP validation, response projection and denied-access tests |
| SQL, tenant, session or event persistence | Real-resource integration tests for the affected behavior; mocks cannot prove RLS, constraints or atomicity |
| Concurrent/financial workflow | Duplicate requests, race/retry behavior, partial failure and recovery tests |
| External provider | Adapter tests plus sandbox acceptance; report live-provider checks that were not possible |
| User-facing feature | Integrated staging journey including errors, permissions and Bengali/mobile states |

For executable changes, run `npm run check` before handoff. Run `npm run test:integration` when relevant, using the isolated resources and environment described in the README. Run `npm audit` when dependencies change and before release; investigate findings rather than applying blind breaking fixes. Update the lockfile with intentional dependency changes.

Tests should prove observable behavior, not mirror implementation or assert arbitrary coverage percentages. Never delete assertions, skip a failing test, disable TLS/RLS/authentication or weaken lint/types to obtain a green result. If a tool, credential or environment blocks a check, report the exact limitation and mark that evidence unverified. Once relevant checks pass, avoid redundant reruns without a new change or concern.

## Developer learning and completion

Explain the approach briefly before a substantial edit, then explain the important invariant or trade-off with a concrete example. Avoid lectures and unexplained terminology. Point to the entry point, coordinating service/process and persistence operation so the developer can trace a request. Keep useful decisions in repository documentation rather than only chat history.

Finish with:

1. What changed and which acceptance criteria it satisfies.
2. Where the behavior lives and why the main decision was made.
3. Tests/checks run and their actual outcomes, including anything unverified.
4. Remaining work, risks and reviewer/deployment actions where applicable.

The developer should be able to explain the request flow, permissions, transaction and likely failure/recovery path before merging consequential work. Help them understand these; do not require a quiz or block routine coding work.

Update relevant docs and mark a launch feature complete only when its full acceptance criterion has evidence. Prefer a focused branch/PR for shared work. Commit, push or deploy when requested; follow an explicit request to target `main` rather than inventing an extra approval loop. Never overwrite unrelated changes, force-push, reset history or change live infrastructure without the applicable authorization.
