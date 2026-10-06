import { randomUUID } from 'node:crypto';
import { canReview } from '../src/bo/access.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { ProfileData, ProposedChanges } from '../src/bo/profile.js';
import { profileInputSchema } from '../src/bo/profile.js';
import type { ProfileRecord } from '../src/bo/profile-state.js';
import type { QueueItem, QueueKind, ReviewStatus } from '../src/bo/review.js';
import type { ReviewRecordDetail } from '../src/db/raw/mapper/review.js';
import type { QueuePhoto } from '../src/db/raw/repository/review-repository.js';
import type { ReviewUnit } from '../src/db/service/review-db-service.js';
import { agency } from './fixtures.js';

export const complete = {
  fullName: 'Rahim Uddin',
  dateOfBirth: '1996-05-12',
  gender: 'male',
  maritalStatus: 'never_married',
  heightCm: 172,
  religionCode: 'islam',
  currentDistrictCode: 'dhaka',
  highestDegreeCode: 'bachelors',
  occupationCode: 'salaried',
};

const schema = profileInputSchema(new Date(Date.UTC(2026, 9, 6)));

/** The content of a profile, built through the real validation so it has every field. */
export function contentOf(
  profile: Record<string, unknown> = {},
  contact: Record<string, unknown> = { phone: '+8801712345678' },
): ProfileData {
  const parsed = schema.parse({ profile: { ...complete, ...profile }, contact });
  return { profile: parsed.profile, contact: parsed.contact, preferences: parsed.preferences };
}

interface StoredReview {
  id: string;
  agencyId: string;
  profileId: string;
  kind: QueueKind;
  status: ReviewStatus;
  createdAt: string;
  photoId: string | null;
  submittedBy: { id: string; displayName: string };
  baseProfileVersion: number | null;
  proposed: ProposedChanges | ProfileData | null;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  decidedBy: { id: string; displayName: string } | null;
}

let clock = Date.UTC(2026, 9, 1);
const tick = () => new Date((clock += 60_000)).toISOString();

/** An in-memory stand-in for the approval queue's storage, one transaction at a time. */
export class FakeReviewStore {
  profiles = new Map<string, ProfileRecord & { agencyId: string }>();
  reviews: StoredReview[] = [];
  photos = new Map<string, QueuePhoto & { agencyId: string; isPrimary: boolean }>();
  events: WorkflowEvent[] = [];
  /** Make the next decision lose a race with another reviewer. */
  loseNextDecision = false;
  names = new Map<string, string>();

  db = {
    inTransaction: <T>(_agencyId: string, work: (unit: ReviewUnit) => Promise<T>) =>
      work(this.unit()),
  };

  person(name: string) {
    const id = randomUUID();
    this.names.set(id, name);
    return { id, displayName: name };
  }

  /** A profile, by default a member's, active and complete. */
  addProfile(overrides: Partial<ProfileRecord> = {}) {
    const id = randomUUID();
    const profile: ProfileRecord & { agencyId: string } = {
      agencyId: agency,
      id,
      memberCode: `M${Math.floor(Math.random() * 1e7)}`.padEnd(8, '0'),
      status: 'active',
      serviceMode: 'self_service',
      ownerId: randomUUID(),
      assignedAgentId: null,
      version: 3,
      currentDivisionCode: null,
      createdAt: tick(),
      updatedAt: tick(),
      data: contentOf(),
      ...overrides,
    };
    this.profiles.set(id, profile);
    return profile;
  }

  addReview(
    profileId: string,
    submitter: { id: string; displayName: string },
    overrides: Partial<StoredReview> = {},
  ) {
    const profile = this.profiles.get(profileId)!;
    const review: StoredReview = {
      id: randomUUID(),
      agencyId: agency,
      profileId,
      kind: 'initial_submission',
      status: 'pending',
      createdAt: tick(),
      photoId: null,
      submittedBy: submitter,
      baseProfileVersion: profile.version,
      proposed: profile.data,
      reviewerNotes: null,
      reviewedAt: null,
      decidedBy: null,
      ...overrides,
    };
    this.reviews.push(review);
    return review;
  }

