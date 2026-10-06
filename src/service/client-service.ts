import { randomUUID } from 'node:crypto';
import { isStaff } from '../bo/access.js';
import type {
  ClientInput,
  ClientListQuery,
  ClientMeta,
  ClientPage,
  StaffMember,
} from '../bo/client.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { OwnProfileState } from '../bo/profile-state.js';
import { decodeCursor, encodeCursor } from '../bo/review.js';
import type { ClientDbService, ClientUnit } from '../db/service/client-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor, ProfileService } from './profile-service.js';

/** A client's profile together with who looks after it. */
export interface ClientDetail {
  state: OwnProfileState;
  meta: ClientMeta;
}

type ProfileWork = Pick<
  ProfileService,
  | 'getClient'
  | 'createClient'
  | 'saveClient'
  | 'submitClient'
  | 'requestClientEdit'
  | 'cancelClientPending'
  | 'changeStatus'
>;

/**
 * Staff managing their clients.
 *
 * - An admin sees and works on every profile; an agent only on the profiles assigned to them. A
 *   profile an agent may not manage is reported as not found.
 * - An assisted client (no login) is created and edited by staff, and goes through the same review
 *   as a member's profile. A member who runs their own profile is never edited by staff: staff can
 *   only see it, change its status and see who looks after it.
 * - An agent's new client is assigned to that agent. Only an admin assigns clients, to any active
 *   admin or agent.
 *
 * The content rules (drafts, submitting, change requests, versions) are `ProfileService`'s; this
 * adds the list, the assignment and what a client's page needs besides the profile.
 */
export class ClientService {
  constructor(
    private readonly db: Pick<ClientDbService, 'inTransaction'>,
    private readonly profiles: ProfileWork,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(actor: ProfileActor, query: ClientListQuery): Promise<ClientPage> {
    this.requireStaff(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    // An agent's list is their own clients, whatever they ask for. The agent filter is an admin's.
    const isAdmin = actor.role === 'admin';
    const filter = {
      status: query.status,
      serviceMode: query.serviceMode,
      agentId: isAdmin && query.assignedTo && query.assignedTo !== 'none' ? query.assignedTo : null,
      unassignedOnly: isAdmin && query.assignedTo === 'none',
      search: query.q || undefined,
    };
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const rows = await unit.list(actor.agencyId, filter, isAdmin ? null : actor.accountId, {
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

  async detail(actor: ProfileActor, profileId: string): Promise<ClientDetail> {
    const state = await this.profiles.getClient(actor, profileId);
    return { state, meta: await this.metaOf(actor, profileId) };
  }

  async create(
    actor: ProfileActor,
    input: ClientInput,
    correlationId: string,
  ): Promise<{ id: string; detail: ClientDetail }> {
    this.requireStaff(actor);
    // An agent's client is theirs. An admin may hand it to anyone, or leave it unassigned.
    const requested = actor.role === 'admin' ? (input.assignedAgentId ?? null) : actor.accountId;
    if (requested) await this.requireAssignable(actor, requested);
    const created = await this.profiles.createClient(actor, input, requested, correlationId);
    return {
      id: created.id,
      detail: { state: created.state, meta: await this.metaOf(actor, created.id) },
    };
  }

  async save(actor: ProfileActor, profileId: string, input: ClientInput) {
    return this.after(actor, profileId, await this.profiles.saveClient(actor, profileId, input));
  }

  async submit(actor: ProfileActor, profileId: string, version: number, correlationId: string) {
    return this.after(
      actor,
      profileId,
      await this.profiles.submitClient(actor, profileId, version, correlationId),
    );
  }

  async requestEdit(
    actor: ProfileActor,
    profileId: string,
    input: ClientInput,
    correlationId: string,
  ) {
    return this.after(
      actor,
      profileId,
      await this.profiles.requestClientEdit(actor, profileId, input, correlationId),
    );
  }

  async cancelPending(actor: ProfileActor, profileId: string, correlationId: string) {
    return this.after(
      actor,
      profileId,
      await this.profiles.cancelClientPending(actor, profileId, correlationId),
    );
  }

  async changeStatus(
    actor: ProfileActor,
    profileId: string,
    status: 'active' | 'paused' | 'matched' | 'closed',
    version: number,
    correlationId: string,
  ) {
    return this.after(
      actor,
      profileId,
      await this.profiles.changeStatus(actor, profileId, status, version, correlationId),
    );
  }

  /** Hands a profile to an agent, or to nobody. Admins only. */
  async assign(
    actor: ProfileActor,
    profileId: string,
    agentId: string | null,
    correlationId: string,
  ): Promise<ClientDetail> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      if (agentId) await this.requireAssignableIn(unit, actor, agentId);
      if (!(await unit.assign(actor.agencyId, profileId, agentId))) {
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      }
      await unit.appendEvent(this.event(actor, profileId, correlationId));
    });
    return this.detail(actor, profileId);
  }

  /** The staff an admin may hand clients to. */
  async listStaff(actor: ProfileActor): Promise<StaffMember[]> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, (unit) => unit.staff(actor.agencyId));
  }

  // ------------------------------------------------------------------------------------------

  private async after(actor: ProfileActor, profileId: string, state: OwnProfileState) {
    return { state, meta: await this.metaOf(actor, profileId) } satisfies ClientDetail;
  }

  private async metaOf(actor: ProfileActor, profileId: string): Promise<ClientMeta> {
    const meta = await this.db.inTransaction(actor.agencyId, (unit) =>
      unit.meta(actor.agencyId, profileId),
    );
    if (!meta) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return meta;
  }

  private requireAssignable(actor: ProfileActor, agentId: string) {
    return this.db.inTransaction(actor.agencyId, (unit) =>
      this.requireAssignableIn(unit, actor, agentId),
    );
  }

  /** A client can only be handed to an active admin or agent of this agency. */
  private async requireAssignableIn(unit: ClientUnit, actor: ProfileActor, agentId: string) {
    const member = await unit.staffMember(actor.agencyId, agentId);
    if (!member || member.status !== 'active') throw new AppError(422, 'AGENT_NOT_AVAILABLE');
  }

  private requireStaff(actor: ProfileActor) {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private event(actor: ProfileActor, profileId: string, correlationId: string): WorkflowEvent {
    return {
      id: randomUUID(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      type: 'profile.assigned',
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
      subjectId: profileId,
    };
  }
}
