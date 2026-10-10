import type {
  ConnectionPage,
  NotificationPage,
  SendResult,
  StaffConnectionRow,
} from '../bo/connection.js';
import { matchItemResponse } from './match-response.js';

export const sendResponse = (result: SendResult) => ({
  outcome: result.outcome,
  connectionId: result.connectionId,
  status: result.status,
});

export const connectionPageResponse = (page: ConnectionPage) => ({
  items: page.items.map((row) => ({
    connectionId: row.connectionId,
    status: row.status,
    direction: row.direction,
    createdAt: row.createdAt,
    respondedAt: row.respondedAt,
    iSharedContact: row.iShared,
    theySharedContact: row.theyShared,
    profile: matchItemResponse(row.profile),
  })),
  next: page.next,
});

export const notificationPageResponse = (page: NotificationPage) => ({
  items: page.items.map((n) => ({
    id: n.id,
    kind: n.kind,
    createdAt: n.createdAt,
    connectionId: n.connectionId,
    forProfileId: n.forProfileId,
    about: {
      profileId: n.about.profileId,
      memberCode: n.about.memberCode,
      fullName: n.about.fullName,
    },
  })),
  next: page.next,
});

/** What staff see of a client's connections. Names and codes only: no contact details. */
export const staffConnectionsResponse = (rows: StaffConnectionRow[]) => ({
  items: rows.map((row) => ({
    connectionId: row.connectionId,
    status: row.status,
    direction: row.direction,
    createdAt: row.createdAt,
    respondedAt: row.respondedAt,
    clientSharedContact: row.clientShared,
    otherSharedContact: row.otherShared,
    other: {
      profileId: row.other.profileId,
      memberCode: row.other.memberCode,
      fullName: row.other.fullName,
      age: row.other.age,
      professionCode: row.other.professionCode,
      currentDistrictCode: row.other.currentDistrictCode,
      serviceMode: row.other.serviceMode,
    },
  })),
});
