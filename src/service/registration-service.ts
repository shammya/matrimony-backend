import { randomUUID } from 'node:crypto';
import type { Account } from '../bo/identity.js';
import { consentsFor, type Registration } from '../bo/registration.js';
import { AppError } from '../exception/app-error.js';
import type { FoundAccount } from '../db/raw/repository/registration-repository.js';
import type { RegistrationDbService } from '../db/service/registration-db-service.js';

/** What was typed at registration and has since been proven by opening the emailed link. */
export interface VerifiedRegistration {
  email: string;
  passwordHash: string;
  registration: Registration;
}

export type CreateResult = { created: true; account: Account } | { created: false };

/** Who a provider such as Google says someone is. The subject is its stable id, never the email. */
export interface ExternalIdentity {
  provider: 'google';
  subject: string;
  /** Lower-case, and already confirmed by the provider as belonging to this person. */
  email: string;
}

/**
 * Creating a member's account.
 *
 * - The role is always `member`. Nothing the person sends can change it.
 * - The email must have been proven before this is called: the account is created only when the
 *   emailed link is opened, and it is stored as verified.
 * - The account, its password, the consent records and an event are written in one transaction.
 * - An email that already has an account never gets a second one, and its password is never
 *   replaced here: that is what a password reset is for.
 */
export class RegistrationService {
  constructor(
    private readonly db: Pick<
      RegistrationDbService,
      'findByEmail' | 'findByIdentity' | 'inTransaction'
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async emailRegistered(agencyId: string, email: string): Promise<boolean> {
    return (await this.db.findByEmail(agencyId, email)) !== null;
  }

  /** The account linked to this provider identity, whatever its status. Null when none is. */
  findByIdentity(
    agencyId: string,
    provider: ExternalIdentity['provider'],
    subject: string,
  ): Promise<FoundAccount | null> {
    return this.db.findByIdentity(agencyId, provider, subject);
  }

  /**
   * Creates a member from a provider's confirmed identity. No password is made: the person signs
   * in through the provider (and may add a password later through "forgot password"). The account,
   * the identity, the consents and an event are written in one transaction. Never used when the
   * email already has an account: that is a link the owner must approve with their password.
   */
  async registerExternal(
    agencyId: string,
    identity: ExternalIdentity & { displayName: string },
    registration: Registration,
    correlationId: string,
  ): Promise<CreateResult> {
    return this.db.inTransaction(agencyId, async (unit): Promise<CreateResult> => {
      if (await unit.findByEmail(agencyId, identity.email)) return { created: false };
      const account = await unit.createMember(agencyId, {
        id: randomUUID(),
        displayName: identity.displayName,
        email: identity.email,
        locale: registration.locale,
      });
      if (!account) return { created: false };
      // A rollback for the rare case that this very identity was linked an instant ago elsewhere.
      if (
        !(await unit.linkIdentity(agencyId, account.id, {
          provider: identity.provider,
          subject: identity.subject,
          email: identity.email,
        }))
      )
        throw new AppError(409, 'IDENTITY_ALREADY_LINKED');
      await unit.recordConsents(agencyId, account.id, consentsFor(registration));
      await unit.appendEvent(this.event('account.registered', agencyId, account.id, correlationId));
      return { created: true, account };
    });
  }

  /**
   * Links a provider identity to an account that already exists. The caller must already have
   * proved the person owns the account (their password). False when this identity, or a Google
   * identity for this account, is already linked.
   */
  async linkIdentity(
    agencyId: string,
    accountId: string,
    identity: ExternalIdentity,
    correlationId: string,
  ): Promise<boolean> {
    return this.db.inTransaction(agencyId, async (unit) => {
      if (!(await unit.linkIdentity(agencyId, accountId, identity))) return false;
      await unit.appendEvent(
        this.event('auth.identity_linked', agencyId, accountId, correlationId),
      );
      return true;
    });
  }

  private event(
    type: 'account.registered' | 'auth.identity_linked',
    agencyId: string,
    accountId: string,
    correlationId: string,
  ) {
    return {
      id: randomUUID(),
      agencyId,
      actorId: accountId,
      subjectId: accountId,
      type,
      version: 1 as const,
      occurredAt: this.now().toISOString(),
      correlationId,
    };
  }

  async createVerified(
    agencyId: string,
    verified: VerifiedRegistration,
    correlationId: string,
  ): Promise<CreateResult> {
    return this.db.inTransaction(agencyId, async (unit): Promise<CreateResult> => {
      // The same link opened twice, or two links for one address: the second finds the account.
      if (await unit.findByEmail(agencyId, verified.email)) return { created: false };

      const account = await unit.createMember(agencyId, {
        id: randomUUID(),
        displayName: verified.registration.displayName,
        email: verified.email,
        locale: verified.registration.locale,
      });
      // Nothing was added: another request created this email between the check and the insert.
      if (!account) return { created: false };

      await unit.createCredential(agencyId, account.id, verified.passwordHash);
      await unit.recordConsents(agencyId, account.id, consentsFor(verified.registration));
      await unit.appendEvent({
        id: randomUUID(),
        agencyId,
        actorId: account.id,
        subjectId: account.id,
        type: 'account.registered',
        version: 1,
        occurredAt: this.now().toISOString(),
        correlationId,
      });
      return { created: true, account };
    });
  }
}
