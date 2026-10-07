export const identityQueries = {
  tenant:
    "SELECT id, hostname, name, default_locale, public_config FROM matrimony.agencies WHERE id = $1 AND status = 'active'",
  // Looked up by the account id the access token names. The role is always read here, from the
  // database, and never taken from the token.
  account:
    "SELECT id, agency_id, role, display_name FROM matrimony.accounts WHERE agency_id = $1 AND id = $2 AND status = 'active'",
};
