/**
 * A member's photos. A photo is uploaded, then reviewed; only an approved photo is ever shown
 * to anyone but its owner. These limits are development defaults to confirm with the client.
 */
export const MAX_PHOTOS = 5;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** What a member may upload. Every upload is converted to WebP before it is stored. */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** A photo smaller than this on its shortest side is too small to recognise a face. */
export const MIN_SIDE_PX = 200;

export const PHOTO_VARIANTS = {
  /** Shown on a profile page. */
  full: { maxSide: 1600, quality: 82 },
  /** Shown in lists and on cards. */
  thumb: { maxSide: 400, quality: 75 },
} as const;
export type PhotoVariant = keyof typeof PHOTO_VARIANTS;

/** What the member sees: waiting for a reviewer, approved (shown to others) or rejected. */
export type PhotoState = 'waiting' | 'approved' | 'rejected';

export interface PhotoRecord {
  id: string;
  state: PhotoState;
  isPrimary: boolean;
  createdAt: string;
  /** The reviewer's note when the photo was rejected. */
  reviewerNotes: string | null;
}

export interface PhotoList {
  photos: PhotoRecord[];
  limit: number;
}

/** What the workflow needs to know about a stored photo. Never sent to the client. */
export interface PhotoFile {
  id: string;
  storageKey: string;
  status: 'staged' | 'published';
  isPrimary: boolean;
}

/** A place held for an upload: the ids exist before the file is stored. */
export interface PhotoReservation {
  profileId: string;
  photoId: string;
  /** Where the photo's files live, without the variant suffix. Always begins with agency/profile. */
  storageKey: string;
}

/** The file for one size of a photo. */
export const variantKey = (storageKey: string, variant: PhotoVariant) =>
  `${storageKey}.${variant}.webp`;
