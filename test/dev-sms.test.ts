import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { loadConfig } from '../src/config/env.js';
import { buildApp } from '../src/controller/app.js';
import {
  agency,
  config,
  env,
  unusedPhotos,
  unusedReviews,
  unusedClients,
  unusedProfiles,
} from './fixtures.js';

const SECRET = 'a-long-development-only-secret-0123456789';
const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

async function setup(withSink = true, nodeEnv: 'development' | 'production' = 'development') {
  const printed: string[] = [];
  const unused = async () => {
    throw new Error('unused');
  };
  const app = await buildApp({
    config: { ...config, NODE_ENV: nodeEnv },
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    photos: unusedPhotos,
    reviews: unusedReviews,
    clients: unusedClients,
    ...(withSink
      ? { devSms: { secret: SECRET, write: (line: string) => printed.push(line) } }
      : {}),
    identities: {
      tenant: async () => ({
        id: agency,
        hostname: 'localhost',
        name: 'MSBD',
        locale: 'bn',
        publicConfig: { branches: [], successStories: [] },
      }),
    },
    auth: {
      authenticate: unused,
      begin: unused,
      beginRegistration: unused,
      complete: unused,
      bootstrap: unused,
      refresh: unused,
      logout: async () => {},
    },
  });
  // The identity provider calls this from the internet: its Host is the tunnel's, not an agency's.
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/dev/sms',
      payload: body as object,
      headers: { host: 'random-name.trycloudflare.com', ...headers },
    });
  return { app, send, printed };
}

const message = { recipient: '+8801712345678', text: 'Your code is 482913' };

await test("the provider's message is printed for the developer, with no agency and no sign-in", async (t) => {
  const { app, send, printed } = await setup();
  t.after(() => app.close());
  const res = await send(message, { 'x-dev-sms-secret': SECRET });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(printed, ['[dev sms] to +8801712345678: Your code is 482913']);
});

await test('without the secret it looks like the route does not exist, and prints nothing', async (t) => {
  const { app, send, printed } = await setup();
  t.after(() => app.close());
  const wrong: Record<string, string>[] = [
    {},
    { 'x-dev-sms-secret': 'wrong' },
    { 'x-dev-sms-secret': SECRET.slice(0, -1) },
    { 'x-dev-sms-secret': `${SECRET}x` },
    { authorization: 'Bearer valid.jwt.token' },
  ];
  for (const headers of wrong) {
    const res = await send(message, headers);
    assert.equal(res.statusCode, 404, JSON.stringify(headers));
    assert.equal(res.json().error.code, 'NOT_FOUND');
  }
  assert.deepEqual(printed, []);
});

await test('it accepts only a recipient and a text, and cannot rewrite the terminal', async (t) => {
  const { app, send, printed } = await setup();
  t.after(() => app.close());
  const headers = { 'x-dev-sms-secret': SECRET };
  assert.equal((await send({ ...message, extra: 1 }, headers)).statusCode, 400);
  assert.equal((await send({ recipient: '', text: 'x' }, headers)).statusCode, 400);
  assert.equal((await send({ recipient: 'x'.repeat(33), text: 'x' }, headers)).statusCode, 400);
  assert.equal(
    (await send({ recipient: '+88017', text: 'x'.repeat(501) }, headers)).statusCode,
    400,
  );
  assert.deepEqual(printed, []);

  await send(
    { recipient: '+8801700000000', text: 'code 1\n[dev sms] to +880: forged\u001b[2J' },
    headers,
  );
  assert.equal(printed.length, 1);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(printed[0]!), 'no line breaks or escape codes');
});

await test('it does not exist unless it is configured', async (t) => {
  const { app, send } = await setup(false);
  t.after(() => app.close());
  const res = await send(message, { 'x-dev-sms-secret': SECRET });
  // Like any unknown path in this API: refused, never answered with a 204.
  assert.ok([401, 404].includes(res.statusCode), String(res.statusCode));
});

await test('it is never served in production, even if a sink is passed in', async (t) => {
  const { app, send, printed } = await setup(true, 'production');
  t.after(() => app.close());
  const res = await send(message, { 'x-dev-sms-secret': SECRET });
  assert.notEqual(res.statusCode, 204);
  assert.deepEqual(printed, []);
});

await test('the configuration refuses a weak secret and refuses the sink in production', () => {
  assert.doesNotThrow(() => loadConfig({ ...env, DEV_SMS_SINK_SECRET: SECRET }));
  assert.throws(() => loadConfig({ ...env, DEV_SMS_SINK_SECRET: 'short' }), /DEV_SMS_SINK_SECRET/);

  const production = {
    ...env,
    NODE_ENV: 'production',
    DB_SSL: 'verify-full',
    REDIS_URL: 'rediss://localhost:6379',
    MONGO_URL: 'mongodb+srv://example.invalid/',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'photos-bucket',
  };
  assert.doesNotThrow(() => loadConfig(production));
  assert.throws(
    () => loadConfig({ ...production, DEV_SMS_SINK_SECRET: SECRET }),
    /DEV_SMS_SINK_SECRET/,
  );
});
