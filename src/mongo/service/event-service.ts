import type { MongoEventRepository } from '../repository/event-repository.js';
import { eventSchema, type WorkflowEvent } from '../../bo/event.js';
export class MongoEventService {
  constructor(private readonly repository: MongoEventRepository) {}
  store(event: WorkflowEvent) {
    return this.repository.store(eventSchema.parse(event));
  }
}
