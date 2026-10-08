const invitationColumns = `i.id, i.email, i.display_name, i.role, i.locale, a.display_name AS invited_by_name,
 i.created_at, i.expires_at, i.expires_at <= now() AS expired`;
const invitationFrom = `FROM matrimony.staff_invitations i
 JOIN matrimony.accounts a ON a.agency_id = i.agency_id AND a.id = i.invited_by`;

export const staffInvitationQueries = {
  // Inviting an address that already has an open invitation replaces it: a new link and expiry,
  // the old link stops working. $1 agency, $2 email, $3 name, $4 role, $5 locale, $6 inviter,
  // $7 hash of the link's secret, $8 days it works.
  upsertOpen: `INSERT INTO matrimony.staff_invitations
 (agency_id, email, display_name, role, locale, invited_by, token_hash, expires_at)
 VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, now() + make_interval(days => $8::int))
 ON CONFLICT (agency_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL
 DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role,
   locale = EXCLUDED.locale, invited_by = EXCLUDED.invited_by, token_hash = EXCLUDED.token_hash,
   expires_at = EXCLUDED.expires_at, created_at = now()
 RETURNING id`,

  openList: `SELECT ${invitationColumns} ${invitationFrom}
 WHERE i.agency_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
 ORDER BY i.created_at DESC`,

  openById: `SELECT ${invitationColumns} ${invitationFrom}
 WHERE i.agency_id = $1 AND i.id = $2::uuid AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,

  // The invitation a link opens, only while it can still be accepted. Locked when it is about to
  // be accepted, so two requests with the same link cannot both create an account.
  byLink: `SELECT id, email, display_name, role, locale FROM matrimony.staff_invitations
 WHERE agency_id = $1 AND token_hash = $2 AND accepted_at IS NULL AND revoked_at IS NULL
   AND expires_at > now()`,

  // $1 agency, $2 invitation, $3 the account it created.
  markAccepted: `UPDATE matrimony.staff_invitations SET accepted_at = now(), accepted_account_id = $3::uuid
 WHERE agency_id = $1 AND id = $2::uuid AND accepted_at IS NULL AND revoked_at IS NULL`,

  revoke: `UPDATE matrimony.staff_invitations SET revoked_at = now()
 WHERE agency_id = $1 AND id = $2::uuid AND accepted_at IS NULL AND revoked_at IS NULL`,

  // The role is the one the admin chose, read from the invitation row the link opened, never from
  // the request of the person accepting. The address was proven by the link reaching it.
  // $1 agency, $2 id, $3 name, $4 email, $5 role, $6 locale.
  insertStaffAccount: `INSERT INTO matrimony.accounts
 (agency_id, id, role, display_name, email, email_verified_at, auth_issuer, auth_subject, status, locale)
 VALUES ($1, $2::uuid, $5, $3, $4, now(), 'local', ($2::uuid)::text, 'active', $6)
 ON CONFLICT DO NOTHING RETURNING id, agency_id, role, display_name`,
};
