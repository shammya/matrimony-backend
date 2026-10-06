import { randomUUID } from 'node:crypto';
import { canManage, isStaff, STATUS_MOVES } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import {
  diffProfileData,
  isEmptyChange,
  missingRequired,
  newMemberCode,
  type ProfileData,
  type ProfileInput,
} from '../bo/profile.js';
import type { OwnProfileState, ProfileRecord } from '../bo/profile-state.js';
import type { ProfileDbService, ProfileUnit } from '../db/service/profile-db-service.js';
import { AppError } from '../exception/app-error.js';

/** The signed-in account asking. The agency and the account always come from the verified session. */
export interface ProfileActor {
  agencyId: string;
  accountId: string;
  role: 'admin' | 'agent' | 'member';
}

type EventType = Extract<
  WorkflowEvent['type'],
  | 'profile.submitted'
  | 'profile.edit_requested'
  | 'profile.review_cancelled'
  | 'profile.status_changed'
  | 'client.created'
>;

const MEMBER_CODE_ATTEMPTS = 5;

const dataOf = (input: ProfileInput): ProfileData => ({
  profile: input.profile,
  contact: input.contact,
  preferences: input.preferences,
});

/**
 * A profile and its review workflow, for a member's own profile and for an assisted client's.
 *
 * - A draft (or a rejected profile) is edited in place and saved as often as needed.
 * - Submitting locks it as "pending review". It can be withdrawn to edit again.
 * - Once published, a change is never applied directly: it becomes a review request carrying only
 *   the fields that differ, and the published version stays visible until it is approved.
 *
 * The rules are the same for both. What differs is who may act: a member on their own profile, or
 * staff on a client's (an admin on any, an agent on those assigned to them). Staff may change the
 * content only of an assisted client, never of a member who runs their own profile.
 *
 * Every rule that looks at the current state runs inside the transaction that holds the profile's
 * row lock, so two requests at once cannot both pass the same check.
 */
export class ProfileService {
  constructor(
    private readonly db: Pick<ProfileDbService, 'inTransaction' | 'read'>,
    private readonly now: () => Date = () => new Date(),
    private readonly memberCode: () => string = newMemberCode,
  ) {}

  // ------------------------------------------------------------------------------------------
  // A member's own profile
  // ------------------------------------------------------------------------------------------

  async get(actor: ProfileActor): Promise<OwnProfileState> {
    this.requireMember(actor);
    return this.db.read(actor.agencyId, actor.accountId);
  }

