import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { EventDeliveryProcess, retryDelay } from '../src/process/event-delivery-process.js';
import { eventSchema, type LeasedEvent } from '../src/bo/event.js';
import { agency, accountId } from './fixtures.js';
const item: LeasedEvent = {
  leaseToken: accountId,
  attempts: 2,
  event: {
    id: accountId,
    agencyId: agency,
    actorId: null,
    subjectId: null,
    type: 'payment.confirmed',
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: 'request',
  },
};
await test('Mongo delivery failure preserves pending event and schedules retry', async () => {
  let acknowledged = false;
  let retried = false;
  const process = new EventDeliveryProcess(
    {
      claim: async () => item,
      acknowledge: async () => {
        acknowledged = true;
      },
      retry: async (_item, delay) => {
        retried = delay > 0;
      },
    },
    {
      store: async () => {
        throw new Error('unavailable');
      },
    },
    pino({ level: 'silent' }),
    12,
  );
  await process.deliverOne(agency);
  assert.equal(acknowledged, false);
  assert.equal(retried, true);
});
await test('acknowledgement happens only after successful event storage', async () => {
  const calls: string[] = [];
  const process = new EventDeliveryProcess(
    {
      claim: async () => item,
      acknowledge: async () => {
        calls.push('ack');
      },
      retry: async () => {
        calls.push('retry');
      },
    },
    {
      store: async () => {
        calls.push('store');
      },
    },
    pino({ level: 'silent' }),
    12,
  );
  await process.deliverOne(agency);
  assert.deepEqual(calls, ['store', 'ack']);
});
await test('event catalog rejects arbitrary PII payloads and retry delay is bounded', () => {
  assert.equal(eventSchema.safeParse({ ...item.event, phone: '+880123456789' }).success, false);
  assert.equal(
    retryDelay(100, () => 1),
    300000,
  );
});
