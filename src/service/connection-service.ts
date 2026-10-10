import { randomUUID } from 'node:crypto';
import { canManage, isStaff } from '../bo/access.js';
import {
  recipientOf,
  type ConnectionListQuery,
  type ConnectionPage,
  type ConnectionRecord,
  type NotificationKind,
  type NotificationPage,
  type NotificationQuery,
  type ProfileLite,
  type SendResult,
  type StaffConnectionRow,
} from '../bo/connection.js';
import type { WorkflowEvent } from '../bo/event.js';
import { DEFAULT_VISIBLE_FIELDS, type VisibleField } from '../bo/release.js';
import { decodeCursor, encodeCursor } from '../bo/review.js';
import type { ConnectionDbService, ConnectionUnit } from '../db/service/connection-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  | 'interest.requested'
  | 'interest.accepted'
  | 'interest.declined'
  | 'interest.withdrawn'
  | 'interest.contact_shared'
>;

/**
 * Connection requests and the inbox (slice 3.F, docs/features/discovery-loop.md).
 *
 * - Only a member with a published profile asks, and only someone in their released window. Anything
 *   else is reported as not found, so a profile outside the window is never confirmed to exist.
 * - There is one connection per pair. Two people asking each other end as one accepted connection
 *   (both are told). Asking again while waiting changes nothing. A declined pair stays declined. A
 *   withdrawn request can be asked again.
 * - The person asked is told in their inbox. A client managed by an agent has no login, so the agent
 *   is told, and answers for them from the client's page.
 * - Contact details stay private. After acceptance each side may share theirs with the other, and
 *   only that side can say so.
 * - Both profiles are locked in a fixed order while a request is made or answered, so two people
 *   asking each other at the same moment cannot create two connections or deadlock.
 * - Every change is an event in the same transaction.
 */
