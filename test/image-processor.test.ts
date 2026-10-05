import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { AppError } from '../src/exception/app-error.js';
import { processImage } from '../src/security/image-processor.js';

/** A plain picture of the given size, as a file of the given format. */
const picture = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' | 'gif' = 'jpeg') =>
  sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 60 } } })
    [format]()
    .toBuffer();

const refused = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, 'an AppError');
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

await test('every accepted format comes out as WebP in two sizes', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const result = await processImage(await picture(800, 600, format));
    assert.equal((await sharp(result.full).metadata()).format, 'webp', format);
    assert.equal((await sharp(result.thumb).metadata()).format, 'webp', format);
  }
});

await test('large pictures are scaled down, small ones are never enlarged', async () => {
  const big = await processImage(await picture(4000, 3000));
  const full = await sharp(big.full).metadata();
  const thumb = await sharp(big.thumb).metadata();
  assert.deepEqual([full.width, full.height], [1600, 1200]);
  assert.deepEqual([thumb.width, thumb.height], [400, 300]);

  const small = await processImage(await picture(300, 500));
  const kept = await sharp(small.full).metadata();
  assert.deepEqual([kept.width, kept.height], [300, 500]);
  const smallThumb = await sharp(small.thumb).metadata();
  assert.deepEqual([smallThumb.width, smallThumb.height], [240, 400]);
});

await test('location and camera details are removed', async () => {
  const withExif = await sharp({
    create: { width: 600, height: 600, channels: 3, background: '#888888' },
  })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-owner', Make: 'SecretCamera' } })
    .toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif, 'the test file does carry EXIF');
  assert.ok(withExif.includes(Buffer.from('secret-owner')));

  const result = await processImage(withExif);
  for (const bytes of [result.full, result.thumb]) {
    assert.equal((await sharp(bytes).metadata()).exif, undefined);
    assert.ok(!bytes.includes(Buffer.from('secret-owner')));
    assert.ok(!bytes.includes(Buffer.from('SecretCamera')));
  }
});

await test('the photo is turned the way the camera said, so it still looks right', async () => {
  // Stored sideways (600 wide, 300 tall) with an instruction to turn it a quarter.
  const sideways = await sharp({
    create: { width: 600, height: 300, channels: 3, background: '#888888' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const result = await processImage(sideways);
  const meta = await sharp(result.full).metadata();
  assert.deepEqual([meta.width, meta.height], [300, 600]);
});

await test('a file is judged by its bytes, not by what it is called', async () => {
  await refused(processImage(await picture(400, 400, 'gif')), 415, 'PHOTO_TYPE_UNSUPPORTED');
  await refused(
    processImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"></svg>'),
    ),
    415,
    'PHOTO_TYPE_UNSUPPORTED',
  );
});

await test('things that are not pictures are refused', async () => {
  await refused(processImage(Buffer.from('just some text, not a picture')), 422, 'PHOTO_INVALID');
  await refused(processImage(Buffer.alloc(0)), 422, 'PHOTO_INVALID');
  await refused(processImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), 422, 'PHOTO_INVALID');
});

await test('a damaged picture is refused instead of crashing', async () => {
  const good = await picture(600, 600, 'png');
  const damaged = Buffer.concat([good.subarray(0, 60), Buffer.alloc(200, 7)]);
  await refused(processImage(damaged), 422, 'PHOTO_INVALID');
});

await test('a picture too small to recognise a face is refused', async () => {
  await refused(processImage(await picture(150, 150)), 422, 'PHOTO_TOO_SMALL');
  await refused(processImage(await picture(2000, 100)), 422, 'PHOTO_TOO_SMALL');
  await processImage(await picture(200, 200));
});

await test('a small file that expands into an enormous picture is refused', async () => {
  // Compresses to a few kilobytes but would need hundreds of megabytes to open.
  const bomb = await sharp({
    create: { width: 12000, height: 12000, channels: 3, background: '#000000' },
    limitInputPixels: false,
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  assert.ok(bomb.length < 5 * 1024 * 1024, 'small enough to be uploaded');
  await refused(processImage(bomb), 422, 'PHOTO_INVALID');
});
