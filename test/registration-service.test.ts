import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { Account } from '../src/bo/identity.js';
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
  consentsFor,
  registrationInputSchema,
  toRegistration,
  type ConsentRecord,
  type Registration,
} from '../src/bo/registration.js';
import type { FoundAccount } from '../src/db/raw/repository/registration-repository.js';
import type { RegistrationUnit } from '../src/db/service/registration-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { RegistrationService, type VerifiedIdentity } from '../src/service/registration-service.js';
import { agency, otherAgency } from './fixtures.js';

const ISSUER = 'https://issuer.example';
const registration: Registration = { displayName: 'Rahim', locale: 'bn', onBehalfOfOther: false };

interface Row {
  agencyId: string;
  account: Account;
  phone: string | null;
  issuer: string;
  subject: string;
  status: FoundAccount['status'];
}

/** An in-memory stand-in for one transaction's worth of account storage. */
class FakeStore {
  rows: Row[] = [];
  consents: { accountId: string; consent: ConsentRecord }[] = [];
  events: WorkflowEvent[] = [];
  /** Make the next insert lose a race with another request for the same identity. */
  raceOnInsert: Row | null = null;
  inserts = 0;

  db = {
    find: async (agencyId: string, issuer: string, subject: string) =>
      this.byIdentity(agencyId, issuer, subject),
    inTransaction: <T>(_agencyId: string, work: (unit: RegistrationUnit) => Promise<T>) =>
      work(this.unit()),
  };

  private byIdentity(agencyId: string, issuer: string, subject: string): FoundAccount | null {
    const row = this.rows.find(
      (r) => r.agencyId === agencyId && r.issuer === issuer && r.subject === subject,
    );
    return row ? { account: row.account, status: row.status } : null;
  }

  add(agencyId: string, row: Partial<Row> & { subject: string }) {
    const account: Account = {
      id: randomUUID(),
      agencyId,
      role: 'member',
      displayName: 'Existing',
    };
    const full: Row = { agencyId, account, phone: null, issuer: ISSUER, status: 'active', ...row };
    this.rows.push(full);
    return full;
  }

