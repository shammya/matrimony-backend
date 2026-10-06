import { loadConfig } from '../src/config/env.js';
export const agency = '11111111-1111-4111-8111-111111111111';
export const otherAgency = '22222222-2222-4222-8222-222222222222';
export const accountId = '33333333-3333-4333-8333-333333333333';
export const env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app:password@localhost/test',
  DB_SSL: 'disable',
  MONGO_URL: 'mongodb://localhost:27017',
  REDIS_URL: 'redis://localhost:6379',
  TENANT_HOSTS: JSON.stringify({ localhost: agency }),
  OIDC_ISSUER: 'https://identity.example.com',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_AUDIENCE: 'api',
  SESSION_ENCRYPTION_KEY: 'ab'.repeat(32),
};
export const config = loadConfig(env);
export const account = {
  id: accountId,
  agencyId: agency,
  role: 'member' as const,
  displayName: 'Test member',
};
const unused = async () => {
  throw new Error('unused');
};
/** A profile service that must not be reached, for tests about other routes. */
export const unusedProfiles = {
  get: unused,
  save: unused,
  submit: unused,
  requestEdit: unused,
  cancelPending: unused,
};

/** A photo process that must not be reached, for tests about other routes. */
export const unusedPhotos = {
  list: unused,
  upload: unused,
  remove: unused,
  makePrimary: unused,
  image: unused,
};

/** A review process that must not be reached, for tests about other routes. */
export const unusedReviews = {
  list: unused,
  pendingCount: unused,
  detail: unused,
  approve: unused,
  reject: unused,
  photo: unused,
};

/** A client service that must not be reached, for tests about other routes. */
export const unusedClients = {
  list: unused,
  detail: unused,
  create: unused,
  save: unused,
  submit: unused,
  requestEdit: unused,
  cancelPending: unused,
  changeStatus: unused,
  assign: unused,
  listStaff: unused,
};
