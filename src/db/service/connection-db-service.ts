import type {
  ConnectionBox,
  ConnectionRecord,
  ConnectionRow,
  NotificationItem,
  NotificationKind,
  ProfileLite,
  StaffConnectionRow,
} from '../../bo/connection.js';
import type { WorkflowEvent } from '../../bo/event.js';
import type { VisibleField } from '../../bo/release.js';
import type { Cursor } from '../../bo/review.js';
import type { Database, Transaction } from '../config/database.js';
import type { CandidateRepository } from '../raw/repository/candidate-repository.js';
import type { ConnectionRepository } from '../raw/repository/connection-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { MatchRepository } from '../raw/repository/match-repository.js';

/** What connection requests and the inbox may do, bound to one open transaction. */
export interface ConnectionUnit {
  ownProfile(agencyId: string, accountId: string): Promise<{ id: string; status: string } | null>;
  settings(
    agencyId: string,
    clientId: string,
  ): Promise<{ cap: number; visibleFields: VisibleField[] } | null>;
  lockProfiles(agencyId: string, ids: readonly string[]): Promise<ProfileLite[]>;
  readProfiles(agencyId: string, ids: readonly string[]): Promise<ProfileLite[]>;
  released(agencyId: string, clientId: string, candidateId: string): Promise<boolean>;
  pair(agencyId: string, a: string, b: string): Promise<ConnectionRecord | null>;
  byId(agencyId: string, id: string): Promise<ConnectionRecord | null>;
  insert(agencyId: string, fromId: string, toId: string, accountId: string): Promise<string>;
  repend(
    agencyId: string,
    id: string,
    fromId: string,
    toId: string,
    accountId: string,
  ): Promise<boolean>;
  respond(
    agencyId: string,
    id: string,
    status: 'accepted' | 'declined',
    accountId: string,
  ): Promise<boolean>;
  withdraw(agencyId: string, id: string, fromId: string): Promise<boolean>;
  share(agencyId: string, id: string, profileId: string, side: 'from' | 'to'): Promise<boolean>;
  notify(
    agencyId: string,
    recipientId: string,
    kind: NotificationKind,
    connectionId: string,
    forProfileId: string,
    aboutProfileId: string,
    eventKey: string,
  ): Promise<void>;
  notifications(
    agencyId: string,
    accountId: string,
    showNames: boolean,
    page: { limit: number; after: Cursor | null },
  ): Promise<NotificationItem[]>;
  connections(
    agencyId: string,
    clientId: string,
    box: ConnectionBox,
    visible: readonly VisibleField[],
    page: { limit: number; after: Cursor | null },
    today: Date,
  ): Promise<ConnectionRow[]>;
  staffList(agencyId: string, clientId: string, today: Date): Promise<StaffConnectionRow[]>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class ConnectionDbService {
  constructor(
    private readonly db: Database,
    private readonly connections: ConnectionRepository,
    private readonly matches: MatchRepository,
    private readonly candidates: CandidateRepository,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: ConnectionUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ConnectionUnit {
    const c = this.connections;
    return {
      ownProfile: (agencyId, accountId) => this.matches.ownProfile(tx, agencyId, accountId),
      settings: (agencyId, clientId) => this.candidates.settings(tx, agencyId, clientId),
      lockProfiles: (agencyId, ids) => c.lockProfiles(tx, agencyId, ids),
      readProfiles: (agencyId, ids) => c.readProfiles(tx, agencyId, ids),
      released: (agencyId, clientId, candidateId) =>
        c.released(tx, agencyId, clientId, candidateId),
      pair: (agencyId, a, b) => c.pair(tx, agencyId, a, b),
      byId: (agencyId, id) => c.byId(tx, agencyId, id),
      insert: (agencyId, fromId, toId, accountId) =>
        c.insert(tx, agencyId, fromId, toId, accountId),
      repend: (agencyId, id, fromId, toId, accountId) =>
        c.repend(tx, agencyId, id, fromId, toId, accountId),
      respond: (agencyId, id, status, accountId) => c.respond(tx, agencyId, id, status, accountId),
      withdraw: (agencyId, id, fromId) => c.withdraw(tx, agencyId, id, fromId),
      share: (agencyId, id, profileId, side) => c.share(tx, agencyId, id, profileId, side),
      notify: (agencyId, recipientId, kind, connectionId, forProfileId, aboutProfileId, eventKey) =>
        c.notify(
          tx,
          agencyId,
          recipientId,
          kind,
          connectionId,
          forProfileId,
          aboutProfileId,
          eventKey,
        ),
      notifications: (agencyId, accountId, showNames, page) =>
        c.notifications(tx, agencyId, accountId, showNames, page),
      connections: (agencyId, clientId, box, visible, page, today) =>
        this.matches.connections(tx, agencyId, clientId, box, visible, page, today),
      staffList: (agencyId, clientId, today) => c.staffList(tx, agencyId, clientId, today),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
