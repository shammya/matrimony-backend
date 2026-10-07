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

// Sign-in with an external provider. The account is found by the provider's stable subject.
export const identityLinkQueries = {
  // $1 agency, $2 provider, $3 subject. Any status, so a disabled account is told apart from none.
  accountByIdentity: `SELECT a.id, a.agency_id, a.role, a.display_name, a.status
 FROM matrimony.account_identities i
 JOIN matrimony.accounts a ON a.agency_id = i.agency_id AND a.id = i.account_id
 WHERE i.agency_id = $1 AND i.provider = $2 AND i.provider_subject = $3`,
  // $1 agency, $2 account, $3 provider, $4 subject, $5 email. Nothing is added when the subject, or
  // this provider for this account, is already linked.
  insertIdentity: `INSERT INTO matrimony.account_identities
 (agency_id, account_id, provider, provider_subject, email)
 VALUES ($1, $2, $3, $4, $5)
 ON CONFLICT DO NOTHING`,
};
