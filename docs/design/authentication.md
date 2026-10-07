# Authentication

Decision record and design, 7 October 2026. It replaces the external OAuth/OIDC provider design in the [scaffold plan](backend-scaffold-plan.md#authentication).

**Status:** email and password registration and sign-in, password reset, sessions and email delivery are implemented and tested. Google sign-in and phone codes are not built yet. Nothing here has been reviewed by an experienced backend or security reviewer, which [AGENTS.md](../../AGENTS.md) requires before a live release.

## Decision

The application runs its own sign-in instead of using an identity provider (Auth0 was used in development).

- **Problem.** Auth0 charges per monthly active user, and its phone-code sign-in needs a paid plan (roughly 35 USD a month for 500 users and about 700 a month for 10,000, from third-party summaries; confirm on Auth0's page). The platform is for Bangladeshi agencies, where that cost is large, and the SMS gateway has to be paid for separately anyway.
- **Alternatives considered.** Stay on Auth0 (nothing to build, recurring cost); Supabase Auth, SuperTokens or Keycloak (free or cheaper, but each is another service to run, each changes the login flow, and Keycloak has no phone-code sign-in without a custom Java plugin); build it ourselves.
- **Recommendation taken.** Build it ourselves, with the same session design the scaffold already had (Redis sessions, CSRF, absolute expiry), so the work is mostly replacing the provider.
- **Cost.** We own the security of the flow and its upkeep: key rotation, abuse monitoring, patches. A reviewer must look at it before launch.
- **Reversal.** Sign-in sits behind `AuthProcess` and `AccountAccessProcess`. Accounts still carry `auth_issuer` and `auth_subject` (now `local` and the account id), so a provider could be attached again later without a data migration. The unused `openid-client` package was removed; Google sign-in will add its client back when it is built.

## How it works

```text
register ──► Redis: pending registration (sealed, password already hashed) ──► email with link
link opened ──► PostgreSQL, one transaction: account + password hash + consents + event
login ──► Argon2id check ──► Redis session + cookie ──► ES256 access token + CSRF token (JSON)
every request ──► verify token signature ──► live session (Redis) ──► account read from PostgreSQL
```

| Piece | Where |
|---|---|
| Password hashing (Argon2id, Node built-in) | `src/security/password-hasher.ts` |
| Access tokens (ES256, 10 minutes) | `src/security/access-token.ts` |
| Rules for passwords and inputs | `src/bo/credentials.ts`, `src/bo/registration.ts` |
| Sign-in, session, refresh, sign-out | `src/process/auth-process.ts` |
| Register, verify email, forgot and reset password | `src/process/account-access-process.ts` |
| Checking and changing passwords | `src/service/credential-service.ts` |
| Creating the member account | `src/service/registration-service.ts` |
| Sessions, one-time links, counters (Redis) | `src/cache/repository/` |
| Passwords in PostgreSQL (`account_credentials`, RLS) | `migrations/007_password_auth.sql` |
| Email (console for development, SMTP) | `src/mail/` |

## What it protects against

| Threat | Control | Evidence |
|---|---|---|
| Stolen password database | Argon2id, per-hash salt, parameters stored in the hash and upgraded on sign-in; passwords never logged or echoed | `password-hasher.test.ts`, `auth-flow.test.ts` |
| Guessing passwords | 5 wrong passwords pause that email for 15 minutes (also for emails with no account); 10 sign-ins a minute per client address | `auth.test.ts`, `auth-flow.test.ts` |
| Finding out who is a member (private on a matrimony site) | Same answer, status and shape for known and unknown emails at sign-in, register and forgot-password; the same hashing work in both branches; emails are sent in the background so timing does not tell | `credential-service.test.ts`, `account-access.test.ts`, `auth-flow.test.ts` |
| Claiming someone else's email | The account does not exist until the emailed link is opened, and the password is chosen by whoever registered, so a link can only be used by the owner of the inbox | `account-access.test.ts` |
| Reusing or guessing links | 256-bit tokens, only hashed or sealed copies stored, single use (atomic `GETDEL`), 24 hours for registration and 1 hour for reset, cancelled by a newer request, bound to the agency and to the purpose | `auth-state.test.ts`, `account-access.test.ts` |
| Tokens from another agency, or a forged token | Host-resolved agency, signature, algorithm (ES256 only), issuer, audience, type, scope, expiry, and the live session must name the same account and agency | `access-token.test.ts`, `auth.test.ts` |
| Roles from a token or the client | The role is read from PostgreSQL on every request; registration can only create a member; extra request fields are refused | `credentials.test.ts`, `auth-http.test.ts` |
| Cross-site requests | Same-origin check on every sign-in, registration and reset call; `SameSite=Strict` cookie; CSRF token on refresh and sign-out | `auth-http.test.ts` |
| A stolen or old session | Ends at its absolute expiry; sign-out, password reset and a disabled account end it at once; the oldest sessions of an account are signed out beyond 10 | `auth-flow.test.ts`, `auth-state.test.ts` |
| Header injection and spoofed links | Email links are built only from the validated agency host; the sender address cannot hold a line break | `auth-http.test.ts`, `security.test.ts` |
| Leaks in logs and events | Events hold ids only; failures log a code, never an address, link or password | `account-access.test.ts`, `auth-flow.test.ts` |
| Tenant mix-ups | Row-level security on `account_credentials`; every query is by agency; the same email at two agencies is two accounts | `integration/registration.test.ts` |

## Defaults chosen without the product owner (please confirm)

These are my defaults, not requirements from the client.

- Access token 10 minutes; session 8 hours from sign-in, never extended (the scaffold's value, kept). A matrimony site may want a longer session.
- Password: 10 to 128 characters, no composition rules, a short list of common passwords refused, no check against breached-password lists, no server-side "pepper".
- 5 wrong passwords pause an email for 15 minutes. This lets anyone pause someone else's sign-in for 15 minutes; it is the usual trade-off.
- 3 emails per address per hour for each of registration and reset.
- At most 10 sessions per account.
- Registering is not allowed for an address that already has an account, even a disabled one.
- The emails are plain text, in the person's language, and use the agency name; there is no per-agency sender address yet.

## Not built yet

- **Google sign-in** (next). It must never attach to an existing account by email alone, only create a session for an identity already linked, or link after the person proved the account with their password (see AGENTS.md). It needs the one-time challenge store (state, nonce, PKCE) that was removed with the provider.
- **Phone codes.** Needs an SMS gateway adapter (an interface like `Mailer`, with a development version that prints the code, so the tunnel used with Auth0 is no longer needed) and the same account linking rule. Phone-only members created before this change have no email or password and cannot sign in until one is set with `npm run auth:set-password`.
- **Email delivery service.** The SMTP adapter works with any provider but has only been tested against a local SMTP server. Choose a provider, verify the sender domain (SPF, DKIM, DMARC) and send a real test.
- Change password while signed in, a list of devices with remote sign-out, staff invitation by email, multi-factor authentication, a breached-password check, a different sender per agency.
- `test/integration/resources.test.ts` (MongoDB) was not run during this change.

## Operating it

- Keep `AUTH_JWT_PRIVATE_KEY` and `SESSION_ENCRYPTION_KEY` in the secret manager, one pair per environment. Replacing the signing key signs people out of their current access tokens only; the next refresh signs a new one. Replacing the session key makes pending registrations unreadable (people register again).
- Redis holds sessions, pending registrations and counters, so Redis being down means nobody can sign in (as before). Registration emails are not retried: a failed send is logged as `MAIL_SEND_FAILED` and the person asks again.
- Watch for: `MAIL_SEND_FAILED`, many `TOO_MANY_ATTEMPTS` or `EMAIL_RATE_LIMITED` responses (guessing or email bombing), and sign-in failures after a deploy.
- New dependencies: `nodemailer` (the standard Node SMTP client, for the SMTP adapter) and, for tests only, `smtp-server`. Password hashing uses Node's built-in Argon2 and needs no package.
