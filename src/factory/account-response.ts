import type { Account } from '../bo/identity.js';
export function accountResponse(account: Account) {
  return {
    id: account.id,
    agencyId: account.agencyId,
    role: account.role,
    displayName: account.displayName,
  };
}
