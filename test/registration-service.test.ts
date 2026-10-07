import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { Account } from '../src/bo/identity.js';
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
  consentsFor,
  toRegistration,
  registrationInputSchema,
  type ConsentRecord,
  type Registration,
} from '../src/bo/registration.js';
import type { FoundAccount } from '../src/db/raw/repository/registration-repository.js';
import type { RegistrationUnit } from '../src/db/service/registration-db-service.js';
import {
  RegistrationService,
  type VerifiedRegistration,
} from '../src/service/registration-service.js';
import { agency, otherAgency } from './fixtures.js';

const registration: Registration = {
  displayName: 'Rahim',
  locale: 'bn',
  onBehalfOfOther: false,
  termsVersion: 'terms-v1',
  privacyVersion: 'privacy-v1',
};
const verified: VerifiedRegistration = {
  email: 'rahim@example.com',
  passwordHash: '$argon2id$v=19$m=64,t=1,p=1$c2FsdA$aGFzaA',
  registration,
};

interface Row {
  agencyId: string;
  account: Account;
  email: string;
  locale: string;
  status: FoundAccount['status'];
  passwordHash?: string;
}

/** An in-memory stand-in for one transaction's worth of account storage. */
class FakeStore {
  rows: Row[] = [];
  consents: { accountId: string; consent: ConsentRecord }[] = [];
  events: WorkflowEvent[] = [];
  /** Make the next insert lose a race with another request for the same email. */
  raceOnInsert: Row | null = null;
  failCredential = false;
  transactions = 0;

  db = {
    findByEmail: async (agencyId: string, email: string) => this.byEmail(agencyId, email),
    inTransaction: async <T>(_agencyId: string, work: (unit: RegistrationUnit) => Promise<T>) => {
      this.transactions += 1;
      // All or nothing, like a database transaction.
      const before = {
        rows: [...this.rows],
        consents: [...this.consents],
        events: [...this.events],
      };
      try {
        return await work(this.unit());
      } catch (error) {
        Object.assign(this, before);
        throw error;
      }
    },
  };

  private byEmail(agencyId: string, email: string): FoundAccount | null {
    const row = this.rows.find((r) => r.agencyId === agencyId && r.email === email);
    return row ? { account: row.account, status: row.status } : null;
  }

  add(agencyId: string, email: string, status: FoundAccount['status'] = 'active') {
    const account: Account = {
      id: randomUUID(),
      agencyId,
      role: 'member',
      displayName: 'Existing',
    };
    const row: Row = { agencyId, account, email, locale: 'bn', status, passwordHash: 'existing' };
    this.rows.push(row);
    return row;
  }

  unit(): RegistrationUnit {
    return {
      findByEmail: async (agencyId, email) => this.byEmail(agencyId, email),
      createMember: async (agencyId, member) => {
        if (this.raceOnInsert) {
          this.rows.push(this.raceOnInsert);
          this.raceOnInsert = null;
          return null;
        }
        const account: Account = {
          id: member.id,
          agencyId,
          role: 'member',
          displayName: member.displayName,
        };
        this.rows.push({
          agencyId,
          account,
          email: member.email,
          locale: member.locale,
          status: 'active',
        });
        return account;
      },
      createCredential: async (_agencyId, accountId, hash) => {
        if (this.failCredential) throw new Error('database down');
        const row = this.rows.find((r) => r.account.id === accountId)!;
        row.passwordHash = hash;
      },
      recordConsents: async (_agencyId, accountId, consents) => {
        for (const consent of consents) this.consents.push({ accountId, consent });
      },
      appendEvent: async (event) => {
        this.events.push(event);
      },
    };
  }
}

function setup() {
  const store = new FakeStore();
  const service = new RegistrationService(store.db, () => new Date('2026-10-07T10:00:00Z'));
  return { store, service };
}

await test('opening the link creates one member, with a verified email and the hashed password', async () => {
  const { store, service } = setup();
  const result = await service.createVerified(agency, verified, 'req-1');
  assert.ok(result.created);
  assert.equal(result.account.role, 'member');
  assert.equal(result.account.displayName, 'Rahim');
  assert.equal(result.account.agencyId, agency);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]!.email, 'rahim@example.com');
  assert.equal(store.rows[0]!.locale, 'bn');
  assert.equal(store.rows[0]!.passwordHash, verified.passwordHash);
});

