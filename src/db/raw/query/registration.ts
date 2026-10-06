export const registrationQueries = {
  // Any status, so "no account" can be told apart from "an account that cannot log in".
  accountBySubject: `SELECT id, agency_id, role, display_name, status FROM matrimony.accounts
 WHERE agency_id = $1 AND auth_issuer = $2 AND auth_subject = $3`,
  accountByPhone: `SELECT id FROM matrimony.accounts WHERE agency_id = $1 AND phone_e164 = $2`,

  // The role is fixed in the statement, not a parameter: registration can only ever make a member.
  // $1 agency, $2 name, $3 phone, $4 issuer, $5 subject, $6 locale.
  insertAccount: `INSERT INTO matrimony.accounts
 (agency_id, role, display_name, phone_e164, phone_verified_at, auth_issuer, auth_subject, status, locale)
 VALUES ($1, 'member', $2, $3, now(), $4, $5, 'active', $6)
 ON CONFLICT DO NOTHING RETURNING id, agency_id, role, display_name`,

  insertConsent: `INSERT INTO matrimony.consent_events
 (agency_id, account_id, purpose, document_version, action)
 VALUES ($1, $2, $3, $4, 'accepted')`,
};
