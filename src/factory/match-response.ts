import type { MatchItem, MatchPage, ProfileDetail } from '../bo/matches.js';

/**
 * A member's matches as the API returns them. The item is rebuilt key by key from what the service
 * allowed, without its internal cursor position, so nothing extra can leak by accident.
 */
export const matchItemResponse = (m: MatchItem) => {
  const { position: _position, ...shown } = m;
  void _position;
  return Object.fromEntries(Object.entries(shown).filter(([, value]) => value !== undefined));
};

export const matchPageResponse = (page: MatchPage) => ({
  items: page.items.map(matchItemResponse),
  next: page.next,
  profileStatus: page.profileStatus,
  releasedTotal: page.releasedTotal,
  visibleFields: page.visibleFields,
});

/** The full view of one profile. The contact is only what the other person shared, never an address. */
export const profileDetailResponse = (detail: ProfileDetail) => ({
  profile: matchItemResponse(detail.profile),
  connection: detail.connection && {
    id: detail.connection.id,
    status: detail.connection.status,
    direction: detail.connection.direction,
    iSharedContact: detail.connection.iShared,
    theySharedContact: detail.connection.theyShared,
  },
  contact: detail.contact && {
    name: detail.contact.name,
    relationship: detail.contact.relationship,
    phone: detail.contact.phone,
    email: detail.contact.email,
  },
  visibleFields: detail.visibleFields,
});
