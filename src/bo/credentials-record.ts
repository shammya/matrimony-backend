import type { Account } from './identity.js';

/** What the sign-in needs to know about the account that owns an email address. */
export interface CredentialRecord {
  account: Account;
  status: 'invited' | 'active' | 'disabled';
  email: string | null;
  locale: 'bn' | 'en';
  /** Null for an account that has no password (for example one created another way). */
  passwordHash: string | null;
}
