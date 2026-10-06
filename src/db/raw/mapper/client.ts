import type { ClientListItem, ClientMeta, StaffMember } from '../../../bo/client.js';
import { clientListRow, clientMetaRow, staffRow } from '../../entity/client.js';

export function mapClientItem(value: unknown): ClientListItem {
  const row = clientListRow.parse(value);
  return {
    id: row.id,
    memberCode: row.member_code,
    fullName: row.full_name,
    status: row.status,
    serviceMode: row.service_mode,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    position: row.position,
    assignedAgent:
      row.assigned_agent_id && row.agent_name
        ? { id: row.assigned_agent_id, displayName: row.agent_name }
        : null,
    districtCode: row.current_district_code,
    hasPendingReview: row.has_pending_review,
  };
}

export function mapClientMeta(value: unknown): ClientMeta {
  const row = clientMetaRow.parse(value);
  return {
    serviceMode: row.service_mode,
    assignedAgent:
      row.assigned_agent_id && row.agent_name
        ? { id: row.assigned_agent_id, displayName: row.agent_name }
        : null,
    owner:
      row.owner_account_id && row.owner_name
        ? { id: row.owner_account_id, displayName: row.owner_name }
        : null,
  };
}

export function mapStaff(value: unknown): StaffMember {
  const row = staffRow.parse(value);
  return { id: row.id, displayName: row.display_name, role: row.role, status: row.status };
}
