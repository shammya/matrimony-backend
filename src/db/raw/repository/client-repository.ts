import type { Cursor } from '../../../bo/review.js';
import type { ClientListItem, ClientMeta, StaffMember } from '../../../bo/client.js';
import type { Transaction } from '../../config/database.js';
import { mapClientItem, mapClientMeta, mapStaff } from '../mapper/client.js';
import { clientListQuery, clientQueries } from '../query/client.js';

/** What narrows the list. Every part is optional. */
export interface ClientFilter {
  status: string | undefined;
  serviceMode: string | undefined;
  /** An admin's filter: this agent's clients. */
  agentId: string | null;
  /** An admin's filter: clients nobody looks after. */
  unassignedOnly: boolean;
  search: string | undefined;
}

/** Turns what was typed into a LIKE pattern that matches it anywhere, with its own wildcards disarmed. */
export const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** All client-management reads and writes. Every method runs inside the transaction it is given. */
export class ClientRepository {
  /**
   * One page of clients. `viewer` is the agent whose view this is (they see only their own), or
   * null for an admin. Asks for one more than `limit`, so the caller can tell if there is a next page.
   */
  async list(
    tx: Transaction,
    agencyId: string,
    filter: ClientFilter,
    viewer: string | null,
    page: { limit: number; after: Cursor | null },
  ): Promise<ClientListItem[]> {
    const result = await tx.query(clientListQuery, [
      agencyId,
      viewer,
      filter.status ?? null,
      filter.serviceMode ?? null,
      filter.agentId,
      filter.unassignedOnly,
      filter.search ? likePattern(filter.search) : null,
      page.after?.createdAt ?? null,
      page.after?.id ?? null,
      page.limit + 1,
    ]);
    return result.rows.map(mapClientItem);
  }

  async meta(tx: Transaction, agencyId: string, profileId: string): Promise<ClientMeta | null> {
    const result = await tx.query(clientQueries.meta, [agencyId, profileId]);
    return result.rows[0] ? mapClientMeta(result.rows[0]) : null;
  }

  async staff(tx: Transaction, agencyId: string): Promise<StaffMember[]> {
    const result = await tx.query(clientQueries.staff, [agencyId]);
    return result.rows.map(mapStaff);
  }

  async staffMember(
    tx: Transaction,
    agencyId: string,
    accountId: string,
  ): Promise<StaffMember | null> {
    const result = await tx.query(clientQueries.staffMember, [agencyId, accountId]);
    return result.rows[0] ? mapStaff(result.rows[0]) : null;
  }

  /** False when there is no such profile. */
  async assign(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    agentId: string | null,
  ): Promise<boolean> {
    const result = await tx.query(clientQueries.assign, [agencyId, profileId, agentId]);
    return result.rows.length > 0;
  }
}
