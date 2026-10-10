import type {
  ConnectionRecord,
  ConnectionStatus,
  NotificationItem,
  NotificationKind,
  ProfileLite,
  StaffConnectionRow,
} from '../../../bo/connection.js';
import { ageOn } from '../../../bo/profile.js';
import type { Cursor } from '../../../bo/review.js';
import type { Transaction } from '../../config/database.js';
import { connectionQueries } from '../query/connection.js';

type Row = Record<string, unknown>;

// The inbox line of each kind of notification: the template the frontend turns into a sentence.
const TEMPLATE_OF: Record<NotificationKind, string> = {
  connection_request: 'interest.received',
  connection_accepted: 'interest.accepted',
  connection_declined: 'interest.declined',
};
const KIND_OF = Object.fromEntries(
  Object.entries(TEMPLATE_OF).map(([kind, template]) => [template, kind]),
) as Record<string, NotificationKind>;

const record = (row: Row): ConnectionRecord => ({
  id: row.id as string,
  fromProfileId: row.from_profile_id as string,
  toProfileId: row.to_profile_id as string,
  status: row.status as ConnectionStatus,
  fromShared: row.from_shared_contact === true,
  toShared: row.to_shared_contact === true,
});

/** Every connection write and the inbox. Each method runs inside the transaction it is given. */
export class ConnectionRepository {
  /** The profiles, locked, in a fixed order. */
  async lockProfiles(
    tx: Transaction,
    agencyId: string,
    ids: readonly string[],
  ): Promise<ProfileLite[]> {
    const result = await tx.query(connectionQueries.lockProfiles, [agencyId, [...ids]]);
    return result.rows.map((row) => ({
      id: row.id as string,
      status: row.status as string,
      serviceMode: row.service_mode as ProfileLite['serviceMode'],
      ownerId: row.owner_account_id as string | null,
      assignedAgentId: row.assigned_agent_id as string | null,
    }));
  }

  /** The profiles, not locked. */
  async readProfiles(
    tx: Transaction,
    agencyId: string,
    ids: readonly string[],
  ): Promise<ProfileLite[]> {
    const result = await tx.query(connectionQueries.readProfiles, [agencyId, [...ids]]);
    return result.rows.map((row) => ({
      id: row.id as string,
      status: row.status as string,
      serviceMode: row.service_mode as ProfileLite['serviceMode'],
      ownerId: row.owner_account_id as string | null,
      assignedAgentId: row.assigned_agent_id as string | null,
    }));
  }

  async released(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    candidateId: string,
  ): Promise<boolean> {
    const result = await tx.query(connectionQueries.released, [agencyId, clientId, candidateId]);
    return result.rows.length > 0;
  }

  async pair(
    tx: Transaction,
    agencyId: string,
    a: string,
    b: string,
  ): Promise<ConnectionRecord | null> {
    const result = await tx.query(connectionQueries.pair, [agencyId, a, b]);
    return result.rows[0] ? record(result.rows[0] as Row) : null;
  }

  /** The connection. Its two profiles are locked by the caller first, which is what serialises changes to it. */
  async byId(tx: Transaction, agencyId: string, id: string): Promise<ConnectionRecord | null> {
    const result = await tx.query(connectionQueries.byId, [agencyId, id]);
    return result.rows[0] ? record(result.rows[0] as Row) : null;
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    fromId: string,
    toId: string,
    accountId: string,
  ): Promise<string> {
    const result = await tx.query(connectionQueries.insert, [agencyId, fromId, toId, accountId]);
    return (result.rows[0] as { id: string }).id;
  }

  async repend(
    tx: Transaction,
    agencyId: string,
    id: string,
    fromId: string,
    toId: string,
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(connectionQueries.repend, [
      agencyId,
      id,
      fromId,
      toId,
      accountId,
    ]);
    return result.rows.length > 0;
  }

  async respond(
    tx: Transaction,
    agencyId: string,
    id: string,
    status: 'accepted' | 'declined',
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(connectionQueries.respond, [agencyId, id, status, accountId]);
    return result.rows.length > 0;
  }

  async withdraw(tx: Transaction, agencyId: string, id: string, fromId: string): Promise<boolean> {
    const result = await tx.query(connectionQueries.withdraw, [agencyId, id, fromId]);
    return result.rows.length > 0;
  }

  /** Marks the given side of an accepted connection as having shared its contact details. */
  async share(
    tx: Transaction,
    agencyId: string,
    id: string,
    profileId: string,
    side: 'from' | 'to',
  ): Promise<boolean> {
    const sql = side === 'from' ? connectionQueries.shareFrom : connectionQueries.shareTo;
    const result = await tx.query(sql, [agencyId, id, profileId]);
    return result.rows.length > 0;
  }

  async notify(
    tx: Transaction,
    agencyId: string,
    recipientId: string,
    kind: NotificationKind,
    connectionId: string,
    forProfileId: string,
    aboutProfileId: string,
    eventKey: string,
  ): Promise<void> {
    await tx.query(connectionQueries.notify, [
      agencyId,
      recipientId,
      eventKey,
      TEMPLATE_OF[kind],
      JSON.stringify({ interestId: connectionId, forProfileId, aboutProfileId }),
    ]);
  }

  /** One page of an account's inbox, newest first. Asks for one more than `limit`. */
  async notifications(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    showNames: boolean,
    page: { limit: number; after: Cursor | null },
  ): Promise<NotificationItem[]> {
    const result = await tx.query(connectionQueries.notifications, [
      agencyId,
      accountId,
      page.after?.createdAt ?? null,
      page.after?.id ?? null,
      page.limit + 1,
      showNames,
    ]);
    return result.rows.map((row) => ({
      id: row.id as string,
      kind: KIND_OF[row.template_key as string]!,
      createdAt: (row.created_at as Date).toISOString(),
      position: row.position as string,
      connectionId: (row.payload as { interestId: string }).interestId,
      forProfileId: (row.payload as { forProfileId: string }).forProfileId,
      about: {
        profileId: row.about_profile_id as string,
        memberCode: row.member_code as string,
        fullName: (row.full_name as string | null) ?? null,
      },
    }));
  }

  /** A client's connections as staff see them. */
  async staffList(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    today: Date,
  ): Promise<StaffConnectionRow[]> {
    const result = await tx.query(connectionQueries.staffList, [agencyId, clientId]);
    return result.rows.map((row) => {
      const sent = row.sent === true;
      const born = row.date_of_birth as string | null;
      return {
        connectionId: row.connection_id as string,
        status: row.status as ConnectionStatus,
        direction: sent ? 'sent' : 'received',
        createdAt: (row.created_at as Date).toISOString(),
        respondedAt: row.responded_at ? (row.responded_at as Date).toISOString() : null,
        clientShared: (sent ? row.from_shared_contact : row.to_shared_contact) === true,
        otherShared: (sent ? row.to_shared_contact : row.from_shared_contact) === true,
        other: {
          profileId: row.id as string,
          memberCode: row.member_code as string,
          fullName: row.full_name as string,
          age: born ? ageOn(born, today) : null,
          professionCode: row.profession_code as string | null,
          currentDistrictCode: row.current_district_code as string | null,
          serviceMode: row.service_mode as StaffConnectionRow['other']['serviceMode'],
        },
      };
    });
  }
}
