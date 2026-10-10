import { selectionFor } from './match.js';
import type { VisibleField } from '../../../bo/release.js';

/**
 * Connection requests are stored in the `interests` table of the original design, and the inbox in
 * `notifications`. The column names are turned into the ones the code uses (from, to, shared) at
 * the edge of each query.
 */
const POSITION = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CONNECTION = `id, sender_profile_id AS from_profile_id, recipient_profile_id AS to_profile_id, status,
   (sender_contact_consent_at IS NOT NULL) AS from_shared_contact,
   (recipient_contact_consent_at IS NOT NULL) AS to_shared_contact`;

/** The interest of a pair of profiles, whichever of them asked. $1 agency, $2 and $3 the two profiles. */
const BETWEEN = `agency_id = $1
   AND ((sender_profile_id = $2 AND recipient_profile_id = $3)
     OR (sender_profile_id = $3 AND recipient_profile_id = $2))`;

export const connectionQueries = {
  // $1 agency, $2 the profiles. Locks them in a fixed order, so two people asking each other cannot deadlock.
  lockProfiles: `SELECT id, status, service_mode, owner_account_id, assigned_agent_id
   FROM matrimony.member_profiles
  WHERE agency_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,

  // The same, without locking: for reading who the two sides are before taking the locks.
  readProfiles: `SELECT id, status, service_mode, owner_account_id, assigned_agent_id
   FROM matrimony.member_profiles WHERE agency_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,

  // $1 agency, $2 client, $3 candidate. In the client's released window and still published.
  released: `SELECT 1 FROM matrimony.client_candidates c
   JOIN matrimony.member_profiles m ON m.agency_id = c.agency_id AND m.id = c.candidate_profile_id
  WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.candidate_profile_id = $3
    AND c.state = 'released' AND m.status = 'active'`,

  pair: `SELECT ${CONNECTION} FROM matrimony.interests WHERE ${BETWEEN}`,
  byId: `SELECT ${CONNECTION} FROM matrimony.interests WHERE agency_id = $1 AND id = $2`,

  // $1 agency, $2 from, $3 to, $4 who.
  insert: `INSERT INTO matrimony.interests (agency_id, sender_profile_id, recipient_profile_id, initiated_by_account_id)
 VALUES ($1, $2, $3, $4) RETURNING id`,

  // A withdrawn request asked again, by either side. $1 agency, $2 interest, $3 from, $4 to, $5 who.
  repend: `UPDATE matrimony.interests
   SET sender_profile_id = $3, recipient_profile_id = $4, status = 'pending', initiated_by_account_id = $5,
       responded_by_account_id = NULL, responded_at = NULL, sender_contact_consent_at = NULL,
       recipient_contact_consent_at = NULL, created_at = now(), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'withdrawn' RETURNING id`,

  // $1 agency, $2 interest, $3 accepted or declined, $4 who. Only a request still waiting can be answered.
  respond: `UPDATE matrimony.interests
   SET status = $3, responded_by_account_id = $4, responded_at = now(), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,

  // $1 agency, $2 interest, $3 the profile that asked.
  withdraw: `UPDATE matrimony.interests SET status = 'withdrawn', updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'pending' AND sender_profile_id = $3 RETURNING id`,

  shareFrom: `UPDATE matrimony.interests SET sender_contact_consent_at = COALESCE(sender_contact_consent_at, now()), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'accepted' AND sender_profile_id = $3 RETURNING id`,
  shareTo: `UPDATE matrimony.interests SET recipient_contact_consent_at = COALESCE(recipient_contact_consent_at, now()), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'accepted' AND recipient_profile_id = $3 RETURNING id`,

  // $1 agency, $2 recipient, $3 event key (unique for the recipient), $4 template, $5 payload.
  notify: `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
 VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (agency_id, recipient_account_id, event_key) DO NOTHING`,

  // $1 agency, $2 recipient, $3 cursor time, $4 cursor id, $5 limit, $6 whether the recipient may see names.
  notifications: `SELECT n.id, n.template_key, n.payload, n.created_at, ${POSITION('n.created_at')} AS position,
       m.id AS about_profile_id, m.member_code, CASE WHEN $6::boolean THEN m.full_name END AS full_name
  FROM matrimony.notifications n
  JOIN matrimony.member_profiles m ON m.agency_id = n.agency_id AND m.id = (n.payload->>'aboutProfileId')::uuid
 WHERE n.agency_id = $1 AND n.recipient_account_id = $2
   AND n.template_key LIKE 'interest.%'
   AND ($3::timestamptz IS NULL OR (n.created_at, n.id) < ($3::timestamptz, $4::uuid))
 ORDER BY n.created_at DESC, n.id DESC
 LIMIT $5`,

  /**
   * $1 agency, $2 the viewer's profile, $3 the box, $4 cursor time, $5 cursor id, $6 limit. The
   * other person with only the fields the viewer may see. A profile that is no longer published is left out.
   */
  list: (
    visible: readonly VisibleField[],
  ) => `SELECT x.id AS connection_id, x.status AS connection_status,
       (x.sender_profile_id = $2) AS connection_sent,
       (x.sender_contact_consent_at IS NOT NULL) AS from_shared,
       (x.recipient_contact_consent_at IS NOT NULL) AS to_shared, x.created_at, x.responded_at,
       ${POSITION('x.updated_at')} AS position, m.id, m.member_code${selectionFor(visible)}
  FROM matrimony.interests x
  JOIN matrimony.member_profiles m ON m.agency_id = x.agency_id
   AND m.id = CASE WHEN x.sender_profile_id = $2 THEN x.recipient_profile_id ELSE x.sender_profile_id END
 WHERE x.agency_id = $1 AND (x.sender_profile_id = $2 OR x.recipient_profile_id = $2) AND m.status = 'active'
   AND (($3 = 'received' AND x.status = 'pending' AND x.recipient_profile_id = $2)
     OR ($3 = 'sent' AND x.status = 'pending' AND x.sender_profile_id = $2)
     OR ($3 = 'connected' AND x.status = 'accepted'))
   AND ($4::timestamptz IS NULL OR (x.updated_at, x.id) < ($4::timestamptz, $5::uuid))
 ORDER BY x.updated_at DESC, x.id DESC
 LIMIT $6`,

  // $1 agency, $2 the client's profile. Every connection of this client, for the staff who look after them.
  staffList: `SELECT x.id AS connection_id, x.status, (x.sender_profile_id = $2) AS sent,
       x.created_at, x.responded_at,
       (x.sender_contact_consent_at IS NOT NULL) AS from_shared_contact,
       (x.recipient_contact_consent_at IS NOT NULL) AS to_shared_contact,
       m.id, m.member_code, m.full_name, to_char(m.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
       m.profession_code, m.current_district_code, m.service_mode
  FROM matrimony.interests x
  JOIN matrimony.member_profiles m ON m.agency_id = x.agency_id
   AND m.id = CASE WHEN x.sender_profile_id = $2 THEN x.recipient_profile_id ELSE x.sender_profile_id END
 WHERE x.agency_id = $1 AND (x.sender_profile_id = $2 OR x.recipient_profile_id = $2)
 ORDER BY x.updated_at DESC, x.id DESC
 LIMIT 100`,
};
