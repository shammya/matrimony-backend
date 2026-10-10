/**
 * The option lists a profile's coded fields draw from. Each value is a permanent code: it is
 * stored in the database, so a code is never renamed or reused. Labels in Bengali and English
 * belong to the frontend. Add values freely; to retire one, stop offering it in the frontend.
 *
 * Several lists are ordered from lowest to highest because partner preferences compare them
 * (for example a minimum education level).
 *
 * These are development defaults chosen by the engineers, to be confirmed with the client.
 */
export const GENDERS = ['male', 'female'] as const;
export const MARITAL_STATUSES = ['never_married', 'divorced', 'widowed'] as const;
export const COMPLEXIONS = ['very_fair', 'fair', 'medium', 'olive', 'dark'] as const;
export const BLOOD_GROUPS = [
  'a_pos',
  'a_neg',
  'b_pos',
  'b_neg',
  'ab_pos',
  'ab_neg',
  'o_pos',
  'o_neg',
] as const;
export const RELIGIONS = ['islam', 'hinduism', 'buddhism', 'christianity', 'other'] as const;
export const SECTS = ['sunni', 'shia', 'other'] as const;

/** Lowest to highest. */
export const EDUCATION_LEVELS = ['ssc', 'hsc', 'diploma', 'bachelors', 'masters', 'phd'] as const;
export const DEGREES = [...EDUCATION_LEVELS, 'other'] as const;

export const OCCUPATIONS = [
  'salaried',
  'business',
  'self_employed',
  'student',
  'homemaker',
  'unemployed',
  'other',
] as const;

/** Monthly income in BDT, lowest to highest. */
export const INCOME_BANDS = [
  'below_20k',
  '20k_50k',
  '50k_100k',
  '100k_200k',
  'above_200k',
] as const;

/** Lowest to highest. */
export const FAMILY_STATUSES = [
  'lower',
  'lower_middle',
  'middle',
  'upper_middle',
  'upper',
] as const;

export const RELIGIOUS_PRACTICES = ['practicing', 'moderate', 'non_practicing'] as const;
export const DIETARY_PREFERENCES = ['no_restriction', 'halal_only', 'vegetarian', 'other'] as const;

/** What the person does for a living. `OCCUPATIONS` above is only the type of work. */
export const PROFESSIONS = [
  'doctor',
  'nurse',
  'engineer',
  'teacher',
  'lecturer',
  'banker',
  'accountant',
  'lawyer',
  'civil_servant',
  'military_police',
  'it_professional',
  'business_owner',
  'farmer',
  'journalist',
  'designer_artist',
  'other',
] as const;

export const SMOKING_HABITS = ['never', 'occasionally', 'regularly'] as const;

/** Whether the person already has children, and where they live. */
export const CHILDREN_STATUSES = ['none', 'has_living_with', 'has_not_living_with'] as const;

/** Whether the person would move for marriage. */
export const RELOCATION_OPTIONS = ['no', 'within_country', 'abroad'] as const;

/** Who the profile is for, when it is not the account holder. */
export const MANAGED_FOR = ['self', 'child', 'sibling', 'relative', 'other'] as const;

export const DISTRICTS_BY_DIVISION = {
  barishal: ['barguna', 'barishal', 'bhola', 'jhalokati', 'patuakhali', 'pirojpur'],
  chattogram: [
    'bandarban',
    'brahmanbaria',
    'chandpur',
    'chattogram',
    'coxs_bazar',
    'cumilla',
    'feni',
    'khagrachhari',
    'lakshmipur',
    'noakhali',
    'rangamati',
  ],
  dhaka: [
    'dhaka',
    'faridpur',
    'gazipur',
    'gopalganj',
    'kishoreganj',
    'madaripur',
    'manikganj',
    'munshiganj',
    'narayanganj',
    'narsingdi',
    'rajbari',
    'shariatpur',
    'tangail',
  ],
  khulna: [
    'bagerhat',
    'chuadanga',
    'jashore',
    'jhenaidah',
    'khulna',
    'kushtia',
    'magura',
    'meherpur',
    'narail',
    'satkhira',
  ],
  mymensingh: ['jamalpur', 'mymensingh', 'netrokona', 'sherpur'],
  rajshahi: [
    'bogura',
    'chapainawabganj',
    'joypurhat',
    'naogaon',
    'natore',
    'pabna',
    'rajshahi',
    'sirajganj',
  ],
  rangpur: [
    'dinajpur',
    'gaibandha',
    'kurigram',
    'lalmonirhat',
    'nilphamari',
    'panchagarh',
    'rangpur',
    'thakurgaon',
  ],
  sylhet: ['habiganj', 'moulvibazar', 'sunamganj', 'sylhet'],
} as const;

export type DivisionCode = keyof typeof DISTRICTS_BY_DIVISION;
export type DistrictCode = (typeof DISTRICTS_BY_DIVISION)[DivisionCode][number];

export const DIVISIONS = Object.keys(DISTRICTS_BY_DIVISION) as DivisionCode[];

const DIVISION_BY_DISTRICT = new Map<string, DivisionCode>(
  DIVISIONS.flatMap((division) =>
    (DISTRICTS_BY_DIVISION[division] as readonly string[]).map(
      (district) => [district, division] as const,
    ),
  ),
);

export const DISTRICTS = [...DIVISION_BY_DISTRICT.keys()] as DistrictCode[];

export function isDistrict(value: unknown): value is DistrictCode {
  return typeof value === 'string' && DIVISION_BY_DISTRICT.has(value);
}

/** The division a district belongs to, so the client never has to send (or get wrong) both. */
export function divisionOf(district: string | null | undefined): DivisionCode | null {
  return (district && DIVISION_BY_DISTRICT.get(district)) || null;
}
