export const credentialQueries = {
  // $1 agency, $2 email (already lower-case). Any status, so the caller decides what each means.
  byEmail: `SELECT a.id, a.agency_id, a.role, a.display_name, a.email, a.status, a.locale, c.password_hash
 FROM matrimony.accounts a
 LEFT JOIN matrimony.account_credentials c ON c.agency_id = a.agency_id AND c.account_id = a.id
 WHERE a.agency_id = $1 AND a.email = $2`,
  byId: `SELECT a.id, a.agency_id, a.role, a.display_name, a.email, a.status, a.locale, c.password_hash
 FROM matrimony.accounts a
 LEFT JOIN matrimony.account_credentials c ON c.agency_id = a.agency_id AND c.account_id = a.id
 WHERE a.agency_id = $1 AND a.id = $2`,
  // A reset sets the password whether or not the account had one. $1 agency, $2 account, $3 hash.
  setPassword: `INSERT INTO matrimony.account_credentials(agency_id, account_id, password_hash)
 VALUES ($1, $2, $3)
 ON CONFLICT (agency_id, account_id)
 DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`,
  // Upgrading an older hash after a correct sign-in. It only applies if the stored hash is still
  // the one that was checked, so it can never overwrite a password changed in the meantime.
  // $1 agency, $2 account, $3 new hash, $4 hash that was checked.
  rehash: `UPDATE matrimony.account_credentials SET password_hash = $3
 WHERE agency_id = $1 AND account_id = $2 AND password_hash = $4`,
};
