import type { PublicConfig } from './public-config.js';
export interface Account {
  id: string;
  agencyId: string;
  role: 'admin' | 'agent' | 'member';
  displayName: string;
}
export type Principal = Account;
export interface Tenant {
  id: string;
  hostname: string;
  name: string;
  locale: string;
  publicConfig: PublicConfig;
}
