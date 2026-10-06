import type { WorkflowEvent } from '../../bo/event.js';
import type { Account } from '../../bo/identity.js';
import type { ConsentRecord } from '../../bo/registration.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type {
  FoundAccount,
  RegistrationRepository,
} from '../raw/repository/registration-repository.js';

/**
 * Everything the registration workflow may do, bound to one open transaction. The account, the
 * consent records and the event are written together or not at all.
 */
export interface RegistrationUnit {
  findBySubject(agencyId: string, issuer: string, subject: string): Promise<FoundAccount | null>;
  phoneTaken(agencyId: string, phone: string): Promise<boolean>;
  createMember(
    agencyId: string,
    member: { displayName: string; phone: string; issuer: string; subject: string; locale: string },
  ): Promise<Account | null>;
  recordConsents(
    agencyId: string,
    accountId: string,
    consents: readonly ConsentRecord[],
  ): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class RegistrationDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: RegistrationRepository,
    private readonly events: EventRepository,
  ) {}

  /** The account for this identity, whatever its status. Null when there is none. */
  find(agencyId: string, issuer: string, subject: string): Promise<FoundAccount | null> {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.findBySubject(tx, agencyId, issuer, subject),
    );
  }

  inTransaction<T>(agencyId: string, work: (unit: RegistrationUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): RegistrationUnit {
    const repo = this.repository;
    return {
      findBySubject: (agencyId, issuer, subject) =>
        repo.findBySubject(tx, agencyId, issuer, subject),
      phoneTaken: (agencyId, phone) => repo.phoneTaken(tx, agencyId, phone),
      createMember: (agencyId, member) => repo.createMember(tx, agencyId, member),
      recordConsents: (agencyId, accountId, consents) =>
        repo.recordConsents(tx, agencyId, accountId, consents),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
