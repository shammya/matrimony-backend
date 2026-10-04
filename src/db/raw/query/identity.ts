export const identityQueries = {
  tenant:
    "SELECT id, hostname, name, default_locale, public_config FROM matrimony.agencies WHERE id = $1 AND status = 'active'",
  account:
    "SELECT id, agency_id, role, display_name FROM matrimony.accounts WHERE agency_id = $1 AND auth_issuer = $2 AND auth_subject = $3 AND status = 'active'",
};
