import {
  CONTACT_COLUMNS,
  PREFERENCE_COLUMNS,
  PROFILE_COLUMNS,
  type ColumnSpec,
} from './profile-columns.js';

// A date column is read as plain text so the driver never turns it into a timezone-shifted Date.
const selectList = (specs: readonly ColumnSpec[]) =>
  specs
    .map((spec) =>
      spec.kind === 'date'
        ? `to_char(${spec.column}, 'YYYY-MM-DD') AS ${spec.column}`
        : spec.column,
    )
    .join(', ');

const names = (specs: readonly ColumnSpec[]) => specs.map((spec) => spec.column).join(', ');
const marks = (specs: readonly ColumnSpec[], first: number) =>
  specs.map((_, index) => `$${first + index}`).join(', ');
const assignments = (specs: readonly ColumnSpec[], first: number) =>
  specs.map((spec, index) => `${spec.column} = $${first + index}`).join(', ');
const upsertSet = (specs: readonly ColumnSpec[]) =>
  specs.map((spec) => `${spec.column} = EXCLUDED.${spec.column}`).join(', ');

const REVIEW_COLUMNS =
  'id, kind, status, base_profile_version, proposed_changes, reviewer_notes, reviewed_at, created_at';
const PROFILE_REVIEW_KINDS = "kind IN ('initial_submission', 'field_update')";

const byOwner = `SELECT id, member_code, status, version, current_division_code, created_at, updated_at, ${selectList(PROFILE_COLUMNS)}
 FROM matrimony.member_profiles WHERE agency_id = $1 AND owner_account_id = $2`;

export const profileQueries = {
  byOwner,
  // Locks the row so two requests changing the same profile run one after the other.
  byOwnerForUpdate: `${byOwner} FOR UPDATE`,

  // $1 agency, $2 member code, $3 owner (also the creator), $4 division, then the columns.
  insert: `INSERT INTO matrimony.member_profiles
 (agency_id, member_code, owner_account_id, created_by_account_id, current_division_code, ${names(PROFILE_COLUMNS)})
 VALUES ($1, $2, $3, $3, $4, ${marks(PROFILE_COLUMNS, 5)})
 ON CONFLICT DO NOTHING RETURNING id`,

  // $1 agency, $2 profile, $3 status, $4 division, then the columns.
  updateContent: `UPDATE matrimony.member_profiles SET status = $3, current_division_code = $4, ${assignments(PROFILE_COLUMNS, 5)}
 WHERE agency_id = $1 AND id = $2`,
  updateStatus: `UPDATE matrimony.member_profiles SET status = $3 WHERE agency_id = $1 AND id = $2`,

  contact: `SELECT ${selectList(CONTACT_COLUMNS)} FROM matrimony.profile_contacts WHERE agency_id = $1 AND profile_id = $2`,
  upsertContact: `INSERT INTO matrimony.profile_contacts (agency_id, profile_id, ${names(CONTACT_COLUMNS)})
 VALUES ($1, $2, ${marks(CONTACT_COLUMNS, 3)})
 ON CONFLICT (agency_id, profile_id) DO UPDATE SET ${upsertSet(CONTACT_COLUMNS)}`,

  preferences: `SELECT ${selectList(PREFERENCE_COLUMNS)} FROM matrimony.partner_preferences WHERE agency_id = $1 AND profile_id = $2`,
  upsertPreferences: `INSERT INTO matrimony.partner_preferences (agency_id, profile_id, ${names(PREFERENCE_COLUMNS)})
 VALUES ($1, $2, ${marks(PREFERENCE_COLUMNS, 3)})
 ON CONFLICT (agency_id, profile_id) DO UPDATE SET ${upsertSet(PREFERENCE_COLUMNS)}`,

  insertReview: `INSERT INTO matrimony.profile_reviews
 (agency_id, profile_id, submitted_by_account_id, kind, base_profile_version, proposed_changes)
 VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING ${REVIEW_COLUMNS}`,
  pendingReview: `SELECT ${REVIEW_COLUMNS} FROM matrimony.profile_reviews
 WHERE agency_id = $1 AND profile_id = $2 AND status = 'pending' AND ${PROFILE_REVIEW_KINDS}`,
  cancelReview: `UPDATE matrimony.profile_reviews SET status = 'cancelled', cancelled_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'pending'`,
  lastDecision: `SELECT ${REVIEW_COLUMNS} FROM matrimony.profile_reviews
 WHERE agency_id = $1 AND profile_id = $2 AND status IN ('approved', 'rejected') AND ${PROFILE_REVIEW_KINDS}
 ORDER BY reviewed_at DESC LIMIT 1`,
};
