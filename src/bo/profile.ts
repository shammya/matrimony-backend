import { randomInt } from 'node:crypto';
import { z } from 'zod';
import {
  BLOOD_GROUPS,
  CHILDREN_STATUSES,
  COMPLEXIONS,
  DEGREES,
  DIETARY_PREFERENCES,
  DISTRICTS,
  EDUCATION_LEVELS,
  FAMILY_STATUSES,
  GENDERS,
  INCOME_BANDS,
  MANAGED_FOR,
  MARITAL_STATUSES,
  OCCUPATIONS,
  PROFESSIONS,
  RELIGIONS,
  RELIGIOUS_PRACTICES,
  RELOCATION_OPTIONS,
  SECTS,
  SMOKING_HABITS,
} from './dictionaries.js';

/**
 * A member's own profile: biodata, private contact details and partner preferences.
 *
 * Validation messages are stable keys, not sentences. The frontend turns a key such as
 * `required` or `invalidDate` into the reader's language. Anything the client may not set
 * (owner, status, version, member code, assigned agent) is deliberately not part of the input,
 * and unknown fields are rejected.
 */

const fail = (key: string) => ({ error: key });
const blankToNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;
const blankToUndefined = (value: unknown) => blankToNull(value) ?? undefined;

const code = <T extends string>(values: readonly T[]) =>
  z.custom<T>(
    (value) => typeof value === 'string' && (values as readonly string[]).includes(value),
    {
      error: 'invalidOption',
    },
  );
const optionalCode = <T extends string>(values: readonly T[]) =>
  z.preprocess(blankToNull, code(values).nullable().default(null));
const codeList = <T extends string>(values: readonly T[]) =>
  z
    .preprocess(
      (value) => value ?? undefined,
      z.array(code(values)).max(values.length, fail('invalid')).default([]),
    )
    // Unique, and in the dictionary's own order, so equal choices always compare equal.
    .transform((list): T[] => values.filter((value) => list.includes(value)));

const text = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max, fail('tooLong')).nullable().default(null));
const wholeNumber = (min: number, max: number) =>
  z.preprocess(
    blankToNull,
    z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(min, fail('outOfRange'))
      .max(max, fail('outOfRange'))
      .nullable()
      .default(null),
  );

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MIN_AGE = 18;
export const MAX_AGE = 100;

