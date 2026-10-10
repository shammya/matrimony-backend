import type { VisibleField } from '../../../bo/release.js';

/**
 * The columns a released profile may show, one per field staff can switch on. Only the ones a client
 * is allowed are ever selected, so a hidden value is never even read from the database. Every name
 * here is a fixed identifier written in code, never user input.
 */
const SELECTION: Record<VisibleField, string> = {
  fullName: 'm.full_name',
  age: `to_char(m.date_of_birth, 'YYYY-MM-DD') AS date_of_birth`,
  photo: `EXISTS (SELECT 1 FROM matrimony.profile_photos ph
     WHERE ph.agency_id = m.agency_id AND ph.profile_id = m.id AND ph.status = 'published') AS has_photo`,
  aboutMe: 'm.about_me',
  professionCode: 'm.profession_code',
  occupationCode: 'm.occupation_code',
  highestDegreeCode: 'm.highest_degree_code',
  heightCm: 'm.height_cm',
  maritalStatus: 'm.marital_status',
  religionCode: 'm.religion_code',
  currentDistrictCode: 'm.current_district_code',
  originDistrictCode: 'm.origin_district_code',
  monthlyIncomeBandCode: 'm.monthly_income_band_code',
  familyStatusCode: 'm.family_status_code',
  hobbies: 'm.hobbies',
};

/** The columns for the fields given, as a SQL fragment starting with a comma, or nothing. */
export const selectionFor = (visible: readonly VisibleField[]) =>
  visible.length > 0 ? `, ${visible.map((field) => SELECTION[field]).join(', ')}` : '';

const RELEASED = `FROM matrimony.client_candidates c
   JOIN matrimony.member_profiles m ON m.agency_id = c.agency_id AND m.id = c.candidate_profile_id
   LEFT JOIN matrimony.interests x ON x.agency_id = c.agency_id
     AND ((x.sender_profile_id = c.client_profile_id AND x.recipient_profile_id = c.candidate_profile_id)
       OR (x.sender_profile_id = c.candidate_profile_id AND x.recipient_profile_id = c.client_profile_id))
  WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.state = 'released' AND m.status = 'active'`;

/**
 * Who a client may look at: someone in their released window, or someone they have an accepted
 * connection with, or someone who asked to connect with them and is waiting for an answer. $1 agency,
 * $2 the client's profile, $3 the other profile. The other profile must be published.
 */
export const VIEWABLE = `m.agency_id = $1 AND m.id = $3 AND m.status = 'active' AND (
   EXISTS (SELECT 1 FROM matrimony.client_candidates c
            WHERE c.agency_id = m.agency_id AND c.client_profile_id = $2
              AND c.candidate_profile_id = m.id AND c.state = 'released')
   OR EXISTS (SELECT 1 FROM matrimony.interests x
            WHERE x.agency_id = m.agency_id
              AND ((x.sender_profile_id = $2 AND x.recipient_profile_id = m.id)
                OR (x.sender_profile_id = m.id AND x.recipient_profile_id = $2))
              AND (x.status = 'accepted' OR (x.status = 'pending' AND x.recipient_profile_id = $2))))`;

