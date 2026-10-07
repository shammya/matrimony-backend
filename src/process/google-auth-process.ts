import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import {
  displayNameFrom,
  googleChallengeSchema,
  type GoogleChallenge,
  pendingGoogleLinkSchema,
  pendingGoogleSignupSchema,
  type GoogleSignupInput,
  type GoogleStartInput,
} from '../bo/google.js';
import type { Registration } from '../bo/registration.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../bo/registration.js';
import type { OneTimeTokenRepository } from '../cache/repository/one-time-token-repository.js';
import type { SessionRepository } from '../cache/repository/session-repository.js';
import { AppError } from '../exception/app-error.js';
import type { GoogleIdentityProvider } from '../security/google-provider.js';
import { SecretBox, digest } from '../security/secret-box.js';
import type { CredentialService } from '../service/credential-service.js';
import type { RegistrationService } from '../service/registration-service.js';
import type { AuthProcess } from './auth-process.js';

const PENDING_LINK_SECONDS = 600;
const secret = () => randomBytes(32).toString('base64url');

/**
 * A sign-in that failed after its attempt was read. It carries the language the person was
 * reading, so the browser can be sent back to the login page in that language and not the
 * agency's default.
 */
export class GoogleSignInError extends AppError {
  constructor(
    error: AppError,
    public readonly locale: 'bn' | 'en',
  ) {
    super(error.status, error.code, error.details);
  }
}

/** A started sign-in: the browser is sent to `authorizationUrl`, and `challengeId` goes in a cookie. */
export interface StartedGoogleSignIn {
  challengeId: string;
  authorizationUrl: string;
}

/**
 * How a Google sign-in ended. Both carry the language the person was reading.
 *  - `session`: they are signed in (the session cookie must be set).
 *  - `link`: their email already belongs to an account, so they must prove they own it with its
 *    password before Google is attached to it (the pending-link cookie must be set).
 *  - `signup`: they have no account yet, so they are asked to agree to the terms before one is
 *    created (the pending-signup cookie must be set).
 */
export type GoogleOutcome =
  | { kind: 'session'; locale: 'bn' | 'en'; sessionId: string }
  | { kind: 'link'; locale: 'bn' | 'en'; pendingId: string }
  | { kind: 'signup'; locale: 'bn' | 'en'; pendingId: string };

/**
 * Signing in and registering with Google.
 *
 * - Google only proves who the person is (a confirmed email and a stable id). Everything after
 *   that is ours: the same session, tokens and role lookup as any other sign-in.
 * - An identity that is already linked signs in. A new person may register, but only after the
 *   agreements: either ticked before they left (registering), or on a page that follows Google
 *   (a login that found no account). Nothing is created until they agree.
 * - Google is never attached to an existing account because the emails match: that would let
 *   whoever controls a look-alike Google account take over the account. The owner must give the
 *   account's password first, and wrong passwords count toward the same pause as at sign-in.
 */
export class GoogleAuthProcess {
  constructor(
    private readonly google: GoogleIdentityProvider,
    private readonly sessions: Pick<SessionRepository, 'putChallenge' | 'takeChallenge'>,
    private readonly tokens: Pick<OneTimeTokenRepository, 'put' | 'peek' | 'take'>,
    private readonly registrations: Pick<
      RegistrationService,
      'findByIdentity' | 'registerExternal' | 'linkIdentity'
    >,
    private readonly credentials: Pick<CredentialService, 'findByEmail'>,
    private readonly auth: Pick<AuthProcess, 'checkPassword' | 'startSession'>,
    private readonly box: SecretBox,
    private readonly logger: Logger,
  ) {}

