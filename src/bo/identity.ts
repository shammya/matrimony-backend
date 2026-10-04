export interface Identity {
  issuer: string;
  subject: string;
  expiresAt: number;
}
export interface Account {
  id: string;
  agencyId: string;
  role: 'admin' | 'agent' | 'member';
  displayName: string;
}
export interface Principal extends Account {
  subject: string;
}
export interface Tenant {
  id: string;
  hostname: string;
  name: string;
  locale: string;
  publicConfig: Record<string, unknown>;
}
