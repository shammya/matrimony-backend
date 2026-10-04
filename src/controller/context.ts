import type { Tenant, Principal } from '../bo/identity.js';
declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant | null;
    principal: Principal | null;
    canonicalOrigin: string;
  }
  interface FastifyContextConfig {
    public?: boolean;
    roles?: Principal['role'][];
    tenantRequired?: boolean;
  }
}
export {};