export const matchQueries = {
  // $1 agency, $2 owner account. The member's own profile.
  ownProfile: `SELECT id, status FROM matrimony.member_profiles WHERE agency_id = $1 AND owner_account_id = $2`,

  // $1 agency, $2 client profile.
  releasedTotal: `SELECT count(*)::int AS n FROM matrimony.client_candidates c
   JOIN matrimony.member_profiles m ON m.agency_id = c.agency_id AND m.id = c.candidate_profile_id
  WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.state = 'released' AND m.status = 'active'`,

  /**
   * $1 agency, $2 client, $3 member code, $4 age min, $5 age max, $6 religion, $7 marital status,
   * $8 profession, $9 district, $10 education levels at or above the minimum, $11 cursor time,
   * $12 cursor id, $13 limit, $14 height min, $15 height max, $16 income bands within the range,
   * $17 family statuses at or above the minimum, $18 district of origin.
   */
  page: (visible: readonly VisibleField[]) => `SELECT c.candidate_profile_id AS id, m.member_code,
       to_char(c.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position,
       x.id AS connection_id, x.status AS connection_status,
       (x.sender_profile_id = c.client_profile_id) AS connection_sent,
       (x.sender_contact_consent_at IS NOT NULL) AS from_shared, (x.recipient_contact_consent_at IS NOT NULL) AS to_shared${selectionFor(visible)}
  ${RELEASED}
    AND ($3::text IS NULL OR m.member_code = $3::text)
    AND ($4::int IS NULL OR m.date_of_birth <= (CURRENT_DATE - make_interval(years => $4::int)))
    AND ($5::int IS NULL OR m.date_of_birth > (CURRENT_DATE - make_interval(years => $5::int + 1)))
    AND ($6::text IS NULL OR m.religion_code = $6::text)
    AND ($7::text IS NULL OR m.marital_status = $7::text)
    AND ($8::text IS NULL OR m.profession_code = $8::text)
    AND ($9::text IS NULL OR m.current_district_code = $9::text)
    AND ($10::text[] IS NULL OR m.highest_degree_code = ANY($10::text[]))
    AND ($14::int IS NULL OR m.height_cm >= $14::int)
    AND ($15::int IS NULL OR m.height_cm <= $15::int)
    AND ($16::text[] IS NULL OR m.monthly_income_band_code = ANY($16::text[]))
    AND ($17::text[] IS NULL OR m.family_status_code = ANY($17::text[]))
    AND ($18::text IS NULL OR m.origin_district_code = $18::text)
    AND ($11::timestamptz IS NULL OR (c.decided_at, c.candidate_profile_id) < ($11::timestamptz, $12::uuid))
  ORDER BY c.decided_at DESC, c.candidate_profile_id DESC
  LIMIT $13`,

  /** $1 agency, $2 client, $3 candidate. The full view of one profile the client may look at. */
  person: (visible: readonly VisibleField[]) => `SELECT m.id, m.member_code,
       x.id AS connection_id, x.status AS connection_status,
       (x.sender_profile_id = $2) AS connection_sent,
       (x.sender_contact_consent_at IS NOT NULL) AS from_shared, (x.recipient_contact_consent_at IS NOT NULL) AS to_shared${selectionFor(visible)}
  FROM matrimony.member_profiles m
  LEFT JOIN matrimony.interests x ON x.agency_id = m.agency_id
     AND ((x.sender_profile_id = $2 AND x.recipient_profile_id = m.id)
       OR (x.sender_profile_id = m.id AND x.recipient_profile_id = $2))
 WHERE ${VIEWABLE}`,

  // $1 agency, $2 client profile, $3 candidate. Whether the client may look at this profile at all.
  viewable: `SELECT m.id FROM matrimony.member_profiles m WHERE ${VIEWABLE}`,

  // $1 agency, $2 the client, $3 the other person. The contact details the other person chose to share
  // with the client, only while the connection is accepted. Never the permanent address.
  sharedContact: `SELECT pc.contact_name, pc.contact_relationship, pc.phone_e164, pc.email
   FROM matrimony.interests x
   JOIN matrimony.profile_contacts pc ON pc.agency_id = x.agency_id AND pc.profile_id = $3
  WHERE x.agency_id = $1 AND x.status = 'accepted'
    AND ((x.sender_profile_id = $3 AND x.recipient_profile_id = $2 AND x.sender_contact_consent_at IS NOT NULL)
      OR (x.sender_profile_id = $2 AND x.recipient_profile_id = $3 AND x.recipient_contact_consent_at IS NOT NULL))`,

  // $1 agency, $2 profile. Its main published photo, or the first published one.
  photo: `SELECT storage_key FROM matrimony.profile_photos
 WHERE agency_id = $1 AND profile_id = $2 AND status = 'published'
 ORDER BY is_primary DESC, sort_order, created_at LIMIT 1`,
};
