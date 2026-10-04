import type { Collection } from 'mongodb';
import type { EventDocument } from '../entity/workflow-event.js';
import type { WorkflowEvent } from '../../bo/event.js';
export class MongoEventRepository {
  constructor(private readonly collection: Collection<EventDocument>) {}
  async ready() {
    await this.collection.createIndex({ agencyId: 1, occurredAt: -1 });
  }
  async store(event: WorkflowEvent) {
    await this.collection.updateOne(
      { _id: event.id, agencyId: event.agencyId },
      { $setOnInsert: { ...event, storedAt: new Date() } },
      { upsert: true, writeConcern: { w: 'majority' } },
    );
  }
}