  /** Saves the draft, creating the profile on the first save. */
  async save(actor: ProfileActor, input: ProfileInput): Promise<OwnProfileState> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await unit.findByOwner(actor.agencyId, actor.accountId, true);
      if (!current) {
        // A first save has no version. One that claims a version refers to a profile that is gone.
        if (input.version != null) throw new AppError(409, 'PROFILE_VERSION_CONFLICT');
        await this.createDraft(unit, actor, dataOf(input));
        return this.stateOwnedBy(unit, actor);
      }
      await this.applySave(unit, actor, current, input);
      return this.stateOf(unit, actor.agencyId, current.id);
    });
  }

  /** Sends the saved draft for review. */
  async submit(
    actor: ProfileActor,
    version: number,
    correlationId: string,
  ): Promise<OwnProfileState> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindOwned(unit, actor);
      await this.applySubmit(unit, actor, current, version, correlationId);
      return this.stateOf(unit, actor.agencyId, current.id);
    });
  }

  /** Asks for changes to a published profile to be approved. */
  async requestEdit(
    actor: ProfileActor,
    input: ProfileInput,
    correlationId: string,
  ): Promise<OwnProfileState> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindOwned(unit, actor);
      await this.applyRequestEdit(unit, actor, current, input, correlationId);
      return this.stateOf(unit, actor.agencyId, current.id);
    });
  }

  /** Withdraws the waiting review. A first submission goes back to being an editable draft. */
  async cancelPending(actor: ProfileActor, correlationId: string): Promise<OwnProfileState> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindOwned(unit, actor);
      await this.applyCancel(unit, actor, current, correlationId);
      return this.stateOf(unit, actor.agencyId, current.id);
    });
  }

  // ------------------------------------------------------------------------------------------
  // An assisted client's profile, worked on by staff
  // ------------------------------------------------------------------------------------------

  /** A profile as staff see it, for a profile they may manage. */
  async getClient(actor: ProfileActor, profileId: string): Promise<OwnProfileState> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.mustFindManaged(unit, actor, profileId, false);
      return this.stateOf(unit, actor.agencyId, profileId);
    });
  }

  /**
   * Creates the draft of an assisted client. The client has no login: the profile belongs to the
   * agency, created by this staff member and assigned to an agent.
   */
  async createClient(
    actor: ProfileActor,
    input: ProfileInput,
    assignedAgentId: string | null,
    correlationId: string,
  ): Promise<{ id: string; state: OwnProfileState }> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const data = dataOf(input);
      for (let attempt = 0; attempt < MEMBER_CODE_ATTEMPTS; attempt += 1) {
        const id = await unit.createClient(
          actor.agencyId,
          actor.accountId,
          assignedAgentId,
          this.memberCode(),
          data,
        );
        if (!id) continue;
        await unit.appendEvent(this.event('client.created', actor, id, correlationId));
        return { id, state: await this.stateOf(unit, actor.agencyId, id) };
      }
      throw new AppError(503, 'MEMBER_CODE_UNAVAILABLE');
    });
  }

  async saveClient(
    actor: ProfileActor,
    profileId: string,
    input: ProfileInput,
  ): Promise<OwnProfileState> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindAssisted(unit, actor, profileId);
      await this.applySave(unit, actor, current, input);
      return this.stateOf(unit, actor.agencyId, profileId);
    });
  }

  async submitClient(
    actor: ProfileActor,
    profileId: string,
    version: number,
    correlationId: string,
  ): Promise<OwnProfileState> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindAssisted(unit, actor, profileId);
      await this.applySubmit(unit, actor, current, version, correlationId);
      return this.stateOf(unit, actor.agencyId, profileId);
    });
  }

  async requestClientEdit(
    actor: ProfileActor,
    profileId: string,
    input: ProfileInput,
    correlationId: string,
  ): Promise<OwnProfileState> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindAssisted(unit, actor, profileId);
      await this.applyRequestEdit(unit, actor, current, input, correlationId);
      return this.stateOf(unit, actor.agencyId, profileId);
    });
  }

  async cancelClientPending(
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ): Promise<OwnProfileState> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindAssisted(unit, actor, profileId);
      await this.applyCancel(unit, actor, current, correlationId);
      return this.stateOf(unit, actor.agencyId, profileId);
    });
  }

  /**
   * Moves a profile between its live states (active, paused, matched, closed). A profile waiting
   * for review cannot be moved: withdraw or decide the review first. Closed is final. This works
   * for a self-service member's profile too, since it changes whether the profile is shown, not
   * what it says.
   */
  async changeStatus(
    actor: ProfileActor,
    profileId: string,
    status: ProfileRecord['status'],
    version: number,
    correlationId: string,
  ): Promise<OwnProfileState> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFindManaged(unit, actor, profileId, true);
      this.requireVersion(current, version);
      const allowed = STATUS_MOVES[current.status] as readonly string[];
      if (!allowed.includes(status)) throw new AppError(409, 'STATUS_CHANGE_NOT_ALLOWED');
      await unit.setStatus(actor.agencyId, current.id, status);
      await unit.appendEvent(
        this.event('profile.status_changed', actor, current.id, correlationId),
      );
      return this.stateOf(unit, actor.agencyId, profileId);
    });
  }

  // ------------------------------------------------------------------------------------------
  // The rules, shared by both
  // ------------------------------------------------------------------------------------------

  private async applySave(
    unit: ProfileUnit,
    actor: ProfileActor,
    current: ProfileRecord,
    input: ProfileInput,
  ) {
    this.requireVersion(current, input.version);
    if (current.status === 'pending_review') throw new AppError(409, 'PROFILE_LOCKED');
    if (current.status !== 'draft' && current.status !== 'rejected') {
      throw new AppError(409, 'PROFILE_EDIT_REQUIRES_REVIEW');
    }
    // Saving a rejected profile makes it a draft again, ready to be resubmitted.
    await unit.saveContent(actor.agencyId, current.id, 'draft', dataOf(input));
  }

  private async applySubmit(
    unit: ProfileUnit,
    actor: ProfileActor,
    current: ProfileRecord,
    version: number,
    correlationId: string,
  ) {
    this.requireVersion(current, version);
    if (current.status === 'pending_review') throw new AppError(409, 'PROFILE_LOCKED');
    if (current.status !== 'draft' && current.status !== 'rejected') {
      throw new AppError(409, 'PROFILE_STATE_INVALID');
    }
    this.requireComplete(current.data);

    await unit.setStatus(actor.agencyId, current.id, 'pending_review');
    // The status change raised the version; the review is based on the version it will be judged against.
    const locked = await this.mustFindById(unit, actor.agencyId, current.id);
    await unit.insertReview(
      actor.agencyId,
      current.id,
      actor.accountId,
      'initial_submission',
      locked.version,
      locked.data,
    );
    await unit.appendEvent(this.event('profile.submitted', actor, current.id, correlationId));
  }

  private async applyRequestEdit(
    unit: ProfileUnit,
    actor: ProfileActor,
    current: ProfileRecord,
    input: ProfileInput,
    correlationId: string,
  ) {
    const proposed = dataOf(input);
    this.requireVersion(current, input.version);
    if (current.status === 'pending_review') throw new AppError(409, 'PROFILE_LOCKED');
    if (current.status !== 'active') throw new AppError(409, 'PROFILE_STATE_INVALID');
    if (await unit.pendingReview(actor.agencyId, current.id)) {
      throw new AppError(409, 'PROFILE_LOCKED');
    }

    const changes = diffProfileData(current.data, proposed);
    if (isEmptyChange(changes)) throw new AppError(422, 'NO_CHANGES');
    // A published profile must stay complete, so a change cannot empty a required field.
    this.requireComplete(proposed);

    await unit.insertReview(
      actor.agencyId,
      current.id,
      actor.accountId,
      'field_update',
      current.version,
      changes,
    );
    await unit.appendEvent(this.event('profile.edit_requested', actor, current.id, correlationId));
  }

  private async applyCancel(
    unit: ProfileUnit,
    actor: ProfileActor,
    current: ProfileRecord,
    correlationId: string,
  ) {
    const pending = await unit.pendingReview(actor.agencyId, current.id);
    if (!pending) throw new AppError(404, 'NO_PENDING_REVIEW');

    await unit.cancelReview(actor.agencyId, pending.id);
    if (pending.kind === 'initial_submission') {
      await unit.setStatus(actor.agencyId, current.id, 'draft');
    }
    await unit.appendEvent(
      this.event('profile.review_cancelled', actor, current.id, correlationId),
    );
  }

  // ------------------------------------------------------------------------------------------
  // Access
  // ------------------------------------------------------------------------------------------

  // Only members have a profile of their own. Staff work on clients' profiles by id.
  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private requireStaff(actor: ProfileActor) {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  /**
   * A profile staff may manage. One they may not manage is reported as not found, so an agent
   * cannot tell which profiles exist beyond their own.
   */
  private async mustFindManaged(
    unit: ProfileUnit,
    actor: ProfileActor,
    profileId: string,
    lock: boolean,
  ) {
    const profile = await unit.findById(actor.agencyId, profileId, lock);
    if (!profile || !canManage(actor, profile)) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  /** A client whose content staff may change: an assisted client, never a member's own profile. */
  private async mustFindAssisted(unit: ProfileUnit, actor: ProfileActor, profileId: string) {
    const profile = await this.mustFindManaged(unit, actor, profileId, true);
    if (profile.serviceMode !== 'assisted') throw new AppError(403, 'PROFILE_SELF_SERVICE');
    return profile;
  }

  private requireVersion(current: ProfileRecord, version: number | null | undefined) {
    if (version == null || version !== current.version) {
      throw new AppError(409, 'PROFILE_VERSION_CONFLICT');
    }
  }

  private requireComplete(data: ProfileData) {
    const missing = missingRequired(data);
    if (missing.length > 0) {
      throw new AppError(422, 'PROFILE_INCOMPLETE', {
        fields: missing.map((path) => ({ path, code: 'required' })),
      });
    }
  }

  private async mustFindOwned(unit: ProfileUnit, actor: ProfileActor) {
    const profile = await unit.findByOwner(actor.agencyId, actor.accountId, true);
    if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  private async mustFindById(unit: ProfileUnit, agencyId: string, profileId: string) {
    const profile = await unit.findById(agencyId, profileId, true);
    if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  private async createDraft(unit: ProfileUnit, actor: ProfileActor, data: ProfileData) {
    for (let attempt = 0; attempt < MEMBER_CODE_ATTEMPTS; attempt += 1) {
      const id = await unit.create(actor.agencyId, actor.accountId, this.memberCode(), data);
      if (id) return id;
      // No row was added: either another request just created this member's profile, or the
      // random member code was already taken. Tell the two apart, and only retry for the code.
      if (await unit.findByOwner(actor.agencyId, actor.accountId, true)) {
        throw new AppError(409, 'PROFILE_VERSION_CONFLICT');
      }
    }
    throw new AppError(503, 'MEMBER_CODE_UNAVAILABLE');
  }

  private async stateOwnedBy(unit: ProfileUnit, actor: ProfileActor): Promise<OwnProfileState> {
    const profile = await unit.findByOwner(actor.agencyId, actor.accountId, false);
    if (!profile) return { profile: null, pendingReview: null, lastDecision: null };
    return this.stateOf(unit, actor.agencyId, profile.id);
  }

  private async stateOf(
    unit: ProfileUnit,
    agencyId: string,
    profileId: string,
  ): Promise<OwnProfileState> {
    const profile = await unit.findById(agencyId, profileId, false);
    if (!profile) return { profile: null, pendingReview: null, lastDecision: null };
    const [pendingReview, lastDecision] = await Promise.all([
      unit.pendingReview(agencyId, profile.id),
      unit.lastDecision(agencyId, profile.id),
    ]);
    return { profile, pendingReview, lastDecision };
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    profileId: string,
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
      subjectId: profileId,
    };
  }
}
