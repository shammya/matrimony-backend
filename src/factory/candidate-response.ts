import type { CandidateItem, CandidateList, GenerationResult } from '../bo/candidate.js';
import type { ReleaseOutcome, ReleaseSettings } from '../bo/release.js';

const item = (c: CandidateItem) => ({
  candidateId: c.candidateId,
  memberCode: c.memberCode,
  fullName: c.fullName,
  age: c.age,
  professionCode: c.professionCode,
  occupationCode: c.occupationCode,
  currentDistrictCode: c.currentDistrictCode,
  religionCode: c.religionCode,
  maritalStatus: c.maritalStatus,
  profileStatus: c.profileStatus,
  state: c.state,
  met: c.met,
  unmet: c.unmet,
  unknown: c.unknown,
  forward: c.forward.map((r) => ({ key: r.key, outcome: r.outcome })),
  reverse: c.reverse.map((r) => ({ key: r.key, outcome: r.outcome })),
  proposedAt: c.proposedAt,
});

/** A candidate list for staff. Fields are listed so nothing, such as a contact detail, leaks by accident. */
export const candidateListResponse = (list: CandidateList) => ({ items: list.items.map(item) });

export const generationResponse = (result: GenerationResult) => ({
  considered: result.considered,
  proposed: result.proposed,
  items: result.items.map(item),
});

export const settingsResponse = (settings: ReleaseSettings) => ({
  cap: settings.cap,
  visibleFields: settings.visibleFields,
  releasedCount: settings.releasedCount,
  isDefault: settings.isDefault,
});

export const outcomeResponse = (outcome: ReleaseOutcome) => ({
  done: outcome.done,
  skipped: outcome.skipped,
});