/** Whole years between a calendar date written as YYYY-MM-DD and `today`, or null if it is not a real date. */
export function ageOn(dateOfBirth: string, today: Date): number | null {
  const match = YMD.exec(dateOfBirth);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const born = new Date(Date.UTC(year, month - 1, day));
  if (
    born.getUTCFullYear() !== year ||
    born.getUTCMonth() !== month - 1 ||
    born.getUTCDate() !== day
  )
    return null;
  let age = today.getUTCFullYear() - year;
  const birthdayPassed =
    today.getUTCMonth() > month - 1 ||
    (today.getUTCMonth() === month - 1 && today.getUTCDate() >= day);
  if (!birthdayPassed) age -= 1;
  return age;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Built per request because the age limits depend on today's date. */
export function profileInputSchema(now: Date = new Date()) {
  const dateOfBirth = z.preprocess(
    blankToNull,
    z
      .string()
      .nullable()
      .default(null)
      .superRefine((value, ctx) => {
        if (value === null) return;
        const age = ageOn(value, now);
        if (age === null || age < 0) ctx.addIssue({ code: 'custom', message: 'invalidDate' });
        else if (age < MIN_AGE) ctx.addIssue({ code: 'custom', message: 'underAge' });
        else if (age > MAX_AGE) ctx.addIssue({ code: 'custom', message: 'tooOld' });
      }),
  );

  const profile = z
    .object({
      managedFor: z.preprocess(blankToUndefined, code(MANAGED_FOR).default('self')),
      fullName: z
        .string(fail('required'))
        .trim()
        .min(1, fail('required'))
        .max(100, fail('tooLong')),
      dateOfBirth,
      gender: optionalCode(GENDERS),
      maritalStatus: optionalCode(MARITAL_STATUSES),
      heightCm: wholeNumber(100, 250),
      weightKg: wholeNumber(20, 300),
      complexionCode: optionalCode(COMPLEXIONS),
      bloodGroup: optionalCode(BLOOD_GROUPS),
      nationalityCode: z.preprocess(
        blankToUndefined,
        z
          .string()
          .regex(/^[A-Z]{2}$/, fail('invalid'))
          .default('BD'),
      ),
      religionCode: optionalCode(RELIGIONS),
      sectCode: optionalCode(SECTS),
      currentCity: text(100),
      currentDistrictCode: optionalCode(DISTRICTS),
      originDistrictCode: optionalCode(DISTRICTS),
      highestDegreeCode: optionalCode(DEGREES),
      institutionName: text(150),
      fieldOfStudy: text(100),
      graduationYear: wholeNumber(1950, now.getUTCFullYear() + 8),
      occupationCode: optionalCode(OCCUPATIONS),
      jobTitle: text(100),
      employerName: text(150),
      monthlyIncomeBandCode: optionalCode(INCOME_BANDS),
      fatherName: text(100),
      fatherOccupation: text(100),
      motherName: text(100),
      motherOccupation: text(100),
      siblingCount: wholeNumber(0, 30),
      familyStatusCode: optionalCode(FAMILY_STATUSES),
      religiousPracticeCode: optionalCode(RELIGIOUS_PRACTICES),
      dietaryPreferenceCode: optionalCode(DIETARY_PREFERENCES),
      professionCode: optionalCode(PROFESSIONS),
      smokingCode: optionalCode(SMOKING_HABITS),
      childrenCode: optionalCode(CHILDREN_STATUSES),
      relocationCode: optionalCode(RELOCATION_OPTIONS),
      hobbies: text(500),
      aboutMe: text(2000),
    })
    .strict();

  const contact = z.preprocess(
    (value) => value ?? {},
    z
      .object({
        contactName: text(100),
        contactRelationship: text(50),
        phone: z.preprocess(
          blankToNull,
          z.string().regex(E164, fail('invalidPhone')).nullable().default(null),
        ),
        email: z.preprocess(
          blankToNull,
          z
            .string()
            .trim()
            .toLowerCase()
            .max(200, fail('tooLong'))
            .pipe(z.email(fail('invalidEmail')))
            .nullable()
            .default(null),
        ),
        permanentAddress: text(300),
      })
      .strict(),
  );

  const ordered = (list: readonly string[], low: string | null, high: string | null) =>
    low === null || high === null || list.indexOf(low) <= list.indexOf(high);

  const preferences = z.preprocess(
    (value) => value ?? {},
    z
      .object({
        ageMin: wholeNumber(MIN_AGE, MAX_AGE),
        ageMax: wholeNumber(MIN_AGE, MAX_AGE),
        heightMinCm: wholeNumber(100, 250),
        heightMaxCm: wholeNumber(100, 250),
        religionCodes: codeList(RELIGIONS),
        sectCodes: codeList(SECTS),
        maritalStatusCodes: codeList(MARITAL_STATUSES),
        educationMinCode: optionalCode(EDUCATION_LEVELS),
        occupationCodes: codeList(OCCUPATIONS),
        districtCodes: codeList(DISTRICTS),
        incomeMinBandCode: optionalCode(INCOME_BANDS),
        incomeMaxBandCode: optionalCode(INCOME_BANDS),
        familyStatusMinCode: optionalCode(FAMILY_STATUSES),
        professionCodes: codeList(PROFESSIONS),
        complexionCodes: codeList(COMPLEXIONS),
        religiousPracticeCodes: codeList(RELIGIOUS_PRACTICES),
        dietaryPreferenceCodes: codeList(DIETARY_PREFERENCES),
        smokingCodes: codeList(SMOKING_HABITS),
        childrenCodes: codeList(CHILDREN_STATUSES),
        relocationCodes: codeList(RELOCATION_OPTIONS),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.ageMin !== null && value.ageMax !== null && value.ageMin > value.ageMax)
          ctx.addIssue({ code: 'custom', message: 'rangeOrder', path: ['ageMax'] });
        if (
          value.heightMinCm !== null &&
          value.heightMaxCm !== null &&
          value.heightMinCm > value.heightMaxCm
        )
          ctx.addIssue({ code: 'custom', message: 'rangeOrder', path: ['heightMaxCm'] });
        if (!ordered(INCOME_BANDS, value.incomeMinBandCode, value.incomeMaxBandCode))
          ctx.addIssue({ code: 'custom', message: 'rangeOrder', path: ['incomeMaxBandCode'] });
      }),
  );

  return z
    .object({
      // The version the client last saw. Required when changing an existing profile.
      version: z.number().int().positive().nullish(),
      profile,
      contact,
      preferences,
    })
    .strict();
}

