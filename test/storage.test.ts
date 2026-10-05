import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config/env.js';
import { createFileStorage } from '../src/storage/config/storage.js';
import { LocalFileStorage } from '../src/storage/repository/local-file-storage.js';
import { S3FileStorage, type S3Sender } from '../src/storage/repository/s3-file-storage.js';
import type { FileStorage } from '../src/storage/service/file-storage.js';
import { env } from './fixtures.js';

const KEY =
  '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/photo.full.webp';
const BYTES = Buffer.from([1, 2, 3, 4, 5]);

/**
 * What every storage must do, whichever one it is. Running the same checks against the local
 * disk and the S3 driver is what lets the application treat them as interchangeable.
 */
async function behavesLikeStorage(name: string, make: () => Promise<FileStorage>) {
  await test(`${name}: stores, returns and deletes a file`, async () => {
    const storage = await make();
    assert.equal(await storage.get(KEY), null);
    await storage.put(KEY, BYTES, 'image/webp');
    assert.deepEqual(await storage.get(KEY), BYTES);
    await storage.put(KEY, Buffer.from([9]), 'image/webp');
    assert.deepEqual(await storage.get(KEY), Buffer.from([9]), 'a second put replaces the file');
    await storage.delete(KEY);
    assert.equal(await storage.get(KEY), null);
  });

  await test(`${name}: deleting a file that is not there is not an error`, async () => {
    const storage = await make();
    await storage.delete(KEY);
    await storage.delete(KEY);
  });

  await test(`${name}: keys that could escape or confuse are refused`, async () => {
    const storage = await make();
    for (const key of [
      '../outside',
      'a/../../outside',
      '/absolute/path',
      'a//b',
      'a/b/',
      '',
      'a/./b',
      'a\\b',
      'with space',
      'null\0byte',
      'x'.repeat(301),
    ]) {
      await assert.rejects(storage.put(key, BYTES, 'image/webp'), /Unsafe storage key/, key);
      await assert.rejects(storage.get(key), /Unsafe storage key/, key);
      await assert.rejects(storage.delete(key), /Unsafe storage key/, key);
    }
  });
}

/** A stand-in for the AWS client: a bucket in memory that answers like S3 does. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string | undefined }>();
  const sent: unknown[] = [];
  const client: S3Sender = {
    send: (async (command: unknown) => {
      sent.push(command);
      if (command instanceof PutObjectCommand) {
        const { Key, Body, ContentType } = command.input;
        objects.set(`${command.input.Bucket}/${Key}`, { body: Body as Buffer, type: ContentType });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const found = objects.get(`${command.input.Bucket}/${command.input.Key}`);
        if (!found) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(found.body) } };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(`${command.input.Bucket}/${command.input.Key}`);
        return {};
      }
      throw new Error('unexpected command');
    }) as S3Sender['send'],
  };
  return { client, objects, sent };
}

const directory = await mkdtemp(join(tmpdir(), 'matrimony-storage-'));
await behavesLikeStorage(
  'local disk',
  async () => new LocalFileStorage(await mkdtemp(join(directory, 'run-'))),
);
await behavesLikeStorage('S3', async () => new S3FileStorage(fakeS3().client, 'photos-bucket'));

await test('local disk: nothing is left behind except the file, and files stay inside the folder', async () => {
  const root = await mkdtemp(join(directory, 'tidy-'));
  const storage: FileStorage = new LocalFileStorage(root);
  await storage.put(KEY, BYTES, 'image/webp');
  const folder = join(root, ...KEY.split('/').slice(0, -1));
  assert.deepEqual(await readdir(folder), ['photo.full.webp'], 'no temporary file remains');
  await rm(directory, { recursive: true, force: true });
});

await test('local disk: a folder that cannot be written to fails loudly and leaves no half file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matrimony-blocked-'));
  // A file where the folder should be makes the write impossible.
  await writeFile(join(root, KEY.split('/')[0]!), 'in the way');
  const storage: FileStorage = new LocalFileStorage(root);
  await assert.rejects(storage.put(KEY, BYTES, 'image/webp'));
  assert.equal(await storage.get(KEY), null);
  await rm(root, { recursive: true, force: true });
});

await test('S3: sends the bucket, the key and the type, and keeps the file private', async () => {
  const s3 = fakeS3();
  const storage = new S3FileStorage(s3.client, 'photos-bucket');
  await storage.put(KEY, BYTES, 'image/webp');
  const command = s3.sent[0] as PutObjectCommand;
  assert.equal(command.input.Bucket, 'photos-bucket');
  assert.equal(command.input.Key, KEY);
  assert.equal(command.input.ContentType, 'image/webp');
  assert.match(String(command.input.CacheControl), /^private/);
  assert.equal(command.input.ACL, undefined, 'never asks for a public file');
});

await test('S3: other failures are not mistaken for a missing file', async () => {
  const failing: S3Sender = {
    send: (async () => {
      throw Object.assign(new Error('denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
    }) as S3Sender['send'],
  };
  const storage = new S3FileStorage(failing, 'photos-bucket');
  await assert.rejects(storage.get(KEY), /denied/);
  await assert.rejects(storage.put(KEY, BYTES, 'image/webp'), /denied/);
});

await test('S3: a missing file is recognised by status as well as by name', async () => {
  const gone: S3Sender = {
    send: (async () => {
      throw Object.assign(new Error('gone'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
    }) as S3Sender['send'],
  };
  assert.equal(await new S3FileStorage(gone, 'photos-bucket').get(KEY), null);
});

await test('the configuration chooses the storage, and local disk is the default', () => {
  const local = createFileStorage(loadConfig(env));
  assert.ok(local instanceof LocalFileStorage);

  const s3 = createFileStorage(
    loadConfig({
      ...env,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'photos-bucket',
      S3_ENDPOINT: 'https://objects.example.com',
      S3_FORCE_PATH_STYLE: 'true',
    }),
  );
  assert.ok(s3 instanceof S3FileStorage);
});

await test('the configuration refuses storage settings that cannot work', () => {
  const invalid = (extra: Record<string, string>) =>
    assert.throws(() => loadConfig({ ...env, ...extra }), /Invalid configuration/);
  invalid({ STORAGE_DRIVER: 's3' });
  invalid({ STORAGE_DRIVER: 's3', S3_BUCKET: 'photos-bucket', S3_ACCESS_KEY_ID: 'only-one' });
  invalid({ STORAGE_DRIVER: 'ftp' });
  invalid({ STORAGE_DRIVER: 's3', S3_BUCKET: 'photos-bucket', S3_ENDPOINT: 'not a url' });
});

await test('production does not accept a local disk, which a second server could not see', () => {
  const production = {
    ...env,
    NODE_ENV: 'production',
    DB_SSL: 'verify-full',
    REDIS_URL: 'rediss://localhost:6379',
    MONGO_URL: 'mongodb+srv://example.invalid/',
  };
  assert.throws(() => loadConfig(production), /STORAGE_DRIVER/);
  assert.doesNotThrow(() =>
    loadConfig({ ...production, STORAGE_DRIVER: 's3', S3_BUCKET: 'photos-bucket' }),
  );
});
