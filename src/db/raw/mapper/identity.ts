import { accountRow, tenantRow } from '../../entity/identity.js';
import type { Account, Tenant } from '../../../bo/identity.js';
import { parsePublicConfig } from '../../../bo/public-config.js';
export function mapAccount(value: unknown): Account {
  const row = accountRow.parse(value);
  return { id: row.id, agencyId: row.agency_id, role: row.role, displayName: row.display_name };
}
export function mapTenant(value: unknown): Tenant {
  const row = tenantRow.parse(value);
  return {
    id: row.id,
    hostname: row.hostname,
    name: row.name,
    locale: row.default_locale,
    publicConfig: parsePublicConfig(row.public_config),
  };
}
