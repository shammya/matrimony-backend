import { randomUUID } from 'node:crypto';
import type { Account } from '../bo/identity.js';
import { consentsFor, type Registration } from '../bo/registration.js';
import type { RegistrationDbService } from '../db/service/registration-db-service.js';

/** What was typed at registration and has since been proven by opening the emailed link. */
export interface VerifiedRegistration {
  email: string;
  passwordHash: string;
  registration: Registration;
}

export type CreateResult = { created: true; account: Account } | { created: false };

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
    private readonly db: Pick<RegistrationDbService, 'findByEmail' | 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async emailRegistered(agencyId: string, email: string): Promise<boolean> {
    return (await this.db.findByEmail(agencyId, email)) !== null;
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
