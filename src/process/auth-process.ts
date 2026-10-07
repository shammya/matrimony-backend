import { randomBytes, randomUUID } from 'node:crypto';
import type { AccessTokens } from '../security/access-token.js';
import { digest } from '../security/secret-box.js';
import type { Session, SessionRepository } from '../cache/repository/session-repository.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import type { CredentialService } from '../service/credential-service.js';
import type { IdentityService } from '../service/identity-service.js';
import type { EventDbService } from '../db/service/event-db-service.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { LoginInput } from '../bo/credentials.js';
import { AppError } from '../exception/app-error.js';

/** Wrong passwords allowed for one email before sign-in pauses, and how long it pauses. */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_SECONDS = 900;

export interface SessionOptions {
  /** How long a session lasts in total, however often it is refreshed. */
  sessionTtl: number;
  /** How long one access token lasts. */
  accessTtl: number;
  /** Sessions kept per account; the oldest are ended beyond this. */
  maxSessions: number;
}

const secret = () => randomBytes(32).toString('base64url');

/**
 * Sign-in and the browser session behind it.
 *
 * A session is a random id kept in an HttpOnly cookie, with its state in Redis. Each short-lived
 * access token is tied to that session by its hash, so ending the session (sign-out, password
 * reset, a disabled account) cuts off its tokens at once. The session ends at its absolute expiry
 * however often it is refreshed.
 */
export class AuthProcess {
  constructor(
    private readonly credentials: Pick<CredentialService, 'verify'>,
    private readonly accessTokens: Pick<AccessTokens, 'issue' | 'verify'>,
    private readonly sessions: Pick<
      SessionRepository,
      'put' | 'get' | 'forAccess' | 'remove' | 'claim' | 'finalize' | 'limit'
    >,
    private readonly identities: Pick<IdentityService, 'account'>,
    private readonly throttle: Pick<ThrottleRepository, 'peek' | 'hit' | 'clear'>,
    private readonly events: Pick<EventDbService, 'record'>,
    private readonly options: SessionOptions,
  ) {}

  /**
   * Checks an email and password and starts a session. After five wrong passwords for the same
   * email, sign-in pauses for 15 minutes (even for the right password), which stops guessing.
   * The count follows the email, not the visitor, so the pause is the same for an email that
   * has no account.
   */
  async login(agencyId: string, input: LoginInput, correlationId: string) {
    const counter = `login:${agencyId}:${digest(input.email)}`;
    const attempts = await this.throttle.peek(counter);
    if (attempts.count >= MAX_FAILED_LOGINS)
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', { retryAfter: attempts.retryAfter });

    let account;
    try {
      account = await this.credentials.verify(agencyId, input.email, input.password);
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_CREDENTIALS')
        await this.throttle.hit(counter, LOCKOUT_SECONDS);
      throw error;
    }
    await this.throttle.clear(counter);

    // A new id for every sign-in, so nothing a visitor held before signing in carries over.
    const id = secret();
    const key = digest(id);
    const token = await this.accessTokens.issue(account.id, this.options.accessTtl);
    const session: Session = {
      agencyId,
      accountId: account.id,
      accessHash: digest(token.token),
      csrf: secret(),
      expiresAt: Math.floor(Date.now() / 1000) + this.options.sessionTtl,
    };
    await this.audit('auth.login', session, correlationId);
    await this.sessions.put(key, session, this.remaining(token.expiresAt));
    await this.sessions.limit(account.id, this.options.maxSessions);
    return {
      sessionId: id,
      accessToken: token.token,
      csrfToken: session.csrf,
      expiresIn: this.remaining(token.expiresAt),
    };
  }

  async authenticate(agencyId: string, token: string) {
    const { accountId } = await this.accessTokens.verify(token);
    const session = await this.sessions.forAccess(digest(token));
    if (
      !session ||
      session.agencyId !== agencyId ||
      session.accountId !== accountId ||
      session.expiresAt <= Date.now() / 1000
    )
      throw new AppError(401, 'SESSION_INVALID');
    // Read fresh on every request: a disabled account or a changed role applies immediately.
    return this.identities.account(agencyId, accountId);
  }

  /**
   * Starts or restores a browser session from its cookie alone. The browser has no CSRF
   * token right after a reload, and the server never stores an access token (only its hash),
   * so this issues a new access token for the session, using the CSRF token the session
   * already holds. The caller must have checked the same-origin rule; the cookie is HttpOnly
   * and host-only.
   */
  async bootstrap(agencyId: string, id: string, correlationId: string) {
    const session = await this.sessions.get(digest(id));
    if (!session || session.agencyId !== agencyId) throw new AppError(401, 'SESSION_INVALID');
    return this.refresh(agencyId, id, session.csrf, correlationId);
  }

  async refresh(agencyId: string, id: string, csrf: string, correlationId: string) {
    const key = digest(id);
    const claim = secret();
    const session = await this.sessions.claim(key, csrf, agencyId, claim);
    if (!session) throw new AppError(409, 'REFRESH_UNAVAILABLE');
    try {
      if (session.expiresAt <= Date.now() / 1000) throw new AppError(401, 'SESSION_EXPIRED');
      await this.identities.account(agencyId, session.accountId);
      const token = await this.accessTokens.issue(session.accountId, this.options.accessTtl);
      const next: Session = { ...session, accessHash: digest(token.token) };
      delete next.claim;
      await this.audit('auth.refresh', next, correlationId);
      if (!(await this.sessions.finalize(key, claim, next, this.remaining(token.expiresAt))))
        throw new AppError(401, 'SESSION_INVALID');
      return {
        accessToken: token.token,
        csrfToken: next.csrf,
        expiresIn: this.remaining(token.expiresAt),
      };
    } catch (error) {
      await this.sessions.remove(key);
      throw error;
    }
  }

  async logout(agencyId: string, id: string, csrf: string, correlationId: string) {
    const key = digest(id);
    const session = await this.sessions.get(key);
    if (!session) return;
    if (session.agencyId !== agencyId || session.csrf !== csrf)
      throw new AppError(403, 'CSRF_INVALID');
    await this.sessions.remove(key);
    // Local logout stays effective even if auditing fails.
    await this.audit('auth.logout', session, correlationId);
  }

  private remaining(expiresAt: number) {
    return Math.max(1, Math.floor(expiresAt - Date.now() / 1000));
  }

  private audit(type: WorkflowEvent['type'], session: Session, correlationId: string) {
    return this.events.record({
      id: randomUUID(),
      agencyId: session.agencyId,
      actorId: session.accountId,
      subjectId: session.accountId,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
    });
  }
}
