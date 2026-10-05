import { randomUUID } from 'node:crypto';
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
  'profile.submitted' | 'profile.edit_requested' | 'profile.review_cancelled'
>;

const MEMBER_CODE_ATTEMPTS = 5;

const dataOf = (input: ProfileInput): ProfileData => ({
  profile: input.profile,
  contact: input.contact,
  preferences: input.preferences,
});

/**
 * A member's own profile and its review workflow.
 *
 * - A draft (or a rejected profile) is edited in place and saved as often as needed.
 * - Submitting locks it as "pending review". The member can withdraw it to edit again.
 * - Once published, a change is never applied directly: it becomes a review request carrying only
 *   the fields that differ, and the published version stays visible until it is approved.
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

  async get(actor: ProfileActor): Promise<OwnProfileState> {
    this.requireMember(actor);
    return this.db.read(actor.agencyId, actor.accountId);
  }

  /** Saves the draft, creating the profile on the first save. */
  async save(actor: ProfileActor, input: ProfileInput): Promise<OwnProfileState> {
    this.requireMember(actor);
    const data = dataOf(input);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await unit.findByOwner(actor.agencyId, actor.accountId, true);
      if (!current) {
        // A first save has no version. One that claims a version refers to a profile that is gone.
        if (input.version != null) throw new AppError(409, 'PROFILE_VERSION_CONFLICT');
        await this.createDraft(unit, actor, data);
        return this.state(unit, actor);
      }
      this.requireVersion(current, input.version);
      if (current.status === 'pending_review') throw new AppError(409, 'PROFILE_LOCKED');
      if (current.status !== 'draft' && current.status !== 'rejected') {
        throw new AppError(409, 'PROFILE_EDIT_REQUIRES_REVIEW');
      }
      // Saving a rejected profile makes it a draft again, ready to be resubmitted.
      await unit.saveContent(actor.agencyId, current.id, 'draft', data);
      return this.state(unit, actor);
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
      const current = await this.mustFind(unit, actor);
      this.requireVersion(current, version);
      if (current.status === 'pending_review') throw new AppError(409, 'PROFILE_LOCKED');
      if (current.status !== 'draft' && current.status !== 'rejected') {
        throw new AppError(409, 'PROFILE_STATE_INVALID');
      }
      this.requireComplete(current.data);

      await unit.setStatus(actor.agencyId, current.id, 'pending_review');
      // The status change raised the version; the review is based on the version it will be judged against.
      const locked = await this.mustFind(unit, actor);
      await unit.insertReview(
        actor.agencyId,
        current.id,
        actor.accountId,
        'initial_submission',
        locked.version,
        locked.data,
      );
      await unit.appendEvent(this.event('profile.submitted', actor, current.id, correlationId));
      return this.state(unit, actor);
    });
  }

  /** Asks for changes to a published profile to be approved. */
  async requestEdit(
    actor: ProfileActor,
    input: ProfileInput,
    correlationId: string,
  ): Promise<OwnProfileState> {
    this.requireMember(actor);
    const proposed = dataOf(input);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFind(unit, actor);
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
      await unit.appendEvent(
        this.event('profile.edit_requested', actor, current.id, correlationId),
      );
      return this.state(unit, actor);
    });
  }

  /** Withdraws the waiting review. A first submission goes back to being an editable draft. */
  async cancelPending(actor: ProfileActor, correlationId: string): Promise<OwnProfileState> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const current = await this.mustFind(unit, actor);
      const pending = await unit.pendingReview(actor.agencyId, current.id);
      if (!pending) throw new AppError(404, 'NO_PENDING_REVIEW');

      await unit.cancelReview(actor.agencyId, pending.id);
      if (pending.kind === 'initial_submission') {
        await unit.setStatus(actor.agencyId, current.id, 'draft');
      }
      await unit.appendEvent(
        this.event('profile.review_cancelled', actor, current.id, correlationId),
      );
      return this.state(unit, actor);
    });
  }

  // Only members have a profile of their own. Agents and admins work on clients' profiles elsewhere.
  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
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

  private async mustFind(unit: ProfileUnit, actor: ProfileActor) {
    const profile = await unit.findByOwner(actor.agencyId, actor.accountId, true);
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

  private async state(unit: ProfileUnit, actor: ProfileActor): Promise<OwnProfileState> {
    const profile = await unit.findByOwner(actor.agencyId, actor.accountId, false);
    if (!profile) return { profile: null, pendingReview: null, lastDecision: null };
    const [pendingReview, lastDecision] = await Promise.all([
      unit.pendingReview(actor.agencyId, profile.id),
      unit.lastDecision(actor.agencyId, profile.id),
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
