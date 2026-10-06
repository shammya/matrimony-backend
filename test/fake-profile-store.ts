import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '../src/bo/event.js';
import { profileInputSchema, type ProfileData } from '../src/bo/profile.js';
import type { ProfileRecord, ReviewKind, ReviewRecord } from '../src/bo/profile-state.js';
import type { ProfileUnit } from '../src/db/service/profile-db-service.js';
import { agency } from './fixtures.js';

/** An in-memory stand-in for one transaction's worth of profile storage. */
/** The content of a complete profile, for tests that need a profile to already exist. */
function completeData(): ProfileData {
  const parsed = profileInputSchema(new Date(Date.UTC(2026, 9, 6))).parse({
    profile: {
      fullName: 'Rahim Uddin',
      dateOfBirth: '1996-05-12',
      gender: 'male',
      maritalStatus: 'never_married',
      heightCm: 172,
      religionCode: 'islam',
      currentDistrictCode: 'dhaka',
      highestDegreeCode: 'bachelors',
      occupationCode: 'salaried',
    },
    contact: { phone: '+8801712345678' },
  });
  return { profile: parsed.profile, contact: parsed.contact, preferences: parsed.preferences };
}

export class FakeStore {
  profiles = new Map<string, ProfileRecord & { agencyId: string }>();
  reviews: (ReviewRecord & { profileId: string; submittedBy?: string })[] = [];
  events: WorkflowEvent[] = [];
  /** Make the next create() lose a race with another request for the same member. */
  raceOnNextCreate = false;
  /** Member codes that are already taken. */
  takenCodes = new Set<string>();
  createCalls = 0;
  createdBy: string | null = null;

  db = {
    inTransaction: <T>(_agencyId: string, work: (unit: ProfileUnit) => Promise<T>) =>
      work(this.unit()),
    read: (agencyId: string, ownerId: string) =>
      this.unit()
        .findByOwner(agencyId, ownerId, false)
        .then(async (profile) => ({
          profile,
          pendingReview: profile ? await this.unit().pendingReview(agencyId, profile.id) : null,
          lastDecision: profile ? await this.unit().lastDecision(agencyId, profile.id) : null,
        })),
  };

  private bump(profile: { version: number; updatedAt: string }) {
    profile.version += 1;
    profile.updatedAt = new Date().toISOString();
  }

  /** A self-service member's profile that an agent looks after. Returns its id. */
  addAndGet(ownerId: string, assignedAgentId: string | null, data?: ProfileData) {
    const id = this.insert(
      agency,
      ownerId,
      `M${Math.floor(Math.random() * 1e7)}`.padEnd(8, '0'),
      data ?? completeData(),
      'self_service',
      assignedAgentId,
    );
    return id;
  }

  /** Hands out a profile to an agent, as an admin would. */
  assign(profileId: string, agentId: string | null) {
    this.profiles.get(profileId)!.assignedAgentId = agentId;
  }

  private find(agencyId: string, ownerId: string) {
    return [...this.profiles.values()].find(
      (p) => p.agencyId === agencyId && p.ownerId === ownerId,
    );
  }

  unit(): ProfileUnit {
    return {
      findByOwner: async (agencyId, ownerId) => {
        const found = this.find(agencyId, ownerId);
        return found ? structuredClone(found) : null;
      },
      findById: async (agencyId, profileId) => {
        const found = this.profiles.get(profileId);
        return found && found.agencyId === agencyId ? structuredClone(found) : null;
      },
      createClient: async (agencyId, createdBy, assignedAgentId, memberCode, data) => {
        this.createCalls += 1;
        if (this.takenCodes.has(memberCode)) return null;
        this.createdBy = createdBy;
        return this.insert(agencyId, null, memberCode, data, 'assisted', assignedAgentId);
      },
      create: async (agencyId, ownerId, memberCode, data) => {
        this.createCalls += 1;
        if (this.raceOnNextCreate) {
          this.raceOnNextCreate = false;
          this.insert(agencyId, ownerId, `M${randomUUID().slice(0, 7)}`, data);
          return null;
        }
        if (this.find(agencyId, ownerId) || this.takenCodes.has(memberCode)) return null;
        return this.insert(agencyId, ownerId, memberCode, data);
      },
      saveContent: async (agencyId, profileId, status, data) => {
        const profile = this.byId(agencyId, profileId);
        profile.status = status;
        profile.data = structuredClone(data);
        this.bump(profile);
      },
      setStatus: async (agencyId, profileId, status) => {
        const profile = this.byId(agencyId, profileId);
        profile.status = status;
        this.bump(profile);
      },
      insertReview: async (_agencyId, profileId, by, kind: ReviewKind, baseVersion, changes) => {
        const review = {
          id: randomUUID(),
          profileId,
          submittedBy: by,
          kind,
          status: 'pending' as const,
          baseProfileVersion: baseVersion,
          proposedChanges: structuredClone(changes) as ReviewRecord['proposedChanges'],
          reviewerNotes: null,
          reviewedAt: null,
          createdAt: new Date().toISOString(),
        };
        this.reviews.push(review);
        return review;
      },
      pendingReview: async (_agencyId, profileId) =>
        this.reviews.find((r) => r.profileId === profileId && r.status === 'pending') ?? null,
      cancelReview: async (_agencyId, reviewId) => {
        const review = this.reviews.find((r) => r.id === reviewId && r.status === 'pending');
        if (review) review.status = 'cancelled';
      },
      lastDecision: async (_agencyId, profileId) =>
        [...this.reviews]
          .reverse()
          .find(
            (r) =>
              r.profileId === profileId && (r.status === 'approved' || r.status === 'rejected'),
          ) ?? null,
      appendEvent: async (event) => {
        this.events.push(event);
      },
    };
  }

  private insert(
    agencyId: string,
    ownerId: string | null,
    memberCode: string,
    data: ProfileData,
    serviceMode: 'self_service' | 'assisted' = 'self_service',
    assignedAgentId: string | null = null,
  ) {
    const id = randomUUID();
    this.profiles.set(id, {
      agencyId,
      ownerId,
      id,
      memberCode,
      serviceMode,
      assignedAgentId,
      status: 'draft',
      version: 1,
      currentDivisionCode: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: structuredClone(data),
    });
    return id;
  }

  private byId(agencyId: string, id: string) {
    const profile = this.profiles.get(id);
    assert.ok(profile && profile.agencyId === agencyId, 'profile belongs to the agency');
    return profile;
  }

  /** Play the reviewer, which is not built yet: approve or reject what is waiting. */
  decide(ownerId: string, outcome: 'approved' | 'rejected', notes: string | null = null) {
    const profile = this.find(agency, ownerId)!;
    const review = this.reviews.find((r) => r.profileId === profile.id && r.status === 'pending')!;
    review.status = outcome;
    review.reviewerNotes = notes;
    review.reviewedAt = new Date().toISOString();
    if (review.kind === 'initial_submission') {
      profile.status = outcome === 'approved' ? 'active' : 'rejected';
      this.bump(profile);
    }
  }

  setStatus(ownerId: string, status: ProfileRecord['status']) {
    this.find(agency, ownerId)!.status = status;
  }
}
