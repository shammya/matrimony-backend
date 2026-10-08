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

  // A member who registers with a phone number: no email, and the number was proven by a code just
  // now. Same fixed role and local sign-in identity as above. $1 agency, $2 id, $3 name, $4 phone,
  // $5 locale.
  insertPhoneAccount: `INSERT INTO matrimony.accounts
 (agency_id, id, role, display_name, phone_e164, phone_verified_at, auth_issuer, auth_subject, status, locale)
 VALUES ($1, $2::uuid, 'member', $3, $4, now(), 'local', ($2::uuid)::text, 'active', $5)
 ON CONFLICT DO NOTHING RETURNING id, agency_id, role, display_name`,

  // Only a number that was proven by a code signs anyone in. Any status, as for email.
  accountByPhone: `SELECT id, agency_id, role, display_name, status FROM matrimony.accounts
 WHERE agency_id = $1 AND phone_e164 = $2 AND phone_verified_at IS NOT NULL`,

  // $1 agency, $2 number, $3 the account asking. Another account that already uses the number.
  phoneTakenByOther: `SELECT 1 FROM matrimony.accounts
 WHERE agency_id = $1 AND phone_e164 = $2 AND id <> $3::uuid`,

  // Adds or changes the number of an active account, proven by a code just now.
  // $1 agency, $2 account, $3 number.
  setPhone: `UPDATE matrimony.accounts SET phone_e164 = $3, phone_verified_at = now()
 WHERE agency_id = $1 AND id = $2::uuid AND status = 'active'`,

  // Adds the proven email to an active account that has none. Never replaces an address.
  // $1 agency, $2 account, $3 email.
  setEmail: `UPDATE matrimony.accounts SET email = $3, email_verified_at = now()
 WHERE agency_id = $1 AND id = $2::uuid AND status = 'active' AND email IS NULL`,

  // What an account can sign in with, for its account settings. $1 agency, $2 account.
  signInMethods: `SELECT a.email, a.email_verified_at IS NOT NULL AS email_verified,
 a.phone_e164, a.phone_verified_at IS NOT NULL AS phone_verified,
 (c.account_id IS NOT NULL) AS has_password,
 EXISTS (SELECT 1 FROM matrimony.account_identities i
         WHERE i.agency_id = a.agency_id AND i.account_id = a.id AND i.provider = 'google') AS google
 FROM matrimony.accounts a
 LEFT JOIN matrimony.account_credentials c ON c.agency_id = a.agency_id AND c.account_id = a.id
 WHERE a.agency_id = $1 AND a.id = $2::uuid`,

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