  async start(
    agencyId: string,
    origin: string,
    input: GoogleStartInput,
  ): Promise<StartedGoogleSignIn> {
    const id = secret();
    const attempt = {
      state: secret(),
      nonce: secret(),
      verifier: secret(),
      redirectUri: `${origin}/api/v1/auth/google/callback`,
    };
    // The authorization address first: if Google cannot be reached nothing is stored.
    const authorizationUrl = await this.google.authorize(attempt);
    const challenge = {
      agencyId,
      ...attempt,
      intent: input.intent,
      locale: input.locale,
      ...(input.intent === 'register'
        ? {
            agreements: {
              onBehalfOfOther: input.onBehalfOfOther,
              termsVersion: TERMS_VERSION,
              privacyVersion: PRIVACY_VERSION,
            },
          }
        : {}),
    };
    await this.sessions.putChallenge(
      digest(id),
      this.box.seal(JSON.stringify(challenge), digest(id)),
    );
    return { challengeId: id, authorizationUrl };
  }

  async complete(
    agencyId: string,
    challengeId: string,
    url: URL,
    correlationId: string,
  ): Promise<GoogleOutcome> {
    const raw = await this.sessions.takeChallenge(digest(challengeId));
    if (!raw) throw new AppError(401, 'OAUTH_CHALLENGE_EXPIRED');
    const challenge = googleChallengeSchema.parse(
      JSON.parse(this.box.open(raw, digest(challengeId))),
    );
    try {
      return await this.finish(agencyId, challenge, url, correlationId);
    } catch (error) {
      // From here on the language of the attempt is known, so a failure carries it.
      throw error instanceof AppError && !(error instanceof GoogleSignInError)
        ? new GoogleSignInError(error, challenge.locale)
        : error;
    }
  }

