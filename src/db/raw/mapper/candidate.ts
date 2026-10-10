import type { CandidateItem } from '../../../bo/candidate.js';
import { ageOn } from '../../../bo/profile.js';
import { candidateRow } from '../../entity/candidate.js';

export function mapCandidate(value: unknown, today: Date): CandidateItem {
  const row = candidateRow.parse(value);
  return {
    candidateId: row.candidate_profile_id,
    memberCode: row.member_code,
    fullName: row.full_name,
    age: row.date_of_birth ? ageOn(row.date_of_birth, today) : null,
    professionCode: row.profession_code,
    occupationCode: row.occupation_code,
    currentDistrictCode: row.current_district_code,
    religionCode: row.religion_code,
    maritalStatus: row.marital_status,
    profileStatus: row.profile_status,
    state: row.state,
    met: row.met_count,
    unmet: row.unmet_count,
    unknown: row.unknown_count,
    forward: row.criteria.forward,
    reverse: row.criteria.reverse,
    proposedAt: row.proposed_at.toISOString(),
  };
}
