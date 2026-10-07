import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argon2Sync } from 'node:crypto';
import { PasswordHasher } from '../src/security/password-hasher.js';

// Cheap settings so the suite stays fast. The real defaults are checked once, below.
const fast = new PasswordHasher({ memory: 64, passes: 1, parallelism: 1 });

await test('a password verifies against its own hash and no other', async () => {
  const hash = await fast.hash('correct horse battery');
  assert.equal(await fast.verify('correct horse battery', hash), true);
  assert.equal(await fast.verify('correct horse battery!', hash), false);
  assert.equal(await fast.verify('', hash), false);
});

await test('every hash has its own salt, so equal passwords give different hashes', async () => {
  const [a, b] = await Promise.all([fast.hash('same password'), fast.hash('same password')]);
  assert.notEqual(a, b);
  assert.equal(await fast.verify('same password', a), true);
  assert.equal(await fast.verify('same password', b), true);
});

await test('the stored value is a standard Argon2id string that holds its own settings', async () => {
  const hash = await fast.hash('whatever password');
  assert.match(hash, /^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.equal(hash.includes('whatever'), false);
});

await test('the stored salt and tag are what a plain Argon2id computation gives', async () => {
  // Decode the stored string and recompute the tag with Node's own Argon2id: the same salt,
  // password and settings must give the same tag, so nothing non-standard is hidden in the encoding.
  const hash = await fast.hash('a password to recompute');
  const [, , , params, salt, tag] = hash.split('$');
  assert.equal(params, 'm=64,t=1,p=1');
  const expected = argon2Sync('argon2id', {
    message: Buffer.from('a password to recompute'),
    nonce: Buffer.from(salt!, 'base64'),
    memory: 64,
    passes: 1,
    parallelism: 1,
    tagLength: 32,
  });
  assert.equal(expected.toString('base64').replace(/=+$/, ''), tag);
});

await test('Bengali and other non-Latin passwords work', async () => {
  const hash = await fast.hash('আমার সোনার বাংলা ১২৩');
  assert.equal(await fast.verify('আমার সোনার বাংলা ১২৩', hash), true);
  assert.equal(await fast.verify('আমার সোনার বাংলা ১২৪', hash), false);
});

await test('a malformed or hostile stored value never matches and never throws', async () => {
  for (const stored of [
    '',
    'plain-text-password',
    '$argon2i$v=19$m=64,t=1,p=1$c29tZXNhbHQ$aGFzaA',
    '$argon2id$v=19$m=64,t=1,p=1$c29tZXNhbHQ',
    // Asks for 4 TiB of memory: refused before any work is done.
    '$argon2id$v=19$m=4294967295,t=1,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=19$m=64,t=4000000,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA',
  ]) {
    assert.equal(await fast.verify('password', stored), false, stored);
  }
});

await test('a hash made with weaker settings is marked for an upgrade, a current one is not', async () => {
  const weak = await new PasswordHasher({ memory: 32, passes: 1, parallelism: 1 }).hash(
    'a password',
  );
  assert.equal(fast.needsRehash(weak), true);
  assert.equal(fast.needsRehash(await fast.hash('a password')), false);
  assert.equal(fast.needsRehash('not a hash'), true);
});

await test('an unknown email costs the same work as a real check and can never succeed', async () => {
  assert.equal(await fast.verifyAgainstNothing('anything at all'), false);
  assert.equal(await fast.verifyAgainstNothing(''), false);
});

await test('the production settings meet the OWASP minimum and verify', async () => {
  const real = new PasswordHasher();
  const hash = await real.hash('a production password');
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await real.verify('a production password', hash), true);
  assert.equal(real.needsRehash(hash), false);
});
