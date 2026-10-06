// The approval queue's SQL. A request, the profile it is about, who submitted it and (once decided)
// who decided it.
const ITEM_COLUMNS = `r.id, r.kind, r.status, r.created_at,
 to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position, r.photo_id,
 r.submitted_by_account_id, s.display_name AS submitter_name,
 p.id AS profile_id, p.member_code, p.full_name, p.service_mode, p.assigned_agent_id`;

const ITEM_FROM = `FROM matrimony.profile_reviews r
 JOIN matrimony.member_profiles p ON p.agency_id = r.agency_id AND p.id = r.profile_id
 JOIN matrimony.accounts s ON s.agency_id = r.agency_id AND s.id = r.submitted_by_account_id`;

// A request kind the queue does not show (the removal of a photo is immediate and needs no review).
const QUEUE_KINDS = `r.kind IN ('initial_submission', 'field_update', 'photo_add')`;

// $4 is the agent whose view this is, or null for an admin, who sees everything. An agent sees the
// requests for profiles assigned to them and for profiles nobody has been assigned to yet.
const VISIBLE = `($4::uuid IS NULL OR p.assigned_agent_id = $4 OR p.assigned_agent_id IS NULL)`;

/**
 * One page of the queue. Waiting requests are oldest first (the longest wait is served first);
 * decided ones are newest first. $1 agency, $2 status, $3 kind or null, $4 viewer, $5 and $6 the
 * position after which to continue (both null for the first page), $7 how many to fetch.
 */
export const listQuery = (direction: 'ASC' | 'DESC') => {
  const compare = direction === 'ASC' ? '>' : '<';
  return `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
 WHERE r.agency_id = $1 AND r.status = $2 AND ${QUEUE_KINDS}
   AND ($3::text IS NULL OR r.kind = $3)
   AND ${VISIBLE}
   AND ($5::timestamptz IS NULL OR (r.created_at, r.id) ${compare} ($5::timestamptz, $6::uuid))
 ORDER BY r.created_at ${direction}, r.id ${direction}
 LIMIT $7`;
};

const DETAIL = `SELECT ${ITEM_COLUMNS},
 r.base_profile_version, r.proposed_changes, r.reviewer_notes, r.reviewed_at,
 r.reviewer_account_id, d.display_name AS reviewer_name
 ${ITEM_FROM}
 LEFT JOIN matrimony.accounts d ON d.agency_id = r.agency_id AND d.id = r.reviewer_account_id
 WHERE r.agency_id = $1 AND r.id = $2 AND ${QUEUE_KINDS}`;

export const reviewQueries = {
  // Locks the request itself, so two reviewers deciding at once run one after the other.
  detail: DETAIL,
  detailForUpdate: `${DETAIL} FOR UPDATE OF r`,

  // $1 agency, $2 viewer (null for an admin).
  pendingCount: `SELECT count(*)::int AS n FROM matrimony.profile_reviews r
 JOIN matrimony.member_profiles p ON p.agency_id = r.agency_id AND p.id = r.profile_id
 WHERE r.agency_id = $1 AND r.status = 'pending' AND ${QUEUE_KINDS}
   AND ($2::uuid IS NULL OR p.assigned_agent_id = $2 OR p.assigned_agent_id IS NULL)`,

  photo: `SELECT id, profile_id, storage_key, status FROM matrimony.profile_photos
 WHERE agency_id = $1 AND id = $2`,
  photoForUpdate: `SELECT id, profile_id, storage_key, status FROM matrimony.profile_photos
 WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
  publishPhoto: `UPDATE matrimony.profile_photos SET status = 'published'
 WHERE agency_id = $1 AND id = $2 AND status = 'staged'`,
  // The first approved photo becomes the main one.
  makeMainIfNone: `UPDATE matrimony.profile_photos SET is_primary = true
 WHERE agency_id = $1 AND id = $2 AND NOT EXISTS (
   SELECT 1 FROM matrimony.profile_photos
   WHERE agency_id = $1 AND profile_id = $3 AND is_primary)`,

  // Only a request that is still waiting can be decided: a second decision changes nothing.
  decide: `UPDATE matrimony.profile_reviews
 SET status = $3, reviewer_account_id = $4, reviewer_notes = $5, reviewed_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,
};