  addPhoto(profileId: string, status: QueuePhoto['status'] = 'staged') {
    const id = randomUUID();
    this.photos.set(id, {
      agencyId: agency,
      id,
      profileId,
      storageKey: `${agency}/${profileId}/${id}`,
      status,
      isPrimary: false,
    });
    return id;
  }

  private item(r: StoredReview): ReviewRecordDetail {
    const profile = this.profiles.get(r.profileId)!;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      position: r.createdAt,
      photoId: r.photoId,
      profile: {
        id: profile.id,
        memberCode: profile.memberCode,
        fullName: String(profile.data.profile?.fullName ?? ''),
        serviceMode: profile.serviceMode,
        assignedAgentId: profile.assignedAgentId,
      },
      submittedBy: r.submittedBy,
      baseProfileVersion: r.baseProfileVersion,
      proposed: r.proposed,
      reviewerNotes: r.reviewerNotes,
      reviewedAt: r.reviewedAt,
      decidedBy: r.decidedBy,
    };
  }

  private visible(viewer: string | null) {
    return this.reviews.filter((r) => {
      const profile = this.profiles.get(r.profileId)!;
      return viewer === null || canReview({ accountId: viewer, role: 'agent' }, profile);
    });
  }

  unit(): ReviewUnit {
    return {
      list: async (_agencyId, query, viewer) => {
        const asc = query.status === 'pending';
        const rows = this.visible(viewer)
          .filter((r) => r.status === query.status && (!query.kind || r.kind === query.kind))
          .sort((a, b) => {
            const order = a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
            return asc ? order : -order;
          })
          .filter((r) => {
            if (!query.after) return true;
            const order =
              r.createdAt.localeCompare(query.after.createdAt) ||
              r.id.localeCompare(query.after.id);
            return asc ? order > 0 : order < 0;
          })
          .slice(0, query.limit + 1);
        return rows.map((r): QueueItem => this.item(r));
      },
      find: async (_agencyId, reviewId) => {
        const found = this.reviews.find((r) => r.id === reviewId);
        return found ? this.item(found) : null;
      },
      pendingCount: async (_agencyId, viewer) =>
        this.visible(viewer).filter((r) => r.status === 'pending').length,
      findProfile: async (_agencyId, profileId) => {
        const found = this.profiles.get(profileId);
        return found ? structuredClone(found) : null;
      },
      saveProfileContent: async (_agencyId, profileId, status, data) => {
        const profile = this.profiles.get(profileId)!;
        profile.status = status;
        profile.data = structuredClone(data);
        profile.version += 1;
      },
      setProfileStatus: async (_agencyId, profileId, status) => {
        const profile = this.profiles.get(profileId)!;
        profile.status = status;
        profile.version += 1;
      },
      findPhoto: async (_agencyId, photoId) => {
        const photo = this.photos.get(photoId);
        return photo ? { ...photo } : null;
      },
      publishPhoto: async (_agencyId, profileId, photoId) => {
        const photo = this.photos.get(photoId)!;
        photo.status = 'published';
        const hasMain = [...this.photos.values()].some(
          (p) => p.profileId === profileId && p.isPrimary,
        );
        if (!hasMain) photo.isPrimary = true;
      },
      decide: async (_agencyId, reviewId, outcome, reviewerId, note) => {
        if (this.loseNextDecision) {
          this.loseNextDecision = false;
          return false;
        }
        const review = this.reviews.find((r) => r.id === reviewId)!;
        if (review.status !== 'pending') return false;
        review.status = outcome;
        review.reviewerNotes = note;
        review.reviewedAt = tick();
        review.decidedBy = {
          id: reviewerId,
          displayName: this.names.get(reviewerId) ?? 'Reviewer',
        };
        return true;
      },
      appendEvent: async (event) => {
        this.events.push(event);
      },
    };
  }
}
