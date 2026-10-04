import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IdentityProvider } from '../security/oidc-provider.js';
import type { JwtVerifier } from '../security/jwt-verifier.js';
import { SecretBox, digest } from '../security/secret-box.js';
import type { SessionRepository, Session } from '../cache/repository/session-repository.js';
import type { IdentityService } from '../service/identity-service.js';
import type { EventDbService } from '../db/service/event-db-service.js';
import type { WorkflowEvent } from '../bo/event.js';
import { AppError } from '../exception/app-error.js';
import type { Logger } from 'pino';
const challengeSchema = z.object({
  agencyId: z.uuid(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  redirectUri: z.string().url(),
});
const secret = () => randomBytes(32).toString('base64url');
export class AuthProcess {
  constructor(
    private readonly provider: IdentityProvider,
    private readonly verifier: Pick<JwtVerifier, 'verify'>,
    private readonly sessions: Pick<
      SessionRepository,
      | 'put'
      | 'get'
      | 'forAccess'
      | 'remove'
      | 'claim'
      | 'finalize'
      | 'putChallenge'
      | 'takeChallenge'
    >,
    private readonly identities: Pick<IdentityService, 'account'>,
    private readonly events: Pick<EventDbService, 'record'>,
    private readonly box: SecretBox,
    private readonly ttl: number,
    private readonly logger: Logger,
  ) {}
  async begin(agencyId: string, redirectUri: string) {
    const id = secret();
    const challenge = {
      agencyId,
      redirectUri,
      state: secret(),
      nonce: secret(),
      verifier: secret(),
    };
    await this.sessions.putChallenge(
      digest(id),
      this.box.seal(JSON.stringify(challenge), digest(id)),
    );
    return { challengeId: id, authorizationUrl: await this.provider.authorize(challenge) };
  }
  async complete(agencyId: string, challengeId: string, url: URL, correlationId: string) {
    const raw = await this.sessions.takeChallenge(digest(challengeId));
    if (!raw) throw new AppError(401, 'OAUTH_CHALLENGE_EXPIRED');
    const challenge = challengeSchema.parse(JSON.parse(this.box.open(raw, digest(challengeId))));
    if (
      challenge.agencyId !== agencyId ||
      new URL(challenge.redirectUri).origin !== url.origin ||
      new URL(challenge.redirectUri).pathname !== url.pathname
    )
      throw new AppError(401, 'OAUTH_CONTEXT_MISMATCH');
    const tokens = await this.provider.exchange(url, challenge);
    const identity = await this.verifier.verify(tokens.accessToken);
    if (!tokens.subject || tokens.subject !== identity.subject)
      throw new AppError(401, 'OAUTH_SUBJECT_MISMATCH');
    const account = await this.identities.account(agencyId, identity.issuer, identity.subject);
    const id = secret();
    const key = digest(id);
    const session: Session = {
      agencyId,
      accountId: account.id,
      subject: identity.subject,
      issuer: identity.issuer,
      accessHash: digest(tokens.accessToken),
      refreshSecret: this.box.seal(tokens.refreshToken, key),
      csrf: secret(),
      expiresAt: Math.floor(Date.now() / 1000) + this.ttl,
    };
    await this.audit('auth.login', session, correlationId);
    await this.sessions.put(key, session, this.remaining(identity.expiresAt));
    return {
      sessionId: id,
      accessToken: tokens.accessToken,
      csrfToken: session.csrf,
      expiresIn: this.remaining(identity.expiresAt),
    };
  }
  async authenticate(agencyId: string, token: string) {
    const identity = await this.verifier.verify(token);
    const session = await this.sessions.forAccess(digest(token));
    if (
      !session ||
      session.agencyId !== agencyId ||
      session.subject !== identity.subject ||
      session.issuer !== identity.issuer ||
      session.expiresAt <= Date.now() / 1000
    )
      throw new AppError(401, 'SESSION_INVALID');
    const account = await this.identities.account(agencyId, identity.issuer, identity.subject);
    if (account.id !== session.accountId) throw new AppError(401, 'SESSION_INVALID');
    return { ...account, subject: identity.subject };
  }
  async refresh(agencyId: string, id: string, csrf: string, correlationId: string) {
    const key = digest(id);
    const claim = secret();
    const session = await this.sessions.claim(key, csrf, agencyId, claim);
    if (!session) throw new AppError(409, 'REFRESH_UNAVAILABLE');
    try {
      if (session.expiresAt <= Date.now() / 1000) throw new AppError(401, 'SESSION_EXPIRED');
      await this.identities.account(agencyId, session.issuer, session.subject);
      const tokens = await this.provider.refresh(this.box.open(session.refreshSecret, key));
      const identity = await this.verifier.verify(tokens.accessToken);
      if (identity.subject !== session.subject || identity.issuer !== session.issuer)
        throw new AppError(401, 'OAUTH_SUBJECT_MISMATCH');
      const next: Session = {
        ...session,
        refreshSecret: this.box.seal(tokens.refreshToken, key),
        accessHash: digest(tokens.accessToken),
      };
      delete next.claim;
      await this.audit('auth.refresh', next, correlationId);
      if (!(await this.sessions.finalize(key, claim, next, this.remaining(identity.expiresAt)))) {
        await this.revokeSafely(tokens.refreshToken);
        throw new AppError(401, 'SESSION_INVALID');
      }
      return {
        accessToken: tokens.accessToken,
        csrfToken: next.csrf,
        expiresIn: this.remaining(identity.expiresAt),
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
    // Local logout stays effective even if auditing or provider revocation fails.
    await this.revokeSafely(this.box.open(session.refreshSecret, key));
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
  private async revokeSafely(token: string) {
    try {
      await this.provider.revoke(token);
    } catch {
      this.logger.error(
        { code: 'OIDC_REVOCATION_FAILED' },
        'Provider revocation failed; local session remains invalid',
      );
    }
  }
}
