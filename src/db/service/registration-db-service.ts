import type { WorkflowEvent } from '../../bo/event.js';
import type { Account } from '../../bo/identity.js';
import type { ConsentRecord } from '../../bo/registration.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type {
  FoundAccount,
  RegistrationRepository,
  SignInMethods,
} from '../raw/repository/registration-repository.js';

/**
 * Everything the registration workflow may do, bound to one open transaction. The account, its
 * password, the consent records and the event are written together or not at all.
 */
export interface RegistrationUnit {
  findByEmail(agencyId: string, email: string): Promise<FoundAccount | null>;
  createMember(
    agencyId: string,
    member: { id: string; displayName: string; email: string; locale: string },
  ): Promise<Account | null>;
  findByPhone(agencyId: string, phone: string): Promise<FoundAccount | null>;
  createPhoneMember(
    agencyId: string,
    member: { id: string; displayName: string; phone: string; locale: string },
  ): Promise<Account | null>;
  phoneTakenByOther(agencyId: string, phone: string, accountId: string): Promise<boolean>;
  setPhone(agencyId: string, accountId: string, phone: string): Promise<boolean>;
  createCredential(agencyId: string, accountId: string, hash: string): Promise<void>;
  linkIdentity(
    agencyId: string,
    accountId: string,
    identity: { provider: string; subject: string; email: string },
  ): Promise<boolean>;
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

  /** The account for this email, whatever its status. Null when there is none. */
  findByEmail(agencyId: string, email: string): Promise<FoundAccount | null> {
    return this.db.transaction(agencyId, (tx) => this.repository.findByEmail(tx, agencyId, email));
  }

  /** The account linked to this provider identity, whatever its status. Null when none is. */
  findByIdentity(
    agencyId: string,
    provider: string,
    subject: string,
  ): Promise<FoundAccount | null> {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.findByIdentity(tx, agencyId, provider, subject),
    );
  }

  /** The account whose proven phone number this is, whatever its status. Null when none is. */
  findByPhone(agencyId: string, phone: string): Promise<FoundAccount | null> {
    return this.db.transaction(agencyId, (tx) => this.repository.findByPhone(tx, agencyId, phone));
  }

  signInMethods(agencyId: string, accountId: string): Promise<SignInMethods | null> {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.signInMethods(tx, agencyId, accountId),
    );
  }

  inTransaction<T>(agencyId: string, work: (unit: RegistrationUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): RegistrationUnit {
    const repo = this.repository;
    return {
      findByEmail: (agencyId, email) => repo.findByEmail(tx, agencyId, email),
      createMember: (agencyId, member) => repo.createMember(tx, agencyId, member),
      findByPhone: (agencyId, phone) => repo.findByPhone(tx, agencyId, phone),
      createPhoneMember: (agencyId, member) => repo.createPhoneMember(tx, agencyId, member),
      phoneTakenByOther: (agencyId, phone, accountId) =>
        repo.phoneTakenByOther(tx, agencyId, phone, accountId),
      setPhone: (agencyId, accountId, phone) => repo.setPhone(tx, agencyId, accountId, phone),
      createCredential: (agencyId, accountId, hash) =>
        repo.createCredential(tx, agencyId, accountId, hash),
      linkIdentity: (agencyId, accountId, identity) =>
        repo.linkIdentity(tx, agencyId, accountId, identity),
      recordConsents: (agencyId, accountId, consents) =>
        repo.recordConsents(tx, agencyId, accountId, consents),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
