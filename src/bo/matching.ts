import { EDUCATION_LEVELS, FAMILY_STATUSES, INCOME_BANDS } from './dictionaries.js';
import { ageOn, type ProfileContent, type ProfilePreferences } from './profile.js';

/**
 * How well two published profiles fit each other's partner preferences (slice 3.B,
 * docs/features/candidate-generation.md). Pure rules: no database, no clock except the date given.
 *
 * Each preference a person stated is one criterion. An empty preference means "does not matter" and
 * is not a criterion. For the other profile a criterion is:
 *   met      the answer fits the preference
 *   unmet    the answer does not fit
 *   unknown  the profile has not answered, which neither counts for nor against it
 *
 * Complexion is deliberately never a criterion: it is shown to staff, who apply it by hand.
 */
export type Outcome = 'met' | 'unmet' | 'unknown';

export const CRITERIA = [
  'age',
  'height',
  'religion',
  'sect',
  'maritalStatus',
  'education',
  'occupation',
  'profession',
  'district',
  'income',
  'familyStatus',
  'religiousPractice',
  'diet',
  'smoking',
  'children',
  'relocation',
] as const;
export type CriterionKey = (typeof CRITERIA)[number];

export interface CriterionResult {
  key: CriterionKey;
  outcome: Outcome;
}

export interface Counts {
  met: number;
  unmet: number;
  unknown: number;
}

/** The fit of a candidate to a client in both directions. */
export interface PairFit extends Counts {
  /** The candidate measured against the client's preferences. */
  forward: CriterionResult[];
  /** The client measured against the candidate's own preferences. */
  reverse: CriterionResult[];
}

const inList = (wanted: readonly string[], value: string | null): Outcome | null =>
  wanted.length === 0
    ? null
    : value === null
      ? 'unknown'
      : wanted.includes(value)
        ? 'met'
        : 'unmet';

const between = (min: number | null, max: number | null, value: number | null): Outcome | null =>
  min === null && max === null
    ? null
    : value === null
      ? 'unknown'
      : (min === null || value >= min) && (max === null || value <= max)
        ? 'met'
        : 'unmet';

/** A range over an ordered option list (lowest to highest). A value outside the list is unknown. */
function betweenOrdered(
  order: readonly string[],
  min: string | null,
  max: string | null,
  value: string | null,
): Outcome | null {
  if (min === null && max === null) return null;
  const at = value === null ? -1 : order.indexOf(value);
  if (at < 0) return 'unknown';
  const low = min === null ? -Infinity : order.indexOf(min);
  const high = max === null ? Infinity : order.indexOf(max);
  return at >= low && at <= high ? 'met' : 'unmet';
}

/** Measures one person's answers against another person's stated preferences. */
export function fitOf(
  preferences: ProfilePreferences,
  subject: ProfileContent,
  today: Date,
): CriterionResult[] {
  const age = subject.dateOfBirth ? ageOn(subject.dateOfBirth, today) : null;
  const checks: [CriterionKey, Outcome | null][] = [
    ['age', between(preferences.ageMin, preferences.ageMax, age)],
    ['height', between(preferences.heightMinCm, preferences.heightMaxCm, subject.heightCm)],
    ['religion', inList(preferences.religionCodes, subject.religionCode)],
    ['sect', inList(preferences.sectCodes, subject.sectCode)],
    ['maritalStatus', inList(preferences.maritalStatusCodes, subject.maritalStatus)],
    [
      'education',
      betweenOrdered(
        EDUCATION_LEVELS,
        preferences.educationMinCode,
        null,
        subject.highestDegreeCode,
      ),
    ],
    ['occupation', inList(preferences.occupationCodes, subject.occupationCode)],
    ['profession', inList(preferences.professionCodes, subject.professionCode)],
    ['district', inList(preferences.districtCodes, subject.currentDistrictCode)],
    [
      'income',
      betweenOrdered(
        INCOME_BANDS,
        preferences.incomeMinBandCode,
        preferences.incomeMaxBandCode,
        subject.monthlyIncomeBandCode,
      ),
    ],
    [
      'familyStatus',
      betweenOrdered(
        FAMILY_STATUSES,
        preferences.familyStatusMinCode,
        null,
        subject.familyStatusCode,
      ),
    ],
    [
      'religiousPractice',
      inList(preferences.religiousPracticeCodes, subject.religiousPracticeCode),
    ],
    ['diet', inList(preferences.dietaryPreferenceCodes, subject.dietaryPreferenceCode)],
    ['smoking', inList(preferences.smokingCodes, subject.smokingCode)],
    ['children', inList(preferences.childrenCodes, subject.childrenCode)],
    ['relocation', inList(preferences.relocationCodes, subject.relocationCode)],
  ];
  return checks.flatMap(([key, outcome]) => (outcome === null ? [] : [{ key, outcome }]));
}

export function countOutcomes(results: readonly CriterionResult[]): Counts {
  const counts: Counts = { met: 0, unmet: 0, unknown: 0 };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

/** Both directions at once: the candidate against the client's wishes, and the client against theirs. */
export function pairFit(
  client: { profile: ProfileContent; preferences: ProfilePreferences },
  candidate: { profile: ProfileContent; preferences: ProfilePreferences },
  today: Date,
): PairFit {
  const forward = fitOf(client.preferences, candidate.profile, today);
  const reverse = fitOf(candidate.preferences, client.profile, today);
  const a = countOutcomes(forward);
  const b = countOutcomes(reverse);
  return {
    forward,
    reverse,
    met: a.met + b.met,
    unmet: a.unmet + b.unmet,
    unknown: a.unknown + b.unknown,
  };
}

/**
 * Best first: fewest unmet, then most met, then fewest unknown, then the newest profile. The last
 * step keeps the order stable and favours people who joined recently.
 */
export function compareFit(
  a: Counts & { createdAt: string; id: string },
  b: Counts & { createdAt: string; id: string },
): number {
  return (
    a.unmet - b.unmet ||
    b.met - a.met ||
    a.unknown - b.unknown ||
    (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
