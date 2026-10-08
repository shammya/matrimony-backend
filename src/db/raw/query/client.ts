// Client management's SQL. Writes to a profile itself (its content, its status) go through the
// profile queries; this is the list, the lookups around it and the assignment.
const ITEM = `p.id, p.member_code, p.full_name, p.status, p.service_mode, p.version, p.updated_at,
 to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position,
 p.assigned_agent_id, a.display_name AS agent_name, p.current_district_code,
 EXISTS (
   SELECT 1 FROM matrimony.profile_reviews r
   WHERE r.agency_id = p.agency_id AND r.profile_id = p.id AND r.status = 'pending'
     AND r.kind IN ('initial_submission', 'field_update')
 ) AS has_pending_review`;

/**
 * One page of clients, most recently changed first. $1 agency; $2 the agent whose view this is
 * (an agent sees only their own), or null for an admin; $3 status; $4 service mode; $5 an agent to
 * show (admin filter) or null; $6 true to show only unassigned (admin filter); $7 a LIKE pattern
 * for the name or member code, or null; $8 and $9 the position to continue after; $10 how many.
 */
export const clientListQuery = `SELECT ${ITEM}
 FROM matrimony.member_profiles p
 LEFT JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.assigned_agent_id
 WHERE p.agency_id = $1
   AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
   AND ($3::text IS NULL OR p.status = $3)
   AND ($4::text IS NULL OR p.service_mode = $4)
   AND ($5::uuid IS NULL OR p.assigned_agent_id = $5)
   AND (NOT $6::boolean OR p.assigned_agent_id IS NULL)
   AND ($7::text IS NULL OR p.full_name ILIKE $7 ESCAPE '\\' OR p.member_code ILIKE $7 ESCAPE '\\')
   AND ($8::timestamptz IS NULL OR (p.updated_at, p.id) < ($8::timestamptz, $9::uuid))
 ORDER BY p.updated_at DESC, p.id DESC
 LIMIT $10`;

export const clientQueries = {
  // Who looks after a profile and, for a member's own, who the member is.
  meta: `SELECT p.service_mode, p.assigned_agent_id, a.display_name AS agent_name,
 p.owner_account_id, o.display_name AS owner_name
 FROM matrimony.member_profiles p
 LEFT JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.assigned_agent_id
 LEFT JOIN matrimony.accounts o ON o.agency_id = p.agency_id AND o.id = p.owner_account_id
 WHERE p.agency_id = $1 AND p.id = $2`,

  staff: `SELECT id, display_name, email, role, status FROM matrimony.accounts
 WHERE agency_id = $1 AND role IN ('admin', 'agent') ORDER BY role, display_name`,
  staffMember: `SELECT id, display_name, email, role, status FROM matrimony.accounts
 WHERE agency_id = $1 AND id = $2 AND role IN ('admin', 'agent')`,

  // Changes who looks after a profile, nothing else (the database does not raise the profile's
  // version for this, so requests waiting for review stay valid).
  assign: `UPDATE matrimony.member_profiles SET assigned_agent_id = $3
 WHERE agency_id = $1 AND id = $2 RETURNING id`,
};
