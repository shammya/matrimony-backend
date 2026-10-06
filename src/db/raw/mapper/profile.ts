import type { ProfileData, ProposedChanges } from '../../../bo/profile.js';
import type { ProfileRecord, ReviewRecord } from '../../../bo/profile-state.js';
import { contactRow, preferencesRow, profileRow, reviewRow } from '../../entity/profile.js';
import {
  CONTACT_COLUMNS,
  emptyValue,
  PREFERENCE_COLUMNS,
  PROFILE_COLUMNS,
  type ColumnSpec,
} from '../query/profile-columns.js';

/** A table's columns as the API's field names. A missing row reads as all empty. */
function fields(specs: readonly ColumnSpec[], row: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    specs.map((spec) => [spec.key, row?.[spec.column] ?? emptyValue(spec)]),
  );
}

export function mapProfile(
  profile: unknown,
  contact: unknown | undefined,
  preferences: unknown | undefined,
): ProfileRecord {
  const row = profileRow.parse(profile) as Record<string, unknown>;
  return {
    id: row.id as string,
    memberCode: row.member_code as string,
    status: row.status as ProfileRecord['status'],
    version: row.version as number,
    serviceMode: row.service_mode as ProfileRecord['serviceMode'],
    ownerId: row.owner_account_id as string | null,
    assignedAgentId: row.assigned_agent_id as string | null,
    currentDivisionCode: row.current_division_code as string | null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    data: {
      profile: fields(PROFILE_COLUMNS, row),
      contact: fields(CONTACT_COLUMNS, contact ? contactRow.parse(contact) : undefined),
      preferences: fields(
        PREFERENCE_COLUMNS,
        preferences ? preferencesRow.parse(preferences) : undefined,
      ),
    } as unknown as ProfileData,
  };
}

export function mapReview(value: unknown): ReviewRecord {
  const row = reviewRow.parse(value);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    baseProfileVersion: row.base_profile_version,
    proposedChanges: row.proposed_changes as ProposedChanges | null,
    reviewerNotes: row.reviewer_notes,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}
