import type { WorkflowEvent } from '../../bo/event.js';
import type { ClientListItem, ClientMeta, StaffMember } from '../../bo/client.js';
import type { Cursor } from '../../bo/review.js';
import type { Database, Transaction } from '../config/database.js';
import type { ClientFilter, ClientRepository } from '../raw/repository/client-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/** What staff client management may do, bound to one open transaction. */
export interface ClientUnit {
  list(
    agencyId: string,
    filter: ClientFilter,
    viewer: string | null,
    page: { limit: number; after: Cursor | null },
  ): Promise<ClientListItem[]>;
  meta(agencyId: string, profileId: string): Promise<ClientMeta | null>;
  staff(agencyId: string): Promise<StaffMember[]>;
  staffMember(agencyId: string, accountId: string): Promise<StaffMember | null>;
  assign(agencyId: string, profileId: string, agentId: string | null): Promise<boolean>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class ClientDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: ClientRepository,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: ClientUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ClientUnit {
    const repo = this.repository;
    return {
      list: (agencyId, filter, viewer, page) => repo.list(tx, agencyId, filter, viewer, page),
      meta: (agencyId, profileId) => repo.meta(tx, agencyId, profileId),
      staff: (agencyId) => repo.staff(tx, agencyId),
      staffMember: (agencyId, accountId) => repo.staffMember(tx, agencyId, accountId),
      assign: (agencyId, profileId, agentId) => repo.assign(tx, agencyId, profileId, agentId),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
