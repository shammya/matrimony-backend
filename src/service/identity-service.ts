import type { IdentityDbService } from '../db/service/identity-db-service.js';
import { AppError } from '../exception/app-error.js';
export class IdentityService {
  constructor(
    private readonly db: IdentityDbService,
    private readonly hosts: Record<string, string>,
  ) {}
  async tenant(hostname: string) {
    const id = this.hosts[hostname];
    if (!id) throw new AppError(404, 'TENANT_NOT_FOUND');
    const tenant = await this.db.tenant(id);
    if (!tenant || tenant.hostname !== hostname) throw new AppError(404, 'TENANT_NOT_FOUND');
    return tenant;
  }
  /** The active account with this id, read fresh so a disabled account or a changed role applies at once. */
  async account(agencyId: string, accountId: string) {
    const account = await this.db.account(agencyId, accountId);
    if (!account) throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
    return account;
  }
}