await test('the consents are recorded with the versions that were agreed to, not the current ones', async () => {
  const { store, service } = setup();
  const result = await service.createVerified(agency, verified, 'req-1');
  assert.ok(result.created);
  assert.deepEqual(
    store.consents.map((c) => c.consent),
    [
      { purpose: 'terms', documentVersion: 'terms-v1' },
      { purpose: 'privacy', documentVersion: 'privacy-v1' },
    ],
  );
  assert.ok(store.consents.every((c) => c.accountId === result.account.id));
});

await test('registering for someone else records that authority, under the terms version', async () => {
  const { store, service } = setup();
  await service.createVerified(
    agency,
    { ...verified, registration: { ...registration, onBehalfOfOther: true } },
    'r',
  );
  assert.deepEqual(
    store.consents.map((c) => c.consent),
    [
      { purpose: 'terms', documentVersion: 'terms-v1' },
      { purpose: 'privacy', documentVersion: 'privacy-v1' },
      { purpose: 'profile_representation', documentVersion: 'terms-v1' },
    ],
  );
});

await test('an event records who registered, with ids only', async () => {
  const { store, service } = setup();
  const result = await service.createVerified(agency, verified, 'req-42');
  assert.ok(result.created);
  assert.deepEqual(store.events, [
    {
      id: store.events[0]!.id,
      agencyId: agency,
      actorId: result.account.id,
      subjectId: result.account.id,
      type: 'account.registered',
      version: 1,
      occurredAt: '2026-10-07T10:00:00.000Z',
      correlationId: 'req-42',
    },
  ]);
});

await test('an email that already has an account never gets a second one, and its password is untouched', async () => {
  const { store, service } = setup();
  const existing = store.add(agency, 'rahim@example.com');
  assert.deepEqual(await service.createVerified(agency, verified, 'r'), { created: false });
  assert.equal(store.rows.length, 1);
  assert.equal(existing.passwordHash, 'existing');
  assert.equal(store.consents.length, 0);
  assert.equal(store.events.length, 0);
});

await test('an account in any status blocks the email, so a disabled member cannot be replaced', async () => {
  for (const status of ['invited', 'disabled'] as const) {
    const { store, service } = setup();
    store.add(agency, 'rahim@example.com', status);
    assert.deepEqual(await service.createVerified(agency, verified, 'r'), { created: false });
    assert.equal(store.rows.length, 1);
  }
});

await test('the same email at another agency is a different person', async () => {
  const { store, service } = setup();
  store.add(otherAgency, 'rahim@example.com');
  const result = await service.createVerified(agency, verified, 'r');
  assert.ok(result.created);
  assert.equal(store.rows.length, 2);
});

await test('losing a race to another request for the same email adds nothing', async () => {
  const { store, service } = setup();
  store.raceOnInsert = {
    agencyId: agency,
    account: { id: randomUUID(), agencyId: agency, role: 'member', displayName: 'Winner' },
    email: 'rahim@example.com',
    locale: 'bn',
    status: 'active',
    passwordHash: 'winner',
  };
  assert.deepEqual(await service.createVerified(agency, verified, 'r'), { created: false });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]!.passwordHash, 'winner');
  assert.equal(store.consents.length, 0);
  assert.equal(store.events.length, 0);
});

await test('if any part fails, nothing is left behind', async () => {
  const { store, service } = setup();
  store.failCredential = true;
  await assert.rejects(() => service.createVerified(agency, verified, 'r'), /database down/);
  assert.equal(store.rows.length, 0);
  assert.equal(store.consents.length, 0);
  assert.equal(store.events.length, 0);
});

await test('whether an email is registered says yes for any status and no for none', async () => {
  const { store, service } = setup();
  assert.equal(await service.emailRegistered(agency, 'rahim@example.com'), false);
  store.add(agency, 'rahim@example.com', 'disabled');
  assert.equal(await service.emailRegistered(agency, 'rahim@example.com'), true);
  assert.equal(await service.emailRegistered(otherAgency, 'rahim@example.com'), false);
});

await test('what is kept for the link records the document versions in force at registration', () => {
  const input = registrationInputSchema.parse({
    email: 'a@b.com',
    password: 'a long enough password',
    displayName: 'A',
    locale: 'en',
    acceptTerms: true,
    acceptPrivacy: true,
  });
  assert.deepEqual(toRegistration(input), {
    displayName: 'A',
    locale: 'en',
    onBehalfOfOther: false,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
  });
  assert.deepEqual(consentsFor(toRegistration(input)), [
    { purpose: 'terms', documentVersion: TERMS_VERSION },
    { purpose: 'privacy', documentVersion: PRIVACY_VERSION },
  ]);
});
