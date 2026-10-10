import { z } from 'zod';

/**
 * What staff let a client see of the profiles released to them (slice 3.C). Contact details and
 * internal notes are not in this list and can never be added to what a client sees through it.
 */
const fail = (key: string) => ({ error: key });

/** A client's window holds at most this many released profiles unless staff set another number. */
export const DEFAULT_CAP = 50;
export const MAX_CAP = 200;

/** The fields of a released profile staff may show, in the order they are listed everywhere. */
export const VISIBLE_FIELDS = [
  'fullName',
  'age',
  'photo',
  'aboutMe',
  'professionCode',
  'occupationCode',
  'highestDegreeCode',
  'heightCm',
  'maritalStatus',
  'religionCode',
  'currentDistrictCode',
  'originDistrictCode',
  'monthlyIncomeBandCode',
  'familyStatusCode',
  'hobbies',
] as const;
export type VisibleField = (typeof VISIBLE_FIELDS)[number];

/** What a client sees until staff choose otherwise. */
export const DEFAULT_VISIBLE_FIELDS: readonly VisibleField[] = [
  'fullName',
  'age',
  'photo',
  'aboutMe',
  'professionCode',
  'currentDistrictCode',
  'religionCode',
];

export const settingsInputSchema = z
  .object({
    cap: z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(MAX_CAP, fail('outOfRange')),
    visibleFields: z
      .array(z.enum(VISIBLE_FIELDS, fail('invalidOption')))
      .min(1, fail('required'))
      .max(VISIBLE_FIELDS.length, fail('invalid'))
      // Unique, and in the list's own order, so equal choices always compare equal.
      .transform((list): VisibleField[] => VISIBLE_FIELDS.filter((field) => list.includes(field))),
  })
  .strict();
export type SettingsInput = z.output<typeof settingsInputSchema>;

/** The profiles a staff action is about. */
export const candidateIdsSchema = z
  .object({
    candidateIds: z
      .array(z.uuid(fail('invalid')))
      .min(1, fail('required'))
      .max(MAX_CAP, fail('tooMany'))
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();
export type CandidateIdsInput = z.output<typeof candidateIdsSchema>;

export interface ReleaseSettings {
  cap: number;
  visibleFields: VisibleField[];
  /** How many profiles are in the client's window now. */
  releasedCount: number;
  /** True when staff have not set anything yet and the defaults apply. */
  isDefault: boolean;
}

export interface ReleaseOutcome {
  /** Profiles that moved. */
  done: string[];
  /** Asked for but not moved: not in the right state, or no longer published. */
  skipped: string[];
}