  private async finish(
    agencyId: string,
    challenge: GoogleChallenge,
    url: URL,
    correlationId: string,
  ): Promise<GoogleOutcome> {
    const expected = new URL(challenge.redirectUri);
    if (
      challenge.agencyId !== agencyId ||
      expected.origin !== url.origin ||
      expected.pathname !== url.pathname
    )
      throw new AppError(401, 'OAUTH_CONTEXT_MISMATCH');

    const profile = await this.google.exchange(url, challenge);
    // A sign-in vouched for by an address Google has not confirmed proves nothing.
    if (!profile.emailVerified) throw new AppError(403, 'GOOGLE_EMAIL_UNVERIFIED');
    const identity = {
      provider: 'google' as const,
      subject: profile.subject,
      email: profile.email,
    };
    const locale = challenge.locale;

    const linked = await this.registrations.findByIdentity(agencyId, 'google', profile.subject);
    if (linked) {
      if (linked.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
      return this.signedIn(agencyId, linked.account, locale, correlationId);
    }

    const existing = await this.credentials.findByEmail(agencyId, profile.email);
    if (existing) {
      if (existing.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
      // Without a password there is nothing to prove ownership with. The owner can set one with
      // "forgot password" (their email is proven that way too) and then link Google.
      if (!existing.passwordHash) throw new AppError(409, 'ACCOUNT_HAS_NO_PASSWORD');
      const pendingId = secret();
      const pending = {
        accountId: existing.account.id,
        subject: profile.subject,
        email: profile.email,
        locale,
      };
      await this.tokens.put(
        'google-link',
        existing.account.id,
        this.pendingKey(agencyId, pendingId),
        this.box.seal(JSON.stringify(pending), this.pendingKey(agencyId, pendingId)),
        PENDING_LINK_SECONDS,
      );
      return { kind: 'link', locale, pendingId };
    }

    // No account yet. Registering already carries the agreements, so the account is made now.
    // A login that found nothing does not make one: the person is asked to agree first.
    if (challenge.intent !== 'register' || !challenge.agreements) {
      const pendingId = secret();
      const key = this.pendingKey(agencyId, pendingId);
      const pending = {
        subject: profile.subject,
        email: profile.email,
        name: displayNameFrom(profile.name, profile.email),
        locale,
      };
      await this.tokens.put(
        'google-signup',
        digest(profile.subject),
        key,
        this.box.seal(JSON.stringify(pending), key),
        PENDING_LINK_SECONDS,
      );
      return { kind: 'signup', locale, pendingId };
    }
    const registration: Registration = {
      displayName: displayNameFrom(profile.name, profile.email),
      locale,
      ...challenge.agreements,
    };
    const created = await this.registrations.registerExternal(
      agencyId,
      { ...identity, displayName: registration.displayName },
      registration,
      correlationId,
    );
    // Someone registered this address an instant ago: start over, the sign-in will find it.
    if (!created.created) throw new AppError(409, 'GOOGLE_RETRY');
    return this.signedIn(agencyId, created.account, locale, correlationId);
  }

  /** Who Google says is signing up, for the page that asks them to agree to the terms. */
  async pendingSignup(agencyId: string, pendingId: string) {
    const key = this.pendingKey(agencyId, pendingId);
    const sealed = await this.tokens.peek('google-signup', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingGoogleSignupSchema.parse(JSON.parse(this.box.open(sealed, key)));
    return { email: pending.email, name: pending.name };
  }

  /**
   * Creates the account for a Google person who agreed to the terms, and signs them in. The step is
   * used up first, so a double press cannot create twice. The identity and email are the ones
   * Google vouched for, never anything sent now.
   */
  async signup(
    agencyId: string,
    pendingId: string,
    input: GoogleSignupInput,
    correlationId: string,
  ) {
    const key = this.pendingKey(agencyId, pendingId);
    const sealed = await this.tokens.take('google-signup', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingGoogleSignupSchema.parse(JSON.parse(this.box.open(sealed, key)));
    const registration: Registration = {
      displayName: pending.name,
      locale: pending.locale,
      onBehalfOfOther: input.onBehalfOfOther,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    };
    const created = await this.registrations.registerExternal(
      agencyId,
      {
        provider: 'google',
        subject: pending.subject,
        email: pending.email,
        displayName: pending.name,
      },
      registration,
      correlationId,
    );
    // Someone made an account for this address in the meantime: start again, Google will find it.
    if (!created.created) throw new AppError(409, 'GOOGLE_RETRY');
    return {
      locale: pending.locale,
      ...(await this.auth.startSession(agencyId, created.account, correlationId)),
    };
  }

  /** Whose account is waiting to be linked, for the page that asks for the password. */
  async pending(agencyId: string, pendingId: string) {
    const pending = await this.readPending(agencyId, pendingId);
    return { email: pending.email };
  }

  /**
   * Approves the link with the account's password, links Google, and signs the person in. A wrong
   * password does not use the attempt up (the person can retry), but counts toward the pause.
   */
  async link(agencyId: string, pendingId: string, password: string, correlationId: string) {
    const pending = await this.readPending(agencyId, pendingId);
    const account = await this.auth.checkPassword(agencyId, pending.email, password);
    if (account.id !== pending.accountId) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const linked = await this.registrations.linkIdentity(
      agencyId,
      account.id,
      { provider: 'google', subject: pending.subject, email: pending.email },
      correlationId,
    );
    if (!linked) throw new AppError(409, 'GOOGLE_ALREADY_LINKED');
    await this.tokens.take('google-link', this.pendingKey(agencyId, pendingId));
    this.logger.info({ code: 'GOOGLE_LINKED' }, 'A Google identity was linked to an account');
    return {
      locale: pending.locale,
      ...(await this.auth.startSession(agencyId, account, correlationId)),
    };
  }

  private async signedIn(
    agencyId: string,
    account: Parameters<AuthProcess['startSession']>[1],
    locale: 'bn' | 'en',
    correlationId: string,
  ): Promise<GoogleOutcome> {
    const session = await this.auth.startSession(agencyId, account, correlationId);
    return { kind: 'session', locale, sessionId: session.sessionId };
  }

  /** The agency is part of the key, so a pending link only exists for the agency it started at. */
  private pendingKey(agencyId: string, pendingId: string) {
    return digest(`${agencyId}.${pendingId}`);
  }

  private async readPending(agencyId: string, pendingId: string) {
    const key = this.pendingKey(agencyId, pendingId);
    const sealed = await this.tokens.peek('google-link', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return pendingGoogleLinkSchema.parse(JSON.parse(this.box.open(sealed, key)));
  }
}
