import { z } from 'zod';
export const bearerSchema = z
  .string()
  .regex(/^Bearer [A-Za-z0-9_.-]+$/)
  .max(16384)
  .transform((v) => v.slice(7));
export const browserSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const selfResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'agencyId', 'role', 'displayName'],
  properties: {
    id: { type: 'string' },
    agencyId: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'agent', 'member'] },
    displayName: { type: 'string' },
  },
} as const;
export const tokensResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['accessToken', 'csrfToken', 'expiresIn'],
  properties: {
    accessToken: { type: 'string' },
    csrfToken: { type: 'string' },
    expiresIn: { type: 'integer' },
  },
} as const;
