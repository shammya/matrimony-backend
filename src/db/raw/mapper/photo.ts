import type { PhotoFile, PhotoRecord, PhotoState } from '../../../bo/photo.js';
import { photoRow } from '../../entity/photo.js';

/** Approved once published; a staged photo is waiting, unless its review was rejected. */
function stateOf(status: 'staged' | 'published', review: string | null): PhotoState {
  if (status === 'published') return 'approved';
  return review === 'rejected' ? 'rejected' : 'waiting';
}

export function mapPhoto(row: unknown): PhotoRecord {
  const photo = photoRow.parse(row);
  return {
    id: photo.id,
    state: stateOf(photo.status, photo.review_status),
    isPrimary: photo.is_primary,
    createdAt: photo.created_at.toISOString(),
    reviewerNotes: photo.review_status === 'rejected' ? photo.reviewer_notes : null,
  };
}

/** What the workflow needs: where the files are and whether the photo is published. */
export function mapPhotoFile(row: unknown): PhotoFile {
  const photo = photoRow.parse(row);
  return {
    id: photo.id,
    storageKey: photo.storage_key,
    status: photo.status,
    isPrimary: photo.is_primary,
  };
}
