import { z } from 'zod';
import type { CriterionResult } from './matching.js';

/**
 * Candidate lists (slice 3.B, docs/features/candidate-generation.md): the profiles the system
 * proposes for a client, for staff to review. A client never receives any of this.
 */
const fail = (key: string) => ({ error: key });

/** The most proposals saved per run. Staff choose the client's window (for example 50) from them. */
export const MAX_PROPOSALS = 100;
/**
 * The most published profiles looked at in one run. An agency is far smaller than this today; a run
 * that reaches the bound is logged so the matching can be moved into SQL before it silently drops people.
 */
export const POOL_LIMIT = 5000;
export const MAX_LIST = 200;

export const CANDIDATE_STATES = ['proposed', 'lapsed', 'released', 'removed'] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export const candidateListQuerySchema = z
  .object({
    state: z.enum(CANDIDATE_STATES, fail('invalidOption')).default('proposed'),
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(MAX_LIST, fail('outOfRange'))
      .default(MAX_PROPOSALS),
  })
  .strict();
export type CandidateListQuery = z.output<typeof candidateListQuerySchema>;

/** One proposed profile with how it fits, in both directions. Staff only: no contact details. */
export interface CandidateItem {
  candidateId: string;
  memberCode: string;
  fullName: string;
  age: number | null;
  professionCode: string | null;
  occupationCode: string | null;
  currentDistrictCode: string | null;
  religionCode: string | null;
  maritalStatus: string | null;
  /** The candidate profile's own status now (a paused profile may still sit in an old proposal). */
  profileStatus: string;
  state: CandidateState;
  met: number;
  unmet: number;
  unknown: number;
  forward: CriterionResult[];
  reverse: CriterionResult[];
  proposedAt: string;
}

export interface CandidateList {
  items: CandidateItem[];
}

export interface GenerationResult extends CandidateList {
  /** Published profiles that were measured. */
  considered: number;
  /** Proposals saved by this run. */
  proposed: number;
}

/** What a profile row needs to be scored: kept apart from the API's shapes. */
export interface ProposalRow {
  candidateId: string;
  met: number;
  unmet: number;
  unknown: number;
  forward: CriterionResult[];
  reverse: CriterionResult[];
}