export class ConnectionService {
  constructor(
    private readonly db: Pick<ConnectionDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A member asks to connect with someone in their window. */
  async send(actor: ProfileActor, candidateId: string, correlationId: string): Promise<SendResult> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      if (candidateId === own.id) throw new AppError(404, 'PROFILE_NOT_FOUND');
      const locked = await unit.lockProfiles(actor.agencyId, [own.id, candidateId]);
      const me = locked.find((p) => p.id === own.id);
      const them = locked.find((p) => p.id === candidateId);
      if (!me || !them || !(await unit.released(actor.agencyId, me.id, them.id))) {
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      }

      const existing = await unit.pair(actor.agencyId, me.id, them.id);
      if (!existing) {
        const id = await unit.insert(actor.agencyId, me.id, them.id, actor.accountId);
        await this.tell(unit, actor.agencyId, 'connection_request', id, them, me);
        await unit.appendEvent(this.event('interest.requested', actor, id, correlationId));
        return { outcome: 'requested', connectionId: id, status: 'pending' };
      }
      if (existing.status === 'declined') throw new AppError(409, 'CONNECTION_DECLINED');
      if (existing.status === 'accepted') {
        return { outcome: 'unchanged', connectionId: existing.id, status: 'accepted' };
      }
      if (existing.status === 'withdrawn') {
        await unit.repend(actor.agencyId, existing.id, me.id, them.id, actor.accountId);
        await this.tell(unit, actor.agencyId, 'connection_request', existing.id, them, me);
        await unit.appendEvent(this.event('interest.requested', actor, existing.id, correlationId));
        return { outcome: 'requested', connectionId: existing.id, status: 'pending' };
      }
      // Pending. Their request to me and mine to them meet: that is an accepted connection.
      if (existing.fromProfileId === me.id) {
        return { outcome: 'unchanged', connectionId: existing.id, status: 'pending' };
      }
      await unit.respond(actor.agencyId, existing.id, 'accepted', actor.accountId);
      await this.tell(unit, actor.agencyId, 'connection_accepted', existing.id, them, me);
      await this.tell(unit, actor.agencyId, 'connection_accepted', existing.id, me, them);
      await unit.appendEvent(this.event('interest.accepted', actor, existing.id, correlationId));
      return { outcome: 'accepted', connectionId: existing.id, status: 'accepted' };
    });
  }

  /** A member answers a request made to them. */
  async respond(
    actor: ProfileActor,
    connectionId: string,
    accept: boolean,
    correlationId: string,
  ): Promise<void> {
    this.requireMember(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      await this.decide(unit, actor, own.id, connectionId, accept, correlationId);
    });
  }

  /** A member takes back a request that has not been answered. */
  async withdraw(actor: ProfileActor, connectionId: string, correlationId: string): Promise<void> {
    this.requireMember(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      const { connection } = await this.lockedParty(unit, actor.agencyId, own.id, connectionId);
      if (connection.fromProfileId !== own.id) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      if (!(await unit.withdraw(actor.agencyId, connection.id, own.id))) {
        throw new AppError(409, 'CONNECTION_NOT_PENDING');
      }
      await unit.appendEvent(this.event('interest.withdrawn', actor, connection.id, correlationId));
    });
  }

  /** A member shares their own contact details with the other side of an accepted connection. */
  async shareContact(
    actor: ProfileActor,
    connectionId: string,
    correlationId: string,
  ): Promise<void> {
    this.requireMember(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      await this.share(unit, actor, own.id, connectionId, correlationId);
    });
  }

  /** A member's connections in one box: waiting for them, waiting for the other person, or accepted. */
  async list(actor: ProfileActor, query: ConnectionListQuery): Promise<ConnectionPage> {
    this.requireMember(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own || own.status !== 'active') return { items: [], next: null };
      const visible = await this.visibleFields(unit, actor.agencyId, own.id);
      const rows = await unit.connections(
        actor.agencyId,
        own.id,
        query.box,
        visible,
        { limit: query.limit, after },
        this.now(),
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.connectionId })
            : null,
      };
    });
  }

  /** An account's inbox: what happened to them or to the clients they look after, newest first. */
  async notifications(actor: ProfileActor, query: NotificationQuery): Promise<NotificationPage> {
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      // Staff see names. A member sees a name only if staff let them see names at all.
      let showNames = isStaff(actor.role);
      if (actor.role === 'member') {
        const own = await unit.ownProfile(actor.agencyId, actor.accountId);
        showNames = own
          ? (await this.visibleFields(unit, actor.agencyId, own.id)).includes('fullName')
          : false;
      }
      const rows = await unit.notifications(actor.agencyId, actor.accountId, showNames, {
        limit: query.limit,
        after,
      });
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
      };
    });
  }

  // ---- staff, for the clients they look after -----------------------------------------------

  /** Every connection of a client, for the staff who look after them. */
  async staffList(actor: ProfileActor, clientId: string): Promise<StaffConnectionRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.managed(unit, actor, clientId, false);
      return unit.staffList(actor.agencyId, clientId, this.now());
    });
  }

  /** Staff answer a request for a client who has no login. */
  async staffRespond(
    actor: ProfileActor,
    clientId: string,
    connectionId: string,
    accept: boolean,
    correlationId: string,
  ): Promise<void> {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.managed(unit, actor, clientId, true);
      await this.decide(unit, actor, clientId, connectionId, accept, correlationId);
    });
  }

  /** Staff share an assisted client's contact details with the other side, once the client agrees. */
  async staffShareContact(
    actor: ProfileActor,
    clientId: string,
    connectionId: string,
    correlationId: string,
  ): Promise<void> {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.managed(unit, actor, clientId, true);
      await this.share(unit, actor, clientId, connectionId, correlationId);
    });
  }

  // ------------------------------------------------------------------------------------------

  /** Answers a request made to `toProfileId`, for them (a member) or on their behalf (staff). */
  private async decide(
    unit: ConnectionUnit,
    actor: ProfileActor,
    toProfileId: string,
    connectionId: string,
    accept: boolean,
    correlationId: string,
  ) {
    const { connection, profiles } = await this.lockedParty(
      unit,
      actor.agencyId,
      toProfileId,
      connectionId,
    );
    // Only the person asked answers.
    if (connection.toProfileId !== toProfileId) throw new AppError(404, 'CONNECTION_NOT_FOUND');
    if (
      !(await unit.respond(
        actor.agencyId,
        connection.id,
        accept ? 'accepted' : 'declined',
        actor.accountId,
      ))
    ) {
      throw new AppError(409, 'CONNECTION_NOT_PENDING');
    }
    const asker = profiles.find((p) => p.id === connection.fromProfileId);
    const asked = profiles.find((p) => p.id === toProfileId);
    if (asker && asked) {
      await this.tell(
        unit,
        actor.agencyId,
        accept ? 'connection_accepted' : 'connection_declined',
        connection.id,
        asker,
        asked,
      );
      // An accepted pair is told on both sides.
      if (accept) {
        await this.tell(unit, actor.agencyId, 'connection_accepted', connection.id, asked, asker);
      }
    }
    await unit.appendEvent(
      this.event(
        accept ? 'interest.accepted' : 'interest.declined',
        actor,
        connection.id,
        correlationId,
      ),
    );
  }

  private async share(
    unit: ConnectionUnit,
    actor: ProfileActor,
    profileId: string,
    connectionId: string,
    correlationId: string,
  ) {
    const { connection } = await this.lockedParty(unit, actor.agencyId, profileId, connectionId);
    const side = connection.fromProfileId === profileId ? 'from' : 'to';
    if (!(await unit.share(actor.agencyId, connection.id, profileId, side))) {
      throw new AppError(409, 'CONNECTION_NOT_ACCEPTED');
    }
    await unit.appendEvent(
      this.event('interest.contact_shared', actor, connection.id, correlationId),
    );
  }

  /**
   * The connection if this profile is one of its two sides (otherwise not found), with both profiles
   * locked in a fixed order and the connection read again under those locks. Every change to a
   * connection is made under both locks, so two changes to one pair never interleave or deadlock.
   */
  private async lockedParty(
    unit: ConnectionUnit,
    agencyId: string,
    profileId: string,
    connectionId: string,
  ) {
    const first: ConnectionRecord | null = await unit.byId(agencyId, connectionId);
    if (!first || (first.fromProfileId !== profileId && first.toProfileId !== profileId)) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND');
    }
    const profiles = await unit.lockProfiles(agencyId, [first.fromProfileId, first.toProfileId]);
    const connection = await unit.byId(agencyId, connectionId);
    if (!connection) throw new AppError(404, 'CONNECTION_NOT_FOUND');
    return { connection, profiles };
  }

  /** Tells whoever looks after `recipient` that something happened with `about`. */
  private async tell(
    unit: ConnectionUnit,
    agencyId: string,
    kind: NotificationKind,
    connectionId: string,
    recipient: ProfileLite,
    about: ProfileLite,
  ) {
    const account = recipientOf(recipient);
    // The key only has to be unique for the recipient; everything here happens in one transaction.
    if (account) {
      await unit.notify(
        agencyId,
        account,
        kind,
        connectionId,
        recipient.id,
        about.id,
        `${kind}:${connectionId}:${randomUUID()}`,
      );
    }
  }

  /** The member's own profile, which must be published to take part. */
  private async publishedOwn(unit: ConnectionUnit, actor: ProfileActor) {
    const own = await unit.ownProfile(actor.agencyId, actor.accountId);
    if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
    if (own.status !== 'active') throw new AppError(409, 'PROFILE_NOT_PUBLISHED');
    return own;
  }

  /** A client this staff member may manage, and, when asked, one who has no login of their own. */
  private async managed(
    unit: ConnectionUnit,
    actor: ProfileActor,
    clientId: string,
    assistedOnly: boolean,
  ) {
    const [client] = await unit.readProfiles(actor.agencyId, [clientId]);
    if (!client || !canManage(actor, client)) throw new AppError(404, 'PROFILE_NOT_FOUND');
    // A member who runs their own profile answers for themselves.
    if (assistedOnly && client.serviceMode !== 'assisted')
      throw new AppError(403, 'PROFILE_SELF_SERVICE');
    return client;
  }

  private async visibleFields(
    unit: ConnectionUnit,
    agencyId: string,
    clientId: string,
  ): Promise<readonly VisibleField[]> {
    return (await unit.settings(agencyId, clientId))?.visibleFields ?? DEFAULT_VISIBLE_FIELDS;
  }

  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private requireStaff(actor: ProfileActor) {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
      subjectId,
    };
  }
}

// `canManage` reads these two fields only; a ProfileLite carries them.
export type { ProfileLite };