  unit(): RegistrationUnit {
    return {
      findBySubject: async (agencyId, issuer, subject) =>
        this.byIdentity(agencyId, issuer, subject),
      phoneTaken: async (agencyId, phone) =>
        this.rows.some((r) => r.agencyId === agencyId && r.phone === phone),
      createMember: async (agencyId, member) => {
        this.inserts += 1;
        if (this.raceOnInsert) {
          this.rows.push(this.raceOnInsert);
          this.raceOnInsert = null;
          return null;
        }
        const account: Account = {
          id: randomUUID(),
          agencyId,
          role: 'member',
          displayName: member.displayName,
        };
        this.rows.push({
          agencyId,
          account,
          phone: member.phone,
          issuer: member.issuer,
          subject: member.subject,
          status: 'active',
        });
        return account;
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

const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  issuer: ISSUER,
  subject: 'sms|abc',
  phone: '+8801712345678',
  ...over,
});

function setup() {
  const store = new FakeStore();
  const service = new RegistrationService(store.db, () => new Date('2026-10-06T10:00:00Z'));
  return { store, service };
}

const rejects = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `an AppError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

const valid = {
  displayName: 'Rahim Uddin',
  locale: 'bn',
  acceptTerms: true,
  acceptPrivacy: true,
};
const problems = (input: unknown) => {
  const result = registrationInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

await test('registration needs a name, a language and both agreements', () => {
  assert.deepEqual(problems(valid), []);
  assert.deepEqual(problems({ ...valid, displayName: '   ' }), ['displayName: required']);
  assert.deepEqual(problems({ ...valid, displayName: 'x'.repeat(101) }), ['displayName: tooLong']);
  assert.deepEqual(problems({ ...valid, locale: 'fr' }), ['locale: invalidOption']);
  assert.deepEqual(problems({ ...valid, acceptTerms: false }), ['acceptTerms: required']);
  assert.deepEqual(problems({ ...valid, acceptPrivacy: undefined }), ['acceptPrivacy: required']);
});

await test('registering for someone else needs the confirmation of authority', () => {
  assert.deepEqual(problems({ ...valid, onBehalfOfOther: true }), ['confirmAuthority: required']);
  assert.deepEqual(problems({ ...valid, onBehalfOfOther: true, confirmAuthority: true }), []);
});

await test('nothing can be smuggled in: no role, no phone, no extra fields', () => {
  for (const extra of [{ role: 'admin' }, { phone: '+8801700000000' }, { agencyId: agency }]) {
    assert.deepEqual(problems({ ...valid, ...extra }).length, 1, JSON.stringify(extra));
  }
});

await test('the agreements are recorded with the version of the text that was shown', () => {
  assert.deepEqual(consentsFor(registration), [
    { purpose: 'terms', documentVersion: TERMS_VERSION },
    { purpose: 'privacy', documentVersion: PRIVACY_VERSION },
  ]);
  const behalf = consentsFor({ ...registration, onBehalfOfOther: true });
  assert.deepEqual(
    behalf.map((c) => c.purpose),
    ['terms', 'privacy', 'profile_representation'],
  );
  const parsed = registrationInputSchema.parse(valid);
  assert.deepEqual(toRegistration(parsed), {
    displayName: 'Rahim Uddin',
    locale: 'bn',
    onBehalfOfOther: false,
  });
});

await test('registering creates a member with the verified phone, consents and an event, together', async () => {
  const { store, service } = setup();
  const account = await service.register(agency, identity(), registration, 'req-1');

  assert.equal(account.role, 'member');
  assert.equal(account.displayName, 'Rahim');
  assert.equal(account.agencyId, agency);
  assert.equal(store.rows[0]?.phone, '+8801712345678');
  assert.deepEqual(
    store.consents.map((c) => [c.accountId, c.consent.purpose]),
    [
      [account.id, 'terms'],
      [account.id, 'privacy'],
    ],
  );
  assert.equal(store.events[0]?.type, 'account.registered');
  assert.equal(store.events[0]?.actorId, account.id);
  assert.equal(store.events[0]?.correlationId, 'req-1');
});

await test('registering for someone else also records that consent', async () => {
  const { store, service } = setup();
  await service.register(agency, identity(), { ...registration, onBehalfOfOther: true }, 'c');
  assert.deepEqual(
    store.consents.map((c) => c.consent.purpose),
    ['terms', 'privacy', 'profile_representation'],
  );
});

await test('without a phone the provider verified, nothing is created', async () => {
  const { store, service } = setup();
  for (const phone of [undefined, '', '01712345678', '+0123', 'not a number']) {
    await rejects(
      service.register(agency, identity({ phone }), registration, 'c'),
      422,
      'REGISTRATION_PHONE_REQUIRED',
    );
  }
  assert.equal(store.rows.length, 0);
  assert.equal(store.events.length, 0);
});

await test('registering again with the same identity is a login: no second account, nothing re-recorded', async () => {
  const { store, service } = setup();
  const first = await service.register(agency, identity(), registration, 'c');
  const again = await service.register(agency, identity(), registration, 'c2');
  assert.equal(again.id, first.id);
  assert.equal(store.rows.length, 1);
  assert.equal(store.consents.length, 2);
  assert.equal(store.events.length, 1);
});

await test('a phone number that belongs to a different identity is refused, not linked', async () => {
  const { store, service } = setup();
  store.add(agency, { subject: 'auth0|staff', phone: '+8801712345678' });
  await rejects(
    service.register(agency, identity({ subject: 'sms|new' }), registration, 'c'),
    409,
    'PHONE_ALREADY_REGISTERED',
  );
  assert.equal(store.rows.length, 1);
  assert.equal(store.consents.length, 0);
});

await test('an existing account that cannot log in is never registered over', async () => {
  const { store, service } = setup();
  for (const status of ['invited', 'disabled'] as const) {
    store.rows = [];
    store.add(agency, { subject: 'sms|abc', status, phone: '+8801712345678' });
    await rejects(
      service.register(agency, identity(), registration, 'c'),
      403,
      'ACCOUNT_NOT_ACTIVE',
    );
  }
});

await test('two requests at once for one person end with one account', async () => {
  const { store, service } = setup();
  const winner = store.add(agency, { subject: 'sms|abc', phone: '+8801712345678' });
  // Both passed the first checks; this one loses the insert.
  store.raceOnInsert = null;
  const original = store.unit.bind(store);
  let first = true;
  store.unit = () => {
    const unit = original();
    const find = unit.findBySubject;
    unit.findBySubject = async (...args) => {
      // The first look finds nothing (the winner has not committed yet).
      if (first) {
        first = false;
        return null;
      }
      return find(...args);
    };
    unit.phoneTaken = async () => false;
    unit.createMember = async () => null;
    return unit;
  };
  const account = await service.register(agency, identity(), registration, 'c');
  assert.equal(account.id, winner.account.id);
  assert.equal(store.rows.length, 1);
  assert.equal(store.consents.length, 0, 'the winner recorded its own');
});

await test('the same phone can have a separate account at another agency', async () => {
  const { store, service } = setup();
  await service.register(agency, identity(), registration, 'c');
  const other = await service.register(otherAgency, identity(), registration, 'c');
  assert.equal(other.agencyId, otherAgency);
  assert.equal(store.rows.length, 2);
});
