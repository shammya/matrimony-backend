// A photo with the outcome of its newest review: that is what the member sees (waiting,
// approved or rejected with a note). Removed photos are never listed.
const PHOTO_COLUMNS = `p.id, p.storage_key, p.status, p.is_primary, p.created_at,
 r.status AS review_status, r.reviewer_notes`;

const WITH_REVIEW = `FROM matrimony.profile_photos p
 LEFT JOIN LATERAL (
   SELECT status, reviewer_notes FROM matrimony.profile_reviews r
   WHERE r.agency_id = p.agency_id AND r.photo_id = p.id AND r.kind = 'photo_add'
   ORDER BY r.created_at DESC LIMIT 1
 ) r ON true`;

export const photoQueries = {
  // Locks the profile row so two uploads or deletions for one member run one after the other.
  lockProfile: `SELECT id, status FROM matrimony.member_profiles
 WHERE agency_id = $1 AND owner_account_id = $2 FOR UPDATE`,
  findProfile: `SELECT id, status FROM matrimony.member_profiles
 WHERE agency_id = $1 AND owner_account_id = $2`,

  list: `SELECT ${PHOTO_COLUMNS} ${WITH_REVIEW}
 WHERE p.agency_id = $1 AND p.profile_id = $2 AND p.status <> 'removed'
 ORDER BY p.sort_order, p.created_at`,
  find: `SELECT ${PHOTO_COLUMNS} ${WITH_REVIEW}
 WHERE p.agency_id = $1 AND p.profile_id = $2 AND p.id = $3 AND p.status <> 'removed'`,
  count: `SELECT count(*)::int AS n FROM matrimony.profile_photos
 WHERE agency_id = $1 AND profile_id = $2 AND status <> 'removed'`,

  // $1 agency, $2 photo id, $3 profile, $4 storage key, $5 size of the main file, $6 uploader.
  insert: `INSERT INTO matrimony.profile_photos
 (agency_id, id, profile_id, storage_key, mime_type, byte_size, uploaded_by_account_id, sort_order)
 VALUES ($1, $2, $3, $4, 'image/webp', $5, $6,
   (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM matrimony.profile_photos WHERE agency_id = $1 AND profile_id = $3))`,
  insertReview: `INSERT INTO matrimony.profile_reviews
 (agency_id, profile_id, submitted_by_account_id, kind, photo_id)
 VALUES ($1, $2, $3, 'photo_add', $4)`,

  // A removed photo keeps its row (the history stays), loses its place as the main photo and
  // cancels any review still waiting on it.
  markRemoved: `UPDATE matrimony.profile_photos SET status = 'removed', is_primary = false
 WHERE agency_id = $1 AND id = $2`,
  cancelReview: `UPDATE matrimony.profile_reviews SET status = 'cancelled', cancelled_at = now()
 WHERE agency_id = $1 AND photo_id = $2 AND status = 'pending'`,

  clearPrimary: `UPDATE matrimony.profile_photos SET is_primary = false
 WHERE agency_id = $1 AND profile_id = $2 AND is_primary`,
  setPrimary: `UPDATE matrimony.profile_photos SET is_primary = true
 WHERE agency_id = $1 AND id = $2 AND status = 'published'`,
  // When the main photo goes, the next approved one (in the member's order) takes its place.
  promoteNext: `UPDATE matrimony.profile_photos SET is_primary = true
 WHERE agency_id = $1 AND id = (
   SELECT id FROM matrimony.profile_photos
   WHERE agency_id = $1 AND profile_id = $2 AND status = 'published'
   ORDER BY sort_order, created_at LIMIT 1)`,
};
