import { z } from 'zod';
import { CANDIDATE_STATES } from '../../bo/candidate.js';
import { CRITERIA } from '../../bo/matching.js';

const result = z.object({
  key: z.enum(CRITERIA),
  outcome: z.enum(['met', 'unmet', 'unknown']),
});

/** A proposal joined with the few fields of the candidate that staff see in the list. */
export const candidateRow = z.object({
  candidate_profile_id: z.uuid(),
  state: z.enum(CANDIDATE_STATES),
  met_count: z.number().int(),
  unmet_count: z.number().int(),
  unknown_count: z.number().int(),
  criteria: z.object({ forward: z.array(result), reverse: z.array(result) }),
  proposed_at: z.date(),
  member_code: z.string(),
  full_name: z.string(),
  date_of_birth: z.string().nullable(),
  profession_code: z.string().nullable(),
  occupation_code: z.string().nullable(),
  current_district_code: z.string().nullable(),
  religion_code: z.string().nullable(),
  marital_status: z.string().nullable(),
  profile_status: z.string(),
});
