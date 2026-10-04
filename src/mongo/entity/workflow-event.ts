import type { WorkflowEvent } from '../../bo/event.js';
export interface EventDocument extends WorkflowEvent {
  _id: string;
  storedAt: Date;
}
