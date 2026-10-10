/**
 * The one list of profile columns. The SQL, the row validation and the mapping to the API's
 * camelCase names are all generated from it, so a field cannot be added to one and forgotten
 * in another. Every name here is a fixed identifier written in code, never user input.
 */
export type ColumnKind = 'text' | 'int' | 'date' | 'list';

export interface ColumnSpec {
  /** The field name in the API and in the review request's stored changes. */
  key: string;
  column: string;
  kind: ColumnKind;
  /** NOT NULL in the database. */
  required?: boolean;
}

const text = (key: string, column: string, required = false): ColumnSpec => ({
  key,
  column,
  kind: 'text',
  required,
});
const int = (key: string, column: string): ColumnSpec => ({ key, column, kind: 'int' });
const list = (key: string, column: string): ColumnSpec => ({
  key,
  column,
  kind: 'list',
  required: true,
});

export const PROFILE_COLUMNS: readonly ColumnSpec[] = [
  text('managedFor', 'managed_for', true),
  text('fullName', 'full_name', true),
  { key: 'dateOfBirth', column: 'date_of_birth', kind: 'date' },
  text('gender', 'gender'),
  text('maritalStatus', 'marital_status'),
  int('heightCm', 'height_cm'),
  int('weightKg', 'weight_kg'),
  text('complexionCode', 'complexion_code'),
  text('bloodGroup', 'blood_group'),
  text('nationalityCode', 'nationality_code', true),
  text('religionCode', 'religion_code'),
  text('sectCode', 'sect_code'),
  text('currentCity', 'current_city'),
  text('currentDistrictCode', 'current_district_code'),
  text('originDistrictCode', 'origin_district_code'),
  text('highestDegreeCode', 'highest_degree_code'),
  text('institutionName', 'institution_name'),
  text('fieldOfStudy', 'field_of_study'),
  int('graduationYear', 'graduation_year'),
  text('occupationCode', 'occupation_code'),
  text('jobTitle', 'job_title'),
  text('employerName', 'employer_name'),
  text('monthlyIncomeBandCode', 'monthly_income_band_code'),
  text('fatherName', 'father_name'),
  text('fatherOccupation', 'father_occupation'),
  text('motherName', 'mother_name'),
  text('motherOccupation', 'mother_occupation'),
  int('siblingCount', 'sibling_count'),
  text('familyStatusCode', 'family_status_code'),
  text('religiousPracticeCode', 'religious_practice_code'),
  text('dietaryPreferenceCode', 'dietary_preference_code'),
  text('professionCode', 'profession_code'),
  text('smokingCode', 'smoking_code'),
  text('childrenCode', 'children_code'),
  text('relocationCode', 'relocation_code'),
  text('hobbies', 'hobbies'),
  text('aboutMe', 'about_me'),
];

export const CONTACT_COLUMNS: readonly ColumnSpec[] = [
  text('contactName', 'contact_name'),
  text('contactRelationship', 'contact_relationship'),
  text('phone', 'phone_e164'),
  text('email', 'email'),
  text('permanentAddress', 'permanent_address'),
];

export const PREFERENCE_COLUMNS: readonly ColumnSpec[] = [
  int('ageMin', 'age_min'),
  int('ageMax', 'age_max'),
  int('heightMinCm', 'height_min_cm'),
  int('heightMaxCm', 'height_max_cm'),
  list('religionCodes', 'religion_codes'),
  list('sectCodes', 'sect_codes'),
  list('maritalStatusCodes', 'marital_status_codes'),
  text('educationMinCode', 'education_min_code'),
  list('occupationCodes', 'occupation_codes'),
  list('districtCodes', 'district_codes'),
  text('incomeMinBandCode', 'income_min_band_code'),
  text('incomeMaxBandCode', 'income_max_band_code'),
  text('familyStatusMinCode', 'family_status_min_code'),
  list('professionCodes', 'profession_codes'),
  list('complexionCodes', 'complexion_codes'),
  list('religiousPracticeCodes', 'religious_practice_codes'),
  list('dietaryPreferenceCodes', 'dietary_preference_codes'),
  list('smokingCodes', 'smoking_codes'),
  list('childrenCodes', 'children_codes'),
  list('relocationCodes', 'relocation_codes'),
];

/** The value to store for a field the client left out: an empty list or nothing. */
export const emptyValue = (spec: ColumnSpec): null | never[] => (spec.kind === 'list' ? [] : null);
