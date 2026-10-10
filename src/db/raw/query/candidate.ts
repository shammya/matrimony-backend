import { PREFERENCE_COLUMNS, PROFILE_COLUMNS } from './profile-columns.js';

// A profile with its partner preferences in one row, so a candidate can be scored without a second
// query. A profile with no preferences row reads as having no preferences.
const profileSelect = PROFILE_COLUMNS.map((spec) =>
  spec.kind === 'date'
    ? `to_char(m.${spec.column}, 'YYYY-MM-DD') AS ${spec.column}`
    : `m.${spec.column}`,
).join(', ');
const preferenceSelect = PREFERENCE_COLUMNS.map((spec) =>
  spec.kind === 'list'
    ? `COALESCE(p.${spec.column}, '{}'::text[]) AS ${spec.column}`
    : `p.${spec.column}`,
).join(', ');

const WITH_PREFERENCES = `SELECT m.id, m.member_code, m.status, m.version, m.service_mode, m.owner_account_id, m.assigned_agent_id, m.current_division_code, m.created_at, m.updated_at, ${profileSelect}, ${preferenceSelect}
 FROM matrimony.member_profiles m
 LEFT JOIN matrimony.partner_preferences p ON p.agency_id = m.agency_id AND p.profile_id = m.id`;

export const candidateQueries = {
  // $1 agency, $2 client. Locks the client's row so two runs for one client go one after the other.
  client: `${WITH_PREFERENCES} WHERE m.agency_id = $1 AND m.id = $2 FOR UPDATE OF m`,

  clientRead: `${WITH_PREFERENCES} WHERE m.agency_id = $1 AND m.id = $2`,

  // $1 agency, $2 client, $3 the client's gender, $4 limit. Published profiles of the other gender
  // that staff have not already released or removed for this client.
  pool: `${WITH_PREFERENCES}
 WHERE m.agency_id = $1 AND m.status = 'active' AND m.id <> $2
   AND m.gender IS NOT NULL AND m.gender <> $3
   AND NOT EXISTS (
     SELECT 1 FROM matrimony.client_candidates c
      WHERE c.agency_id = m.agency_id AND c.client_profile_id = $2
        AND c.candidate_profile_id = m.id AND c.state IN ('released', 'removed'))
 ORDER BY m.created_at DESC, m.id
 LIMIT $4`,

  // $1 agency, $2 client, then parallel arrays: candidate ids, met, unmet, unknown, criteria (jsonb).
  // A row staff already released or removed is never touched.
  upsert: `INSERT INTO matrimony.client_candidates
   (agency_id, client_profile_id, candidate_profile_id, state, met_count, unmet_count, unknown_count, criteria)
 SELECT $1::uuid, $2::uuid, t.candidate, 'proposed', t.met, t.unmet, t.unknown, t.criteria
   FROM unnest($3::uuid[], $4::int[], $5::int[], $6::int[], $7::jsonb[])
     AS t(candidate, met, unmet, unknown, criteria)
 ON CONFLICT (agency_id, client_profile_id, candidate_profile_id) DO UPDATE
   SET state = 'proposed', met_count = EXCLUDED.met_count, unmet_count = EXCLUDED.unmet_count,
       unknown_count = EXCLUDED.unknown_count, criteria = EXCLUDED.criteria, updated_at = now()
 WHERE matrimony.client_candidates.state IN ('proposed', 'lapsed')`,

  // $1 agency, $2 client, $3 the candidates that stay proposed. The other proposals lapse.
  lapse: `UPDATE matrimony.client_candidates SET state = 'lapsed', updated_at = now()
 WHERE agency_id = $1 AND client_profile_id = $2 AND state = 'proposed'
   AND candidate_profile_id <> ALL($3::uuid[])`,

  // $1 agency, $2 client, $3 state, $4 limit. Best fit first, the same order the run ranks by.
  list: `SELECT c.candidate_profile_id, c.state, c.met_count, c.unmet_count, c.unknown_count, c.criteria,
        c.proposed_at, m.member_code, m.full_name, to_char(m.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
        m.profession_code, m.occupation_code, m.current_district_code, m.religion_code,
        m.marital_status, m.status AS profile_status
   FROM matrimony.client_candidates c
   JOIN matrimony.member_profiles m ON m.agency_id = c.agency_id AND m.id = c.candidate_profile_id
  WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.state = $3
  ORDER BY c.unmet_count, c.met_count DESC, c.unknown_count, m.created_at DESC, c.candidate_profile_id
  LIMIT $4`,

  // $1 agency, $2 client.
  settings: `SELECT cap, visible_fields FROM matrimony.client_release_settings
 WHERE agency_id = $1 AND client_profile_id = $2`,

  // $1 agency, $2 client, $3 cap, $4 fields, $5 who.
  saveSettings: `INSERT INTO matrimony.client_release_settings
   (agency_id, client_profile_id, cap, visible_fields, updated_by)
 VALUES ($1, $2, $3, $4::text[], $5)
 ON CONFLICT (agency_id, client_profile_id) DO UPDATE
   SET cap = EXCLUDED.cap, visible_fields = EXCLUDED.visible_fields,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,

  // $1 agency, $2 client.
  releasedCount: `SELECT count(*)::int AS n FROM matrimony.client_candidates
 WHERE agency_id = $1 AND client_profile_id = $2 AND state = 'released'`,

  // $1 agency, $2 client, $3 the asked-for candidates. Those still proposed whose profile is still published.
  releasable: `SELECT c.candidate_profile_id AS id FROM matrimony.client_candidates c
   JOIN matrimony.member_profiles m ON m.agency_id = c.agency_id AND m.id = c.candidate_profile_id
  WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.state = 'proposed'
    AND m.status = 'active' AND c.candidate_profile_id = ANY($3::uuid[])`,

  // $1 agency, $2 client, $3 candidates, $4 who. Only what is still proposed moves.
  markReleased: `UPDATE matrimony.client_candidates
   SET state = 'released', decided_by = $4, decided_at = now(), updated_at = now()
 WHERE agency_id = $1 AND client_profile_id = $2 AND state = 'proposed'
   AND candidate_profile_id = ANY($3::uuid[]) RETURNING candidate_profile_id AS id`,

  // The same arguments. Anything proposed, lapsed or released can be removed; removed stays removed.
  markRemoved: `UPDATE matrimony.client_candidates
   SET state = 'removed', decided_by = $4, decided_at = now(), updated_at = now()
 WHERE agency_id = $1 AND client_profile_id = $2 AND state IN ('proposed', 'lapsed', 'released')
   AND candidate_profile_id = ANY($3::uuid[]) RETURNING candidate_profile_id AS id`,
};
