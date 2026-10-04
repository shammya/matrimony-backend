# Scaffold validation — 4 October 2026

- Node.js 24.21.0 used for verification (downloaded into a temporary directory; system Node unchanged).
- `npm run check`: TypeScript strict checks, ESLint, dependency direction/cycle checks, 12 unit/HTTP tests and production build passed.
- Real resource integration suite passed: 5 scenarios (6 test-runner results including the parent), using separate temporary PostgreSQL 15.12, Redis 7.2.4 and MongoDB 7.0.2 instances.
- Integration coverage: migrations applied twice safely; RLS across two tenants; rollback and tenant context reset on a reused connection; atomic outbox rollback; stale lease fencing; idempotent Mongo upsert; atomic Redis refresh claims; logout preventing stale refresh finalization; runtime superuser rejection.
- `npm audit --audit-level=high`: zero reported vulnerabilities across the installed lockfile at verification time.
- Frontend repository unchanged. No application deployment, production migration, live identity-provider call or payment was performed.

The identity provider was represented by test doubles in auth-process/HTTP tests; JWT tests used real generated RSA keys and JOSE verification. Discovery, authorization-code exchange, provider refresh rotation/revocation and actual phone OTP delivery still require acceptance tests against the selected provider and its configured audience/scopes. No provider credentials were supplied.

Compose and Docker image definitions were written but not executed because Docker is unavailable on this machine. Equivalent isolated native services were used for integration tests. GitHub Actions is configured for both suites but has not run remotely. Temporary test services were stopped after verification.

The scaffold provides infrastructure and a minimal account/public-config slice. It does not implement the 20 product features or claim production readiness without provider/deployment acceptance testing.
