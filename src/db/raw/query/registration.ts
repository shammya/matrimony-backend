export const registrationQueries = {
  // Any status, so "no account" can be told apart from "an account that cannot sign in".
  accountByEmail: `SELECT id, agency_id, role, display_name, status FROM matrimony.accounts
 WHERE agency_id = $1 AND email = $2`,

  // The role is fixed in the statement, not a parameter: registration can only ever make a member.
  // The email has been proven by the time this runs, so it is stored as verified. The account id is
  // chosen by the caller so the sign-in identity (issuer `local`, subject = id) is written in the
  // same statement.
  // $1 agency, $2 id, $3 name, $4 email, $5 locale.
  insertAccount: `INSERT INTO matrimony.accounts
 (agency_id, id, role, display_name, email, email_verified_at, auth_issuer, auth_subject, status, locale)
 VALUES ($1, $2::uuid, 'member', $3, $4, now(), 'local', ($2::uuid)::text, 'active', $5)
 ON CONFLICT DO NOTHING RETURNING id, agency_id, role, display_name`,

  insertCredential: `INSERT INTO matrimony.account_credentials(agency_id, account_id, password_hash)
 VALUES ($1, $2, $3)`,

  insertConsent: `INSERT INTO matrimony.consent_events
 (agency_id, account_id, purpose, document_version, action)
 VALUES ($1, $2, $3, $4, 'accepted')`,
};
