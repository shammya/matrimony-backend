import { divisionOf } from '../../../bo/dictionaries.js';
import type { ProfileData, ProposedChanges } from '../../../bo/profile.js';
import type { ProfileRecord, ReviewKind, ReviewRecord } from '../../../bo/profile-state.js';
import type { Transaction } from '../../config/database.js';
import { mapProfile, mapReview } from '../mapper/profile.js';
import { profileQueries } from '../query/profile.js';
import {
  CONTACT_COLUMNS,
  emptyValue,
  PREFERENCE_COLUMNS,
  PROFILE_COLUMNS,
  type ColumnSpec,
} from '../query/profile-columns.js';

/** The values for a table's columns, in column order. A field the content lacks is stored empty. */
const valuesFor = (specs: readonly ColumnSpec[], content: object) =>
  specs.map((spec) => (content as Record<string, unknown>)[spec.key] ?? emptyValue(spec));

const divisionFor = (data: ProfileData) => divisionOf(data.profile.currentDistrictCode);

/** All profile reads and writes. Every method runs inside the transaction it is given. */
export class ProfileRepository {
  async findByOwner(
    tx: Transaction,
    agencyId: string,
    ownerId: string,
    lock: boolean,
  ): Promise<ProfileRecord | null> {
    const found = await tx.query(lock ? profileQueries.byOwnerForUpdate : profileQueries.byOwner, [
      agencyId,
      ownerId,
    ]);
    const row = found.rows[0];
    if (!row) return null;
    const [contact, preferences] = await Promise.all([
      tx.query(profileQueries.contact, [agencyId, row.id]),
      tx.query(profileQueries.preferences, [agencyId, row.id]),
    ]);
    return mapProfile(row, contact.rows[0], preferences.rows[0]);
  }

  /** Inserts a new draft. False when the owner already has a profile or the member code is taken. */
  async create(
    tx: Transaction,
    agencyId: string,
    ownerId: string,
    memberCode: string,
    data: ProfileData,
  ): Promise<string | null> {
    const result = await tx.query(profileQueries.insert, [
      agencyId,
      memberCode,
      ownerId,
      divisionFor(data),
      ...valuesFor(PROFILE_COLUMNS, data.profile),
    ]);
    const id = (result.rows[0] as { id: string } | undefined)?.id ?? null;
    if (id) await this.saveChildren(tx, agencyId, id, data);
    return id;
  }

  /**
   * Replaces the content and sets the status. The parent row is always updated, even when only
   * the contact or preferences changed, so the version rises for every change (the database
   * trigger cannot see edits to the two child tables).
   */
  async saveContent(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    status: ProfileRecord['status'],
    data: ProfileData,
  ) {
    await tx.query(profileQueries.updateContent, [
      agencyId,
      profileId,
      status,
      divisionFor(data),
      ...valuesFor(PROFILE_COLUMNS, data.profile),
    ]);
    await this.saveChildren(tx, agencyId, profileId, data);
  }

  async setStatus(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    status: ProfileRecord['status'],
  ) {
    await tx.query(profileQueries.updateStatus, [agencyId, profileId, status]);
  }

  async insertReview(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    submittedBy: string,
    kind: ReviewKind,
    baseVersion: number,
    changes: ProposedChanges | ProfileData,
  ): Promise<ReviewRecord> {
    const result = await tx.query(profileQueries.insertReview, [
      agencyId,
      profileId,
      submittedBy,
      kind,
      baseVersion,
      JSON.stringify(changes),
    ]);
    return mapReview(result.rows[0]);
  }

  async pendingReview(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(profileQueries.pendingReview, [agencyId, profileId]);
    return result.rows[0] ? mapReview(result.rows[0]) : null;
  }

  async cancelReview(tx: Transaction, agencyId: string, reviewId: string) {
    await tx.query(profileQueries.cancelReview, [agencyId, reviewId]);
  }

  async lastDecision(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(profileQueries.lastDecision, [agencyId, profileId]);
    return result.rows[0] ? mapReview(result.rows[0]) : null;
  }

  private async saveChildren(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    data: ProfileData,
  ) {
    await tx.query(profileQueries.upsertContact, [
      agencyId,
      profileId,
      ...valuesFor(CONTACT_COLUMNS, data.contact),
    ]);
    await tx.query(profileQueries.upsertPreferences, [
      agencyId,
      profileId,
      ...valuesFor(PREFERENCE_COLUMNS, data.preferences),
    ]);
  }
}
