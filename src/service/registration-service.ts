import { randomUUID } from 'node:crypto';
import type { Account } from '../bo/identity.js';
import { PHONE_E164, consentsFor, type Registration } from '../bo/registration.js';
import type {
  RegistrationDbService,
  RegistrationUnit,
} from '../db/service/registration-db-service.js';
import type { FoundAccount } from '../db/raw/repository/registration-repository.js';
import { AppError } from '../exception/app-error.js';

/** Who the identity provider says is signing in. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  /** Verified by the provider with a one-time code. Undefined when the provider did not say. */
  phone: string | undefined;
}

/**
 * Creating a member's account.
 *
 * - The role is always `member`. Nothing the person sends can change it.
 * - The phone number must have been verified by the identity provider. It is never taken from
 *   the request.
 * - The account, the consent records and an event are written in one transaction.
 * - A person who already has an account for this identity just gets that account. A phone number
 *   that belongs to a different identity is refused rather than linked: linking by phone alone
 *   could hand one person's account to the next owner of a recycled number.
 */
export class RegistrationService {
  constructor(
    private readonly db: Pick<RegistrationDbService, 'find' | 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The account for an identity, whatever its status. Null when there is none. */
  find(agencyId: string, issuer: string, subject: string): Promise<FoundAccount | null> {
    return this.db.find(agencyId, issuer, subject);
  }

  async register(
    agencyId: string,
    identity: VerifiedIdentity,
    registration: Registration,
    correlationId: string,
  ): Promise<Account> {
    const phone = identity.phone;
    if (!phone || !PHONE_E164.test(phone)) throw new AppError(422, 'REGISTRATION_PHONE_REQUIRED');

    return this.db.inTransaction(agencyId, async (unit) => {
      // Two requests at once for one person: the second finds the first one's account.
      const existing = await unit.findBySubject(agencyId, identity.issuer, identity.subject);
      if (existing) return this.usable(existing);

      if (await unit.phoneTaken(agencyId, phone))
        throw new AppError(409, 'PHONE_ALREADY_REGISTERED');

      const account = await unit.createMember(agencyId, {
        displayName: registration.displayName,
        phone,
        issuer: identity.issuer,
        subject: identity.subject,
        locale: registration.locale,
      });
      if (!account) {
        // Nothing was added: another request won between the checks and the insert.
        const winner = await unit.findBySubject(agencyId, identity.issuer, identity.subject);
        if (winner) return this.usable(winner);
        throw new AppError(409, 'PHONE_ALREADY_REGISTERED');
      }

      await unit.recordConsents(agencyId, account.id, consentsFor(registration));
      await this.record(unit, agencyId, account.id, correlationId);
      return account;
    });
  }

  private usable(found: FoundAccount): Account {
    if (found.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
    return found.account;
  }

  private record(
    unit: RegistrationUnit,
    agencyId: string,
    accountId: string,
    correlationId: string,
  ) {
    return unit.appendEvent({
      id: randomUUID(),
      agencyId,
      actorId: accountId,
      subjectId: accountId,
      type: 'account.registered',
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    });
  }
}
