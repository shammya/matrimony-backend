import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareFit,
  countOutcomes,
  fitOf,
  pairFit,
  type CriterionResult,
} from '../src/bo/matching.js';
import { profileInputSchema } from '../src/bo/profile.js';

const today = new Date(Date.UTC(2026, 9, 10));
const parse = profileInputSchema(today);

/** A profile's content and preferences with only what a test sets. */
const person = (
  profile: Record<string, unknown> = {},
  preferences: Record<string, unknown> = {},
) => {
  const parsed = parse.parse({ profile: { fullName: 'X', ...profile }, preferences });
  return { profile: parsed.profile, preferences: parsed.preferences };
};

const outcomes = (results: CriterionResult[]) =>
  Object.fromEntries(results.map((r) => [r.key, r.outcome]));

await test('a preference left empty is not a criterion', () => {
  assert.deepEqual(
    fitOf(person().preferences, person({ religionCode: 'islam' }).profile, today),
    [],
  );
});

await test('ranges: met inside, unmet outside, open ends allowed, unknown when unanswered', () => {
  const wants = person({}, { ageMin: 25, ageMax: 30, heightMinCm: 160 }).preferences;
  const check = (profile: Record<string, unknown>) =>
    outcomes(fitOf(wants, person(profile).profile, today));
  // Born 1999-10-10 is 27 on the fixed date.
  assert.deepEqual(check({ dateOfBirth: '1999-10-10', heightCm: 165 }), {
    age: 'met',
    height: 'met',
  });
  assert.deepEqual(check({ dateOfBirth: '1990-01-01', heightCm: 150 }), {
    age: 'unmet',
    height: 'unmet',
  });
  assert.deepEqual(check({}), { age: 'unknown', height: 'unknown' });
  // The edges are included: turning 25 today is 25, one day short is 24.
  assert.equal(check({ dateOfBirth: '2001-10-10' }).age, 'met');
  assert.equal(check({ dateOfBirth: '2001-10-11' }).age, 'unmet');
});

await test('lists match on the candidate answer, and an unanswered field is unknown', () => {
  const wants = person(
    {},
    { professionCodes: ['doctor', 'nurse'], smokingCodes: ['never'] },
  ).preferences;
  assert.deepEqual(
    outcomes(
      fitOf(wants, person({ professionCode: 'nurse', smokingCode: 'never' }).profile, today),
    ),
    { profession: 'met', smoking: 'met' },
  );
  assert.deepEqual(outcomes(fitOf(wants, person({ professionCode: 'engineer' }).profile, today)), {
    profession: 'unmet',
    smoking: 'unknown',
  });
});

await test('ordered lists: a minimum education and an income range', () => {
  const wants = person(
    {},
    {
      educationMinCode: 'bachelors',
      incomeMinBandCode: '50k_100k',
      incomeMaxBandCode: '100k_200k',
    },
  ).preferences;
  const check = (profile: Record<string, unknown>) =>
    outcomes(fitOf(wants, person(profile).profile, today));
  assert.deepEqual(check({ highestDegreeCode: 'masters', monthlyIncomeBandCode: '100k_200k' }), {
    education: 'met',
    income: 'met',
  });
  assert.deepEqual(check({ highestDegreeCode: 'hsc', monthlyIncomeBandCode: 'above_200k' }), {
    education: 'unmet',
    income: 'unmet',
  });
  // "other" is a degree that cannot be ranked, so it is unknown rather than unmet.
  assert.deepEqual(check({ highestDegreeCode: 'other' }), {
    education: 'unknown',
    income: 'unknown',
  });
});

await test('complexion is never a criterion, in either direction', () => {
  const picky = person({ complexionCode: 'fair' }, { complexionCodes: ['very_fair'] });
  const other = person({ complexionCode: 'dark' }, { complexionCodes: ['very_fair'] });
  assert.deepEqual(fitOf(picky.preferences, other.profile, today), []);
  const fit = pairFit(picky, other, today);
  assert.deepEqual([fit.met, fit.unmet, fit.unknown], [0, 0, 0]);
});

await test('both directions are measured and summed', () => {
  // A 34-year-old doctor who wants doctors or nurses; she is a nurse who wants 25 to 30.
  const client = person(
    { dateOfBirth: '1992-01-01', professionCode: 'doctor', gender: 'male' },
    { professionCodes: ['doctor', 'nurse'] },
  );
  const candidate = person(
    { dateOfBirth: '1998-01-01', professionCode: 'nurse', gender: 'female' },
    { ageMin: 25, ageMax: 30 },
  );
  const fit = pairFit(client, candidate, today);
  assert.deepEqual(outcomes(fit.forward), { profession: 'met' });
  assert.deepEqual(outcomes(fit.reverse), { age: 'unmet' });
  assert.deepEqual([fit.met, fit.unmet, fit.unknown], [1, 1, 0]);
  assert.deepEqual(countOutcomes(fit.forward), { met: 1, unmet: 0, unknown: 0 });
});

await test('ranking: fewest unmet, then most met, then fewest unknown, then newest', () => {
  const row = (
    id: string,
    met: number,
    unmet: number,
    unknown: number,
    createdAt = '2026-01-01',
  ) => ({
    id,
    met,
    unmet,
    unknown,
    createdAt,
  });
  const ranked = [
    row('d', 5, 2, 0),
    row('b', 3, 0, 1),
    row('a', 3, 0, 0),
    row('c', 4, 0, 1),
    row('f', 4, 0, 1, '2026-06-01'),
  ].sort(compareFit);
  // c and f tie on counts: the newer profile (f) comes first. a has fewer unknown than b.
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['f', 'c', 'a', 'b', 'd'],
  );
});
