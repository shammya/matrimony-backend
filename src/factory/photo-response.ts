import type { PhotoList } from '../bo/photo.js';

/** The member's photos as the API returns them. Storage keys and files never appear here. */
export function photoListResponse(list: PhotoList) {
  return {
    photos: list.photos.map((photo) => ({
      id: photo.id,
      state: photo.state,
      isPrimary: photo.isPrimary,
      createdAt: photo.createdAt,
      reviewerNotes: photo.reviewerNotes,
    })),
    limit: list.limit,
  };
}
