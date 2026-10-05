import { z } from 'zod';
import { PROFILE_STATUSES } from '../../bo/profile-state.js';
import {
  CONTACT_COLUMNS,
  PREFERENCE_COLUMNS,
  PROFILE_COLUMNS,
  type ColumnSpec,
} from '../raw/query/profile-columns.js';

/** A validator for one table's rows, generated from its column list. */
function columns(specs: readonly ColumnSpec[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const spec of specs) {
    const base =
      spec.kind === 'int'
        ? z.number().int()
        : spec.kind === 'list'
          ? z.array(z.string())
          : z.string();
    shape[spec.column] = spec.required ? base : base.nullable();
  }
  return shape;
}

export const profileRow = z.object({
  id: z.uuid(),
  member_code: z.string(),
  status: z.enum(PROFILE_STATUSES),
  version: z.number().int().positive(),
  current_division_code: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  ...columns(PROFILE_COLUMNS),
});
export const contactRow = z.object(columns(CONTACT_COLUMNS));
export const preferencesRow = z.object(columns(PREFERENCE_COLUMNS));

export const reviewRow = z.object({
  id: z.uuid(),
  kind: z.enum(['initial_submission', 'field_update']),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  base_profile_version: z.number().int().nullable(),
  proposed_changes: z.record(z.string(), z.unknown()).nullable(),
  reviewer_notes: z.string().nullable(),
  reviewed_at: z.date().nullable(),
  created_at: z.date(),
});