export type ProfileInput = z.output<ReturnType<typeof profileInputSchema>>;
export type ProfileContent = ProfileInput['profile'];
export type ProfileContact = ProfileInput['contact'];
export type ProfilePreferences = ProfileInput['preferences'];

/** The editable content of a profile, as saved and as shown back to its owner. */
export interface ProfileData {
  profile: ProfileContent;
  contact: ProfileContact;
  preferences: ProfilePreferences;
}

export type ProfileStatus =
  'draft' | 'pending_review' | 'rejected' | 'active' | 'paused' | 'matched' | 'closed';

/** Only the fields that differ, in the same shape as the content. Stored with a review request. */
export interface ProposedChanges {
  profile?: Partial<ProfileContent>;
  contact?: Partial<ProfileContact>;
  preferences?: Partial<ProfilePreferences>;
}

/** What a profile needs before it can be submitted for review (a development default). */
export const REQUIRED_FOR_SUBMISSION = [
  'profile.fullName',
  'profile.dateOfBirth',
  'profile.gender',
  'profile.maritalStatus',
  'profile.heightCm',
  'profile.religionCode',
  'profile.currentDistrictCode',
  'profile.highestDegreeCode',
  'profile.occupationCode',
  'contact.phone',
] as const;

const valueAt = (data: ProfileData, path: string): unknown => {
  const [section, key] = path.split('.') as [keyof ProfileData, string];
  return (data[section] as Record<string, unknown>)[key];
};

/** The required paths that are still empty. */
export function missingRequired(data: ProfileData): string[] {
  return REQUIRED_FOR_SUBMISSION.filter((path) => {
    const value = valueAt(data, path);
    return (
      value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    );
  });
}

/** What changed between the published content and a proposed version. Empty when nothing did. */
export function diffProfileData(current: ProfileData, next: ProfileData): ProposedChanges {
  const changes: ProposedChanges = {};
  for (const section of ['profile', 'contact', 'preferences'] as const) {
    const before = current[section] as Record<string, unknown>;
    const after = next[section] as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(after)) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed[key] = after[key];
    }
    if (Object.keys(changed).length > 0) (changes as Record<string, unknown>)[section] = changed;
  }
  return changes;
}

export const isEmptyChange = (changes: ProposedChanges) => Object.keys(changes).length === 0;

/** The published content with a request's changes applied: what approving the request produces. */
export function applyChanges(current: ProfileData, changes: ProposedChanges): ProfileData {
  return {
    profile: { ...current.profile, ...changes.profile },
    contact: { ...current.contact, ...changes.contact },
    preferences: { ...current.preferences, ...changes.preferences },
  };
}

/** One field a reviewer is asked to look at: where it is, and its value before and after. */
export interface FieldChange {
  /** For example `profile.heightCm`. */
  path: string;
  before: unknown;
  after: unknown;
}

const isEmptyValue = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/** The fields a request changes, each with the published value and the proposed one. */
export function describeChanges(current: ProfileData, changes: ProposedChanges): FieldChange[] {
  const out: FieldChange[] = [];
  for (const section of ['profile', 'contact', 'preferences'] as const) {
    const before = current[section] as Record<string, unknown>;
    const proposed = (changes[section] ?? {}) as Record<string, unknown>;
    for (const [key, after] of Object.entries(proposed)) {
      out.push({ path: `${section}.${key}`, before: before[key] ?? null, after });
    }
  }
  return out;
}

/** Everything filled in on a profile, for a first submission where nothing was published before. */
export function describeContent(data: ProfileData): FieldChange[] {
  const out: FieldChange[] = [];
  for (const section of ['profile', 'contact', 'preferences'] as const) {
    for (const [key, value] of Object.entries(data[section] as Record<string, unknown>)) {
      if (!isEmptyValue(value)) out.push({ path: `${section}.${key}`, before: null, after: value });
    }
  }
  return out;
}

/** A member code such as M0483921. Random so codes do not reveal how many members there are. */
export function newMemberCode(): string {
  return `M${randomInt(0, 10_000_000).toString().padStart(7, '0')}`;
}
