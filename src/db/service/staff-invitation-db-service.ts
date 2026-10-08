import type { WorkflowEvent } from '../../bo/event.js';
import type { Account } from '../../bo/identity.js';
import type { StaffInvitation } from '../../bo/staff.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type {
  FoundAccount,
  RegistrationRepository,
} from '../raw/repository/registration-repository.js';
import type {
  InvitationForLink,
  StaffInvitationRepository,
} from '../raw/repository/staff-invitation-repository.js';

/** What inviting and accepting may do, bound to one open transaction. */
export interface StaffInvitationUnit {
  upsertOpen(
    agencyId: string,
    invitation: {
      email: string;
      displayName: string;
      role: string;
      locale: string;
      invitedBy: string;
      tokenHash: string;
      days: number;
    },
  ): Promise<string>;
  open(agencyId: string): Promise<StaffInvitation[]>;
  openById(agencyId: string, invitationId: string): Promise<StaffInvitation | null>;
  byLink(agencyId: string, tokenHash: string, lock: boolean): Promise<InvitationForLink | null>;
  createStaff(
    agencyId: string,
    staff: { id: string; displayName: string; email: string; role: string; locale: string },
  ): Promise<Account | null>;
  markAccepted(agencyId: string, invitationId: string, accountId: string): Promise<boolean>;
  revoke(agencyId: string, invitationId: string): Promise<boolean>;
  findAccountByEmail(agencyId: string, email: string): Promise<FoundAccount | null>;
  createCredential(agencyId: string, accountId: string, hash: string): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class StaffInvitationDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: StaffInvitationRepository,
    private readonly registrations: Pick<
      RegistrationRepository,
      'findByEmail' | 'createCredential'
    >,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: StaffInvitationUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): StaffInvitationUnit {
    const repo = this.repository;
    return {
      upsertOpen: (agencyId, invitation) => repo.upsertOpen(tx, agencyId, invitation),
      open: (agencyId) => repo.open(tx, agencyId),
      openById: (agencyId, invitationId) => repo.openById(tx, agencyId, invitationId),
      byLink: (agencyId, tokenHash, lock) => repo.byLink(tx, agencyId, tokenHash, lock),
      createStaff: (agencyId, staff) => repo.createStaff(tx, agencyId, staff),
      markAccepted: (agencyId, invitationId, accountId) =>
        repo.markAccepted(tx, agencyId, invitationId, accountId),
      revoke: (agencyId, invitationId) => repo.revoke(tx, agencyId, invitationId),
      findAccountByEmail: (agencyId, email) => this.registrations.findByEmail(tx, agencyId, email),
      createCredential: (agencyId, accountId, hash) =>
        this.registrations.createCredential(tx, agencyId, accountId, hash),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
