import type { Account } from '../../../bo/identity.js';
import type { InvitationPreview, StaffInvitation } from '../../../bo/staff.js';
import type { Transaction } from '../../config/database.js';
import { accountRow } from '../../entity/identity.js';
import { invitationLinkRow, invitationRow } from '../../entity/staff-invitation.js';
import { mapAccount } from '../mapper/identity.js';
import { staffInvitationQueries } from '../query/staff-invitation.js';

/** The invitation a link belongs to, with what is needed to accept it. */
export interface InvitationForLink extends InvitationPreview {
  id: string;
  locale: 'bn' | 'en';
}

function mapInvitation(value: unknown): StaffInvitation {
  const row = invitationRow.parse(value);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    locale: row.locale,
    invitedByName: row.invited_by_name,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    status: row.expired ? 'expired' : 'pending',
  };
}

/** All reads and writes of staff invitations. Every method runs inside the transaction it is given. */
export class StaffInvitationRepository {
  /** Creates the open invitation for this address, or replaces the one that is already open. */
  async upsertOpen(
    tx: Transaction,
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
  ): Promise<string> {
    const result = await tx.query(staffInvitationQueries.upsertOpen, [
      agencyId,
      invitation.email,
      invitation.displayName,
      invitation.role,
      invitation.locale,
      invitation.invitedBy,
      invitation.tokenHash,
      invitation.days,
    ]);
    return String(result.rows[0].id);
  }

  async open(tx: Transaction, agencyId: string): Promise<StaffInvitation[]> {
    const result = await tx.query(staffInvitationQueries.openList, [agencyId]);
    return result.rows.map(mapInvitation);
  }

  async openById(
    tx: Transaction,
    agencyId: string,
    invitationId: string,
  ): Promise<StaffInvitation | null> {
    const result = await tx.query(staffInvitationQueries.openById, [agencyId, invitationId]);
    return result.rows[0] ? mapInvitation(result.rows[0]) : null;
  }

  /** The invitation this link opens while it can still be accepted. `lock` when it is to be accepted. */
  async byLink(
    tx: Transaction,
    agencyId: string,
    tokenHash: string,
    lock: boolean,
  ): Promise<InvitationForLink | null> {
    const result = await tx.query(`${staffInvitationQueries.byLink}${lock ? ' FOR UPDATE' : ''}`, [
      agencyId,
      tokenHash,
    ]);
    const row = result.rows[0] ? invitationLinkRow.parse(result.rows[0]) : null;
    return row
      ? {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
          locale: row.locale,
        }
      : null;
  }

  /** The new account, or null when the address got an account since the invitation was sent. */
  async createStaff(
    tx: Transaction,
    agencyId: string,
    staff: {
      id: string;
      displayName: string;
      email: string;
      role: string;
      locale: string;
    },
  ): Promise<Account | null> {
    const result = await tx.query(staffInvitationQueries.insertStaffAccount, [
      agencyId,
      staff.id,
      staff.displayName,
      staff.email,
      staff.role,
      staff.locale,
    ]);
    return result.rows[0] ? mapAccount(accountRow.parse(result.rows[0])) : null;
  }

  async markAccepted(
    tx: Transaction,
    agencyId: string,
    invitationId: string,
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(staffInvitationQueries.markAccepted, [
      agencyId,
      invitationId,
      accountId,
    ]);
    return result.rowCount === 1;
  }

  /** False when the invitation is not open (unknown, accepted or already cancelled). */
  async revoke(tx: Transaction, agencyId: string, invitationId: string): Promise<boolean> {
    const result = await tx.query(staffInvitationQueries.revoke, [agencyId, invitationId]);
    return result.rowCount === 1;
  }
}
