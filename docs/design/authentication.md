# Authentication

Decision record and design, 7 October 2026. It replaces the external OAuth/OIDC provider design in the [scaffold plan](backend-scaffold-plan.md#authentication).

**Status:** email and password registration and sign-in, password reset, sessions, email delivery, Google sign-in and phone codes are implemented and tested. A real SMS gateway and a mobile device-session mode are not built yet. Nothing here has been reviewed by an experienced backend or security reviewer, which [AGENTS.md](../../AGENTS.md) requires before a live release.

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

## Sign-in with Google

Added 8 October 2026, directly with Google (not through Firebase or another service: the backend stays the one place that knows who is signed in, there is no extra service or cost, and the same code can verify a Google ID token from the future React Native app).

```text
start (agreements checked) ──► Redis: sealed attempt (state, nonce, PKCE verifier) ──► Google
callback ──► attempt used once ──► code exchange + ID token checks ──► one of:
   identity already linked ......... session (like any login)
   email has an account ............ password step: Google is linked only after that account's password
   no account, intent = register ... member created (no password) + identity + consents + event, then session
   no account, intent = login ...... nothing created: the person agrees to the terms on a page, then the same
                                     as above (member created, no password, + identity + consents + event + session)
```

| Piece | Where |
|---|---|
| Talking to Google (discovery, PKCE, ID token and signature checks) | `src/security/google-provider.ts` |
| What a Google sign-in means (the rules above) | `src/process/google-auth-process.ts` |
| Inputs and the sealed records | `src/bo/google.ts` |
| Creating and linking identities | `src/service/registration-service.ts`, `migrations/008_external_identities.sql` |

- **Why a password step instead of linking by email.** Linking on matching emails lets whoever controls a look-alike Google account take over an existing account (and was the classic pre-hijacking route). Our own accounts only exist for emails proven by a link, so the risk is smaller than elsewhere, but proving ownership with the password is the safe default and costs one step, once. It reuses the sign-in pause, so it cannot be used to guess passwords around it.
- **Found by Google's id, not the email**, so a changed Google email still signs in.
- **The ID token's signature is checked by us** against Google's keys. The OIDC rules would let a token that came straight from the token endpoint over TLS skip that, and the library does skip it; a test of ours showed a forged token being accepted, so the check was added.
- **Cookies.** The attempt cookie is Lax (Google sends the browser back from another site) and single use. The password-step cookie and the session cookie are Strict.
- **New dependency:** `openid-client` (discovery, PKCE, state, nonce and the token exchange), which had been removed with Auth0 and is back.

## Sign-in with a phone number and a code

Added 8 October 2026. The same three outcomes as Google, and the same session afterwards.

```text
ask for a code ──► SMS: six digits, 5 minutes, one use ──► check the code ──► one of:
   the number has an account ........ session (like any login)
   no account ....................... nothing created: name + terms on a page, then the member is
                                      created (no email, no password) + consents + event, then session
```

| Piece | Where |
|---|---|
| Number rules (E.164, Bangladeshi forms, Bengali digits) and the inputs | `src/bo/phone.ts` |
| What a phone sign-in means (limits, codes, outcomes) | `src/process/phone-auth-process.ts` |
| Codes in Redis (atomic check, wrong-guess count) | `src/cache/repository/phone-code-repository.ts` |
| Sending (interface, development console sender, the text) | `src/sms/sender.ts`, `src/sms/messages.ts` |
| Accounts by number, creating one, adding a number | `src/service/registration-service.ts`, `migrations/009_phone_sign_in.sql` |

- **Same answer for every number.** Asking for a code sends one and answers 202 whether or not the number has an account, because "this person is a member" is private on a matrimony site. Only after a right code do the paths differ, and then the person has proved they hold the number.
- **The code.** Six digits from a cryptographic generator, stored only as an HMAC keyed by the session encryption key (a plain hash of six digits could be reversed in a moment if Redis leaked). It works once, for 5 minutes, survives 4 wrong guesses (the 5th cancels it), and asking again replaces it. The check is one atomic Redis script, so many guesses at once cannot get more tries.
- **Cost and abuse limits.** One code a minute and 5 an hour per number, 2000 a day per agency, and 10 requests per 10 minutes per address. Every text costs money, and an open "send" button is how people get flooded with texts.
- **Never attached by number alone.** An existing account gets a number only from its signed-in owner, who proves it with a code (`/me/phone/start` and `/me/phone/verify`). Codes are scoped to the account that asked, so a code meant for adding cannot sign anyone in, and one sent for one account cannot add the number to another. A number already used by another account is refused after the proof (409 `PHONE_IN_USE`).
- **Phone-only members** have no email and no password. They cannot use "forgot password". They can add an email later only once there is a flow for it (not built).
- **Recycled numbers.** A phone company can give a number to someone new. A phone-only account has no second factor against that; an account with an email and password is only reachable by the number once its owner added it. Worth the reviewer's attention.
- **Sender.** `SMS_DRIVER=console` prints the text, with its code, in the backend terminal for development, and the configuration refuses it in production. With no driver set, phone sign-in is not offered. A real gateway is another `SmsSender` implementation. Nothing about a gateway's API is assumed here: it must time out and throw when the message is not accepted.

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
| A look-alike or unconfirmed Google account | Only an email Google has confirmed counts; linking to an existing account needs its password; the link step shares the sign-in pause; the identity is Google's id | `google-auth.test.ts`, `google-provider.test.ts`, `integration/auth-flow.test.ts` |
| A forged, replayed or foreign Google callback | State, nonce and PKCE; the attempt is single use and bound to the agency and callback address; the ID token's issuer, audience, expiry and signature are checked | `google-provider.test.ts`, `google-auth.test.ts` |
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

- **A mobile device-session mode** for the React Native app: tokens in the response body, a rotating refresh token stored hashed with reuse detection, no cookies, and an endpoint that accepts a Google ID token from the phone's own Google sign-in (our Android and iOS client ids as accepted audiences). The Google identity check and the account rules are already written apart from the web redirect, so this adds only a small endpoint. On the tracker as `b0-12`.
- **Google, not yet checked against the real Google.** Everything of ours is tested, and the adapter against a local stand-in for Google, but a real sign-in with your Google Cloud client is the first live check. Moving the consent screen from Testing to production needs a published privacy policy.
- **Unlinking Google**, and showing which sign-in methods an account has.
- **A real SMS gateway.** Phone codes work with the development console sender. A gateway that reaches Bangladeshi numbers reliably, with its price and sender-name rules checked, plugs into `SmsSender`; the first real send is the live check. Phone-only members created before phone sign-in (by the old Auth0 flow) have no verified number, so they cannot sign in by phone until they add it, and have no email or password until one is set with `npm run auth:set-password`.
- **Adding an email or a password to a phone-only account**, and changing a number with a stronger check than the signed-in session plus a code on the new number (for example asking the password first).
- **Email delivery service.** The SMTP adapter works with any provider but has only been tested against a local SMTP server. Choose a provider, verify the sender domain (SPF, DKIM, DMARC) and send a real test.
- Change password while signed in, a list of devices with remote sign-out, staff invitation by email, multi-factor authentication, a breached-password check, a different sender per agency.
- `test/integration/resources.test.ts` (MongoDB) was not run during this change.

## Operating it

- Keep `AUTH_JWT_PRIVATE_KEY` and `SESSION_ENCRYPTION_KEY` in the secret manager, one pair per environment. Replacing the signing key signs people out of their current access tokens only; the next refresh signs a new one. Replacing the session key makes pending registrations unreadable (people register again).
- Redis holds sessions, pending registrations and counters, so Redis being down means nobody can sign in (as before). Registration emails are not retried: a failed send is logged as `MAIL_SEND_FAILED` and the person asks again.
- Watch for: `MAIL_SEND_FAILED`, many `TOO_MANY_ATTEMPTS` or `EMAIL_RATE_LIMITED` responses (guessing or email bombing), and sign-in failures after a deploy.
- New dependencies: `openid-client` (Google) and `nodemailer` (the standard Node SMTP client, for the SMTP adapter) and, for tests only, `smtp-server`. Password hashing uses Node's built-in Argon2 and needs no package.
