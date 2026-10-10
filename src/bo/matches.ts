import { z } from 'zod';
import {
  DISTRICTS,
  EDUCATION_LEVELS,
  FAMILY_STATUSES,
  INCOME_BANDS,
  MARITAL_STATUSES,
  PROFESSIONS,
  RELIGIONS,
} from './dictionaries.js';
import { MAX_AGE, MIN_AGE } from './profile.js';
import type { VisibleField } from './release.js';

/**
 * A client's own matches (slices 3.D and 3.E, docs/features/discovery-loop.md): the profiles staff
 * released to them, showing only the fields staff chose, and search inside that set. Nothing outside
 * the released set is reachable, and a filter on a field the client may not see is refused, so a
 * hidden value cannot be found out by searching for it.
 *
 * The list is a preview (a few headline fields). The full profile view shows every field staff allowed.
 */
const fail = (key: string) => ({ error: key });
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const code = <T extends string>(values: readonly T[]) =>
  z.preprocess(
    blankToUndefined,
    z
      .custom<T>(
        (value) => typeof value === 'string' && (values as readonly string[]).includes(value),
        { error: 'invalidOption' },
      )
      .optional(),
  );
const whole = (min: number, max: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(min, fail('outOfRange'))
      .max(max, fail('outOfRange'))
      .optional(),
  );

export const MAX_MATCH_PAGE = 50;
export const DEFAULT_MATCH_PAGE = 20;

/** The headline fields a list card shows; the full view shows every field staff allowed. */
export const PREVIEW_FIELDS: readonly VisibleField[] = [
  'fullName',
  'age',
  'photo',
  'professionCode',
  'currentDistrictCode',
  'religionCode',
];

export const matchQuerySchema = z
  .object({
    /** A member code such as M0483921. */
    q: z.preprocess(
      blankToUndefined,
      z
        .string(fail('invalid'))
        .trim()
        .toUpperCase()
        .max(20, fail('tooLong'))
        .regex(/^[A-Z0-9]+$/, fail('invalid'))
        .optional(),
    ),
    // Basic search (3.1)
    ageMin: whole(MIN_AGE, MAX_AGE),
    ageMax: whole(MIN_AGE, MAX_AGE),
    religion: code(RELIGIONS),
    maritalStatus: code(MARITAL_STATUSES),
    profession: code(PROFESSIONS),
    district: code(DISTRICTS),
    /** The lowest education level wanted. */
    educationMin: code(EDUCATION_LEVELS),
    // Advanced search (3.2). Complexion is deliberately not a filter.
    heightMin: whole(100, 250),
    heightMax: whole(100, 250),
    incomeMin: code(INCOME_BANDS),
    incomeMax: code(INCOME_BANDS),
    familyStatusMin: code(FAMILY_STATUSES),
    originDistrict: code(DISTRICTS),
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(MAX_MATCH_PAGE, fail('outOfRange'))
      .default(DEFAULT_MATCH_PAGE),
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const order = (low: unknown, high: unknown, path: string) => {
      if (low !== undefined && high !== undefined && (low as number) > (high as number))
        ctx.addIssue({ code: 'custom', path: [path], message: 'rangeOrder' });
    };
    order(value.ageMin, value.ageMax, 'ageMax');
    order(value.heightMin, value.heightMax, 'heightMax');
    if (
      value.incomeMin !== undefined &&
      value.incomeMax !== undefined &&
      INCOME_BANDS.indexOf(value.incomeMin) > INCOME_BANDS.indexOf(value.incomeMax)
    )
      ctx.addIssue({ code: 'custom', path: ['incomeMax'], message: 'rangeOrder' });
  });
export type MatchQuery = z.output<typeof matchQuerySchema>;
export type MatchFilters = Omit<MatchQuery, 'limit' | 'after'>;

/** The field a client must be allowed to see before they may search on it. A member code is always allowed. */
const FILTER_NEEDS: Record<keyof MatchFilters, VisibleField | null> = {
  q: null,
  ageMin: 'age',
  ageMax: 'age',
  religion: 'religionCode',
  maritalStatus: 'maritalStatus',
  profession: 'professionCode',
  district: 'currentDistrictCode',
  educationMin: 'highestDegreeCode',
  heightMin: 'heightCm',
  heightMax: 'heightCm',
  incomeMin: 'monthlyIncomeBandCode',
  incomeMax: 'monthlyIncomeBandCode',
  familyStatusMin: 'familyStatusCode',
  originDistrict: 'originDistrictCode',
};

/** The filters used that the client's settings do not let them see. */
export function hiddenFilters(
  filters: MatchFilters,
  visible: readonly VisibleField[],
): (keyof MatchFilters)[] {
  return (Object.keys(FILTER_NEEDS) as (keyof MatchFilters)[]).filter((key) => {
    const needed = FILTER_NEEDS[key];
    return filters[key] !== undefined && needed !== null && !visible.includes(needed);
  });
}

/** Where a connection with this profile stands, from the viewer's side. Null when there is none. */
export interface ConnectionSummary {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  /** `sent`: the viewer asked. `received`: the other person asked. */
  direction: 'sent' | 'received';
}

/** A connection from the viewer's side, as read next to a profile. */
export interface ConnectionLink extends ConnectionSummary {
  /** The viewer has shared their own contact details with the other person. */
  iShared: boolean;
  /** The other person has shared theirs with the viewer. */
  theyShared: boolean;
}

/** What another person chose to share, once a connection is accepted. Never the permanent address. */
export interface SharedContact {
  name: string | null;
  relationship: string | null;
  phone: string | null;
  email: string | null;
}

/** The full view of one profile a client may look at. */
export interface ProfileDetail {
  profile: MatchItem;
  connection: ConnectionLink | null;
  /** Present only when the other person shared it and the connection is accepted. */
  contact: SharedContact | null;
  visibleFields: VisibleField[];
}

/** One released profile. Only the fields staff allowed are present; contact details never are. */
export interface MatchItem {
  candidateId: string;
  memberCode: string;
  /** Where it sits in the list, to the microsecond. Used only to build the next page's cursor. */
  position: string;
  connection: ConnectionSummary | null;
  fullName?: string;
  age?: number | null;
  hasPhoto?: boolean;
  aboutMe?: string | null;
  professionCode?: string | null;
  occupationCode?: string | null;
  highestDegreeCode?: string | null;
  heightCm?: number | null;
  maritalStatus?: string | null;
  religionCode?: string | null;
  currentDistrictCode?: string | null;
  originDistrictCode?: string | null;
  monthlyIncomeBandCode?: string | null;
  familyStatusCode?: string | null;
  hobbies?: string | null;
}

export interface MatchPage {
  items: MatchItem[];
  next: string | null;
  /** The member's own profile status, or null when they have none yet. */
  profileStatus: string | null;
  /** Profiles released to them in all, whatever filter is used. */
  releasedTotal: number;
  /** The fields staff let this member see: what a card may show and what can be searched. */
  visibleFields: VisibleField[];
}
