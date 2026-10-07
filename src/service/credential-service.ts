import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { CredentialRecord } from '../bo/credentials-record.js';
import type { Account } from '../bo/identity.js';
import type { CredentialDbService } from '../db/service/credential-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { PasswordHasher } from '../security/password-hasher.js';

/**
 * Checking and changing passwords.
 *
 * Signing in fails the same way (and takes about as long) whether the email is unknown, has no
 * password, or has a different password, so the response cannot be used to find out who has an
 * account.
 */
export class CredentialService {
  constructor(
    private readonly db: Pick<
      CredentialDbService,
      'byEmail' | 'byId' | 'rehash' | 'setPasswordWithEvent'
    >,
    private readonly hasher: Pick<
      PasswordHasher,
      'hash' | 'verify' | 'needsRehash' | 'verifyAgainstNothing'
    >,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  hash(password: string): Promise<string> {
    return this.hasher.hash(password);
  }

  /** The account for an email, whatever its status. Null when there is none. */
  findByEmail(agencyId: string, email: string): Promise<CredentialRecord | null> {
    return this.db.byEmail(agencyId, email);
  }

  findById(agencyId: string, accountId: string): Promise<CredentialRecord | null> {
    return this.db.byId(agencyId, accountId);
  }

  /** The account when the email and password are right. Otherwise 401, or 403 for a disabled account. */
  async verify(agencyId: string, email: string, password: string): Promise<Account> {
    const found = await this.db.byEmail(agencyId, email);
    if (!found?.passwordHash || found.status === 'invited') {
      await this.hasher.verifyAgainstNothing(password);
      throw new AppError(401, 'INVALID_CREDENTIALS');
    }
    if (!(await this.hasher.verify(password, found.passwordHash)))
      throw new AppError(401, 'INVALID_CREDENTIALS');
    // Said only after the password was right, so it does not reveal accounts to strangers.
    if (found.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
    await this.upgradeHash(agencyId, found.account.id, password, found.passwordHash);
    return found.account;
  }

  /**
   * Sets a new password and records `auth.password_reset` in the same transaction. False when
   * the account cannot sign in (it was disabled after the link was sent).
   */
  async setPassword(
    agencyId: string,
    accountId: string,
    hash: string,
    correlationId: string,
  ): Promise<boolean> {
    return this.db.setPasswordWithEvent(agencyId, accountId, hash, {
      id: randomUUID(),
      agencyId,
      actorId: accountId,
      subjectId: accountId,
      type: 'auth.password_reset',
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    });
  }

  /** A stronger hash is stored after a correct sign-in. It must never turn a sign-in into a failure. */
  private async upgradeHash(agencyId: string, accountId: string, password: string, old: string) {
    if (!this.hasher.needsRehash(old)) return;
    try {
      await this.db.rehash(agencyId, accountId, await this.hasher.hash(password), old);
    } catch {
      this.logger.warn({ code: 'PASSWORD_REHASH_FAILED' }, 'Could not store the upgraded hash');
    }
  }
}
