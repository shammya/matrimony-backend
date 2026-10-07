import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import sharp from 'sharp';
import type { Redis } from 'ioredis';
import { MAX_UPLOAD_BYTES, type PhotoList } from '../src/bo/photo.js';
import { buildApp } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import {
  account,
  agency,
  config,
  unusedClients,
  unusedProfiles,
  unusedReviews,
  authFor,
  unusedAccess,
} from './fixtures.js';

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

const empty: PhotoList = { photos: [], limit: 5 };
const PHOTO = '44444444-4444-4444-8444-444444444444';

async function setup(role: 'member' | 'agent' = 'member') {
  const calls: { name: string; actor: ProfileActor; args: unknown[] }[] = [];
  const record =
    (name: string, result: unknown = empty) =>
    async (actor: ProfileActor, ...args: unknown[]) => {
      calls.push({ name, actor, args });
      if (result instanceof Error) throw result;
      return result as PhotoList;
    };
  const image = await sharp({
    create: { width: 300, height: 300, channels: 3, background: '#336699' },
  })
    .webp()
    .toBuffer();
  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    reviews: unusedReviews,
    clients: unusedClients,
    photos: {
      list: record('list'),
      upload: record('upload'),
      remove: record('remove'),
      makePrimary: record('makePrimary', new AppError(409, 'PHOTO_NOT_APPROVED')),
      image: async (actor, photoId, size) => {
        calls.push({ name: 'image', actor, args: [photoId, size] });
        return image;
      },
    },
    registrations: { signInMethods: async () => null },
    identities: {
      tenant: async () => ({
        id: agency,
        hostname: 'localhost',
        name: 'MSBD',
        locale: 'bn',
        publicConfig: { branches: [], successStories: [] },
      }),
    },
    auth: authFor(async () => ({ ...account, role })),
    access: unusedAccess,
  });
  const call = (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    options: { payload?: Buffer | string; type?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      payload: options.payload,
      headers: {
        host: 'localhost',
        authorization: 'Bearer valid.jwt.token',
        ...(options.type ? { 'content-type': options.type } : {}),
      },
    });
  return { app, call, calls, image };
}

await test('photo routes are for signed-in members only', async (t) => {
  const { app, call } = await setup('agent');
  t.after(() => app.close());
  for (const [method, url] of [
    ['GET', '/api/v1/me/profile/photos'],
    ['POST', '/api/v1/me/profile/photos'],
    ['PUT', `/api/v1/me/profile/photos/${PHOTO}/primary`],
    ['DELETE', `/api/v1/me/profile/photos/${PHOTO}`],
    ['GET', `/api/v1/me/profile/photos/${PHOTO}/image`],
  ] as const) {
    const res = await call(method, url, { payload: Buffer.from([1]), type: 'image/png' });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  const anonymous = await app.inject({
    url: '/api/v1/me/profile/photos',
    headers: { host: 'localhost' },
  });
  assert.equal(anonymous.statusCode, 401);
});

await test('an image is accepted as the request body and the agency and account come from the session', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const bytes = Buffer.from('pretend these are the picture bytes');
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    const res = await call('POST', '/api/v1/me/profile/photos', { payload: bytes, type });
    assert.equal(res.statusCode, 201, type);
    assert.deepEqual(res.json(), empty);
  }
  const upload = calls.at(-1)!;
  assert.equal(upload.actor.agencyId, agency);
  assert.equal(upload.actor.accountId, account.id);
  assert.deepEqual(upload.args[0], bytes);
  assert.equal(typeof upload.args[1], 'string', 'the request id travels as the correlation id');
});

await test('anything that is not an image is refused before it reaches the service', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const refused = async (type: string | undefined, payload: Buffer | string, status: number) => {
    const res = await call('POST', '/api/v1/me/profile/photos', { payload, type });
    assert.equal(res.statusCode, status, String(type));
    return res.json().error.code as string;
  };
  assert.equal(await refused('text/plain', 'hello', 415), 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(await refused('image/gif', Buffer.from([1]), 415), 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(await refused('image/svg+xml', '<svg/>', 415), 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(
    await refused('application/octet-stream', Buffer.from([1]), 415),
    'UNSUPPORTED_MEDIA_TYPE',
  );
  // A JSON body is readable to the server but is not a picture.
  assert.equal(await refused('application/json', '{"a":1}', 415), 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(calls.length, 0);
});

await test('a picture over the size limit is refused with a clear code, a small one is not', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const big = await call('POST', '/api/v1/me/profile/photos', {
    payload: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1),
    type: 'image/jpeg',
  });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(calls.length, 0);

  const ok = await call('POST', '/api/v1/me/profile/photos', {
    payload: Buffer.alloc(MAX_UPLOAD_BYTES, 1),
    type: 'image/jpeg',
  });
  assert.equal(ok.statusCode, 201);
});

await test('other routes still refuse a body larger than the general limit', async (t) => {
  const { app, call } = await setup();
  t.after(() => app.close());
  const res = await call('PUT', `/api/v1/me/profile/photos/${PHOTO}/primary`, {
    payload: Buffer.alloc(1024 * 1024 + 10, 1),
    type: 'image/jpeg',
  });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500);
});

await test('the picture comes back as an image the owner may keep privately', async (t) => {
  const { app, call, calls, image } = await setup();
  t.after(() => app.close());
  const res = await call('GET', `/api/v1/me/profile/photos/${PHOTO}/image?size=thumb`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.match(String(res.headers['cache-control']), /^private/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.rawPayload, image);
  assert.deepEqual(calls.at(-1)?.args, [PHOTO, 'thumb']);

  await call('GET', `/api/v1/me/profile/photos/${PHOTO}/image`);
  assert.deepEqual(calls.at(-1)?.args, [PHOTO, 'full'], 'full size is the default');
});

await test('bad ids and sizes are refused', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  assert.equal((await call('GET', '/api/v1/me/profile/photos/not-an-id/image')).statusCode, 400);
  assert.equal(
    (await call('GET', `/api/v1/me/profile/photos/${PHOTO}/image?size=huge`)).statusCode,
    400,
  );
  assert.equal((await call('DELETE', '/api/v1/me/profile/photos/..%2F..%2Fetc')).statusCode, 400);
  assert.equal(calls.length, 0);
});

await test('service errors keep their status and code', async (t) => {
  const { app, call } = await setup();
  t.after(() => app.close());
  const res = await call('PUT', `/api/v1/me/profile/photos/${PHOTO}/primary`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'PHOTO_NOT_APPROVED');
});

await test('the response never contains storage details', async (t) => {
  const { app, call } = await setup();
  t.after(() => app.close());
  const res = await call('GET', '/api/v1/me/profile/photos');
  assert.deepEqual(Object.keys(res.json()).sort(), ['limit', 'photos']);
});
