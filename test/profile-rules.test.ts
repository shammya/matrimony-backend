import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageOn,
  diffProfileData,
  isEmptyChange,
  missingRequired,
  newMemberCode,
  profileInputSchema,
  REQUIRED_FOR_SUBMISSION,
  type ProfileData,
} from '../src/bo/profile.js';
import { DISTRICTS, DISTRICTS_BY_DIVISION, DIVISIONS, divisionOf } from '../src/bo/dictionaries.js';

// A fixed "today" so age limits do not depend on when the tests run.
const today = new Date(Date.UTC(2026, 9, 6));
const schema = profileInputSchema(today);

const complete = {
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
};

/** The `path: message` pairs of every validation problem. */
function problems(input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

await test('a profile needs only a name to be saved as a draft, and everything else defaults', () => {
  const parsed = schema.parse({ profile: { fullName: '  Rahim  ' } });
  assert.equal(parsed.profile.fullName, 'Rahim');
  assert.equal(parsed.profile.managedFor, 'self');
  assert.equal(parsed.profile.nationalityCode, 'BD');
  assert.equal(parsed.profile.dateOfBirth, null);
  assert.equal(parsed.profile.heightCm, null);
  assert.deepEqual(parsed.contact.phone, null);
  assert.deepEqual(parsed.preferences.religionCodes, []);
});

await test('a missing name is refused with the required key', () => {
  assert.deepEqual(problems({ profile: {} }), ['profile.fullName: required']);
  assert.deepEqual(problems({ profile: { fullName: '   ' } }), ['profile.fullName: required']);
  assert.deepEqual(problems({}), ['profile: Invalid input: expected object, received undefined']);
});

await test('blank text is stored as nothing, and long text is refused', () => {
  const parsed = schema.parse({ profile: { fullName: 'A', hobbies: '   ', aboutMe: '' } });
  assert.equal(parsed.profile.hobbies, null);
  assert.equal(parsed.profile.aboutMe, null);
  assert.deepEqual(problems({ profile: { fullName: 'A'.repeat(101) } }), [
    'profile.fullName: tooLong',
  ]);
  assert.deepEqual(problems({ profile: { fullName: 'A', aboutMe: 'x'.repeat(2001) } }), [
    'profile.aboutMe: tooLong',
  ]);
});

await test('fields the client may not set are refused, not silently ignored', () => {
  assert.ok(problems({ profile: { fullName: 'A', status: 'active' } }).length > 0);
  assert.ok(problems({ profile: { fullName: 'A', ownerAccountId: 'x' } }).length > 0);
  assert.ok(problems({ profile: { fullName: 'A' }, status: 'active' }).length > 0);
  assert.ok(problems({ profile: { fullName: 'A' }, contact: { agent: 'x' } }).length > 0);
});

await test('dates of birth: format, real calendar dates and the age limits', () => {
  const dob = (value: string) => problems({ profile: { fullName: 'A', dateOfBirth: value } });
  assert.deepEqual(dob('1996-05-12'), []);
  assert.deepEqual(dob('12/05/1996'), ['profile.dateOfBirth: invalidDate']);
  assert.deepEqual(dob('1996-02-30'), ['profile.dateOfBirth: invalidDate']);
  assert.deepEqual(dob('2027-01-01'), ['profile.dateOfBirth: invalidDate']);
  // Exactly 18 today is fine; one day short is not.
  assert.deepEqual(dob('2008-10-06'), []);
  assert.deepEqual(dob('2008-10-07'), ['profile.dateOfBirth: underAge']);
  assert.deepEqual(dob('1925-10-07'), []);
  assert.deepEqual(dob('1925-10-06'), ['profile.dateOfBirth: tooOld']);
});

await test('age counts a 29 February birthday correctly', () => {
  assert.equal(ageOn('2000-02-29', new Date(Date.UTC(2026, 1, 28))), 25);
  assert.equal(ageOn('2000-02-29', new Date(Date.UTC(2026, 2, 1))), 26);
  assert.equal(ageOn('2001-02-29', today), null);
});

await test('coded fields accept only the codes in their option list', () => {
  const bad = problems({
    profile: {
      fullName: 'A',
      gender: 'other',
      maritalStatus: 'single',
      religionCode: 'Islam',
      currentDistrictCode: 'atlantis',
      highestDegreeCode: 'bsc',
      occupationCode: 'astronaut',
    },
  });
  assert.equal(bad.length, 6);
  assert.ok(bad.every((line) => line.endsWith('invalidOption')));
});

await test('numbers must be real numbers inside their range', () => {
  const field = (profile: Record<string, unknown>) =>
    problems({ profile: { fullName: 'A', ...profile } });
  assert.deepEqual(field({ heightCm: 172 }), []);
  assert.deepEqual(field({ heightCm: 99 }), ['profile.heightCm: outOfRange']);
  assert.deepEqual(field({ heightCm: 251 }), ['profile.heightCm: outOfRange']);
  assert.deepEqual(field({ heightCm: 172.5 }), ['profile.heightCm: invalid']);
  assert.deepEqual(field({ heightCm: '172' }), ['profile.heightCm: invalid']);
  assert.deepEqual(field({ siblingCount: -1 }), ['profile.siblingCount: outOfRange']);
  assert.deepEqual(field({ graduationYear: 1949 }), ['profile.graduationYear: outOfRange']);
  assert.deepEqual(field({ graduationYear: 2034 }), []);
  assert.deepEqual(field({ graduationYear: 2035 }), ['profile.graduationYear: outOfRange']);
  assert.equal(schema.parse({ profile: { fullName: 'A', heightCm: '' } }).profile.heightCm, null);
});

await test('the contact phone must be a full international number and the email is cleaned', () => {
  const contact = (value: Record<string, unknown>) =>
    problems({ profile: { fullName: 'A' }, contact: value });
  assert.deepEqual(contact({ phone: '+8801712345678' }), []);
  assert.deepEqual(contact({ phone: '01712345678' }), ['contact.phone: invalidPhone']);
  assert.deepEqual(contact({ phone: '+0123456789' }), ['contact.phone: invalidPhone']);
  assert.deepEqual(contact({ email: 'not an email' }), ['contact.email: invalidEmail']);
  const parsed = schema.parse({
    profile: { fullName: 'A' },
    contact: { email: '  Hello@Example.COM ' },
  });
  assert.equal(parsed.contact.email, 'hello@example.com');
});

await test('partner preferences: ranges stay in order and lists are unique and tidy', () => {
  const prefs = (value: Record<string, unknown>) =>
    problems({ profile: { fullName: 'A' }, preferences: value });
  assert.deepEqual(prefs({ ageMin: 25, ageMax: 30 }), []);
  assert.deepEqual(prefs({ ageMin: 30, ageMax: 25 }), ['preferences.ageMax: rangeOrder']);
  assert.deepEqual(prefs({ ageMin: 17 }), ['preferences.ageMin: outOfRange']);
  assert.deepEqual(prefs({ heightMinCm: 180, heightMaxCm: 160 }), [
    'preferences.heightMaxCm: rangeOrder',
  ]);
  assert.deepEqual(prefs({ incomeMinBandCode: '100k_200k', incomeMaxBandCode: '20k_50k' }), [
    'preferences.incomeMaxBandCode: rangeOrder',
  ]);
  assert.deepEqual(prefs({ religionCodes: ['atlantis'] }), [
    'preferences.religionCodes.0: invalidOption',
  ]);

  const parsed = schema.parse({
    profile: { fullName: 'A' },
    preferences: {
      religionCodes: ['christianity', 'islam', 'islam'],
      districtCodes: ['sylhet', 'dhaka'],
    },
  });
  // Unique and in the option list's own order, so the same choices always compare equal.
  assert.deepEqual(parsed.preferences.religionCodes, ['islam', 'christianity']);
  assert.deepEqual(parsed.preferences.districtCodes, ['dhaka', 'sylhet']);
});

await test('the 64 districts and 8 divisions are complete, unique and consistent', () => {
  assert.equal(DIVISIONS.length, 8);
  assert.equal(DISTRICTS.length, 64);
  assert.equal(new Set(DISTRICTS).size, 64);
  for (const division of DIVISIONS) {
    for (const district of DISTRICTS_BY_DIVISION[division])
      assert.equal(divisionOf(district), division);
  }
  assert.equal(divisionOf('dhaka'), 'dhaka');
  assert.equal(divisionOf('sylhet'), 'sylhet');
  assert.equal(divisionOf('coxs_bazar'), 'chattogram');
  assert.equal(divisionOf('atlantis'), null);
  assert.equal(divisionOf(null), null);
  for (const code of DISTRICTS) assert.match(code, /^[a-z_]+$/);
});

await test('a profile is ready to submit only when the required fields are filled', () => {
  const data = schema.parse(complete) as ProfileData;
  assert.deepEqual(missingRequired(data), []);

  const draft = schema.parse({ profile: { fullName: 'Rahim' } }) as ProfileData;
  assert.deepEqual(
    missingRequired(draft),
    REQUIRED_FOR_SUBMISSION.filter((path) => path !== 'profile.fullName'),
  );

  const noPhone = schema.parse({ ...complete, contact: {} }) as ProfileData;
  assert.deepEqual(missingRequired(noPhone), ['contact.phone']);
});

await test('a change request carries only the fields that differ', () => {
  const current = schema.parse(complete) as ProfileData;

  assert.ok(isEmptyChange(diffProfileData(current, schema.parse(complete) as ProfileData)));

  const next = schema.parse({
    profile: { ...complete.profile, heightCm: 175, aboutMe: 'Hello' },
    contact: { phone: '+8801712345678', email: 'a@example.com' },
    preferences: { religionCodes: ['islam'] },
  }) as ProfileData;
  assert.deepEqual(diffProfileData(current, next), {
    profile: { heightCm: 175, aboutMe: 'Hello' },
    contact: { email: 'a@example.com' },
    preferences: { religionCodes: ['islam'] },
  });
});

await test('clearing a field is a change, and the same list in a different order is not', () => {
  const current = schema.parse({
    ...complete,
    profile: { ...complete.profile, aboutMe: 'Hello' },
    preferences: { religionCodes: ['islam', 'christianity'] },
  }) as ProfileData;
  const next = schema.parse({
    ...complete,
    profile: { ...complete.profile, aboutMe: '' },
    preferences: { religionCodes: ['christianity', 'islam'] },
  }) as ProfileData;
  assert.deepEqual(diffProfileData(current, next), { profile: { aboutMe: null } });
});

await test('member codes look like M plus seven digits', () => {
  for (let i = 0; i < 50; i += 1) assert.match(newMemberCode(), /^M\d{7}$/);
  assert.notEqual(newMemberCode(), newMemberCode());
});
