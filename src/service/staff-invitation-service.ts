import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '../bo/event.js';
import type { Account } from '../bo/identity.js';
import {
  INVITATION_DAYS,
  type InvitationPreview,
  type StaffInvitation,
  type StaffInviteInput,
} from '../bo/staff.js';
import type { StaffInvitationDbService } from '../db/service/staff-invitation-db-service.js';
import { AppError } from '../exception/app-error.js';

/** The admin doing the inviting. */
export interface InvitingAdmin {
  agencyId: string;
  accountId: string;
  role: 'admin' | 'agent' | 'member';
}

/**
 * Inviting staff and creating their accounts.
 *
 * - Only an admin invites, lists or cancels invitations.
 * - An address that already has an account is never invited: a member is not turned into staff by
 *   an invitation, and the role of an existing account is never changed here.
 * - The account is created only when the link is accepted, with the role written in the
 *   invitation by the admin. It cannot come from the person accepting.
 * - Only a hash of the link's secret is stored. Accepting is one transaction: the invitation is
 *   locked, the account and its password are created and the invitation is marked accepted, so a
 *   link works once even when it is opened twice at the same moment.
 */
export class StaffInvitationService {
  constructor(private readonly db: Pick<StaffInvitationDbService, 'inTransaction'>) {}

  /** Creates the invitation, or replaces the open one for the same address (new link, new expiry). */
  async invite(
    admin: InvitingAdmin,
    input: StaffInviteInput,
    tokenHash: string,
    correlationId: string,
  ): Promise<StaffInvitation> {
    this.requireAdmin(admin);
    return this.db.inTransaction(admin.agencyId, async (unit) => {
      if (await unit.findAccountByEmail(admin.agencyId, input.email))
        throw new AppError(409, 'EMAIL_IN_USE');
      const id = await unit.upsertOpen(admin.agencyId, {
        email: input.email,
        displayName: input.displayName,
        role: input.role,
        locale: input.locale,
        invitedBy: admin.accountId,
        tokenHash,
        days: INVITATION_DAYS,
      });
      await unit.appendEvent(
        this.event('staff.invited', admin.agencyId, admin.accountId, id, correlationId),
      );
      return this.mustFind(unit, admin.agencyId, id);
    });
  }

  /** Replaces the link of an open invitation with a new one. */
  async reissue(
    admin: InvitingAdmin,
    invitationId: string,
    tokenHash: string,
    correlationId: string,
  ): Promise<StaffInvitation> {
    this.requireAdmin(admin);
    return this.db.inTransaction(admin.agencyId, async (unit) => {
      const current = await unit.openById(admin.agencyId, invitationId);
      if (!current) throw new AppError(404, 'INVITATION_NOT_FOUND');
      if (await unit.findAccountByEmail(admin.agencyId, current.email))
        throw new AppError(409, 'EMAIL_IN_USE');
      const id = await unit.upsertOpen(admin.agencyId, {
        email: current.email,
        displayName: current.displayName,
        role: current.role,
        locale: current.locale,
        invitedBy: admin.accountId,
        tokenHash,
        days: INVITATION_DAYS,
      });
      await unit.appendEvent(
        this.event('staff.invited', admin.agencyId, admin.accountId, id, correlationId),
      );
      return this.mustFind(unit, admin.agencyId, id);
    });
  }

  async open(admin: InvitingAdmin): Promise<StaffInvitation[]> {
    this.requireAdmin(admin);
    return this.db.inTransaction(admin.agencyId, (unit) => unit.open(admin.agencyId));
  }

  async revoke(admin: InvitingAdmin, invitationId: string, correlationId: string): Promise<void> {
    this.requireAdmin(admin);
    await this.db.inTransaction(admin.agencyId, async (unit) => {
      if (!(await unit.revoke(admin.agencyId, invitationId)))
        throw new AppError(404, 'INVITATION_NOT_FOUND');
      await unit.appendEvent(
        this.event(
          'staff.invitation_revoked',
          admin.agencyId,
          admin.accountId,
          invitationId,
          correlationId,
        ),
      );
    });
  }

  /** What the link is for, without using it up. Null when it is unknown, used, cancelled or old. */
  async preview(agencyId: string, tokenHash: string): Promise<InvitationPreview | null> {
    const found = await this.db.inTransaction(agencyId, (unit) =>
      unit.byLink(agencyId, tokenHash, false),
    );
    return found && { email: found.email, displayName: found.displayName, role: found.role };
  }

  /**
   * Creates the account for an invitation link, with the password hash already made. Null when the
   * link is not good any more, or when the address got an account since it was sent.
   */
  async accept(
    agencyId: string,
    tokenHash: string,
    passwordHash: string,
    correlationId: string,
  ): Promise<Account | null> {
    return this.db.inTransaction(agencyId, async (unit): Promise<Account | null> => {
      const invitation = await unit.byLink(agencyId, tokenHash, true);
      if (!invitation) return null;
      const account = await unit.createStaff(agencyId, {
        id: randomUUID(),
        displayName: invitation.displayName,
        email: invitation.email,
        role: invitation.role,
        locale: invitation.locale,
      });
      if (!account) return null;
      await unit.createCredential(agencyId, account.id, passwordHash);
      await unit.markAccepted(agencyId, invitation.id, account.id);
      await unit.appendEvent(
        this.event('staff.invitation_accepted', agencyId, account.id, account.id, correlationId),
      );
      return account;
    });
  }

  private requireAdmin(admin: InvitingAdmin) {
    if (admin.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private async mustFind(
    unit: { openById(agencyId: string, id: string): Promise<StaffInvitation | null> },
    agencyId: string,
    id: string,
  ): Promise<StaffInvitation> {
    const found = await unit.openById(agencyId, id);
    if (!found) throw new AppError(500, 'INTERNAL_ERROR');
    return found;
  }

  private event(
    type: WorkflowEvent['type'],
    agencyId: string,
    actorId: string,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
      agencyId,
      actorId,
      subjectId,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
    };
  }
}
