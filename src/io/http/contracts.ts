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
/** A short machine-readable outcome, for steps that return nothing else. */
export const statusResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string' } },
} as const;
/** Where to send the browser to sign in at an outside provider. */
export const authorizationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['authorizationUrl'],
  properties: { authorizationUrl: { type: 'string' } },
} as const;
/** Which ways of signing in this deployment offers. */
export const methodsResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['password', 'google', 'phone'],
  properties: {
    password: { type: 'boolean' },
    google: { type: 'boolean' },
    phone: { type: 'boolean' },
  },
} as const;
/** The account a Google sign-in is waiting to be linked to. */
export const pendingLinkResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email'],
  properties: { email: { type: 'string' } },
} as const;
/** The Google person waiting to agree to the terms before an account is created. */
export const pendingSignupResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'name'],
  properties: { email: { type: 'string' }, name: { type: 'string' } },
} as const;
/** A code was sent: when another can be asked for, and how long this one works, in seconds. */
export const codeSentResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'resendAfter', 'expiresIn'],
  properties: {
    status: { type: 'string' },
    resendAfter: { type: 'integer' },
    expiresIn: { type: 'integer' },
  },
} as const;
/** The proven number waiting for its owner to give a name and agree to the terms. */
export const pendingPhoneSignupResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['phone'],
  properties: { phone: { type: 'string' } },
} as const;
/** What the signed-in account can sign in with. The number is partly hidden. */
export const signInMethodsResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'emailVerified', 'phone', 'hasPassword', 'google'],
  properties: {
    email: { type: ['string', 'null'] },
    emailVerified: { type: 'boolean' },
    phone: { type: ['string', 'null'] },
    hasPassword: { type: 'boolean' },
    google: { type: 'boolean' },
  },
} as const;
