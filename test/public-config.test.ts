import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicConfig } from '../src/bo/public-config.js';
import { mapTenant } from '../src/db/raw/mapper/identity.js';

const empty = { branches: [], successStories: [] };

await test('a complete config is kept as written', () => {
  const config = parsePublicConfig({
    name: 'MSBD',
    branding: { logoUrl: 'https://cdn.example.com/logo.svg', primaryColor: '#0f766e' },
    contact: { phone: '+880 1700-000000', email: 'hello@example.com' },
    home: { title: { bn: 'শিরোনাম', en: 'Title' }, subtitle: { en: 'Subtitle' } },
    about: { bn: 'পরিচিতি' },
    branches: [
      { name: { en: 'Dhaka' }, address: { en: 'Road 1' }, mapUrl: 'https://maps.example.com/x' },
    ],
    successStories: [{ names: { en: 'A and B' }, story: { en: 'Met here' }, year: 2025 }],
  });
  assert.equal(config.branding?.primaryColor, '#0f766e');
  assert.equal(config.branches.length, 1);
  assert.equal(config.successStories[0]?.year, 2025);
  assert.equal(config.home?.title?.bn, 'শিরোনাম');
});

await test('the minimal config of a fresh development database is valid', () => {
  assert.deepEqual(parsePublicConfig({ name: 'MSBD', branches: [], successStories: [] }), {
    name: 'MSBD',
    ...empty,
  });
});

await test('anything that is not an object becomes an empty config', () => {
  for (const value of [{}, null, undefined, 'text', 42, []]) {
    assert.deepEqual(parsePublicConfig(value), empty);
  }
});

await test('a color that could inject CSS is dropped without losing the other fields', () => {
  for (const bad of ['red', '#fff', '#12345g', '#0f766e; background:url(//evil.test)', 'url(x)']) {
    const config = parsePublicConfig({
      name: 'MSBD',
      branding: { primaryColor: bad, logoUrl: '/logo.png' },
    });
    assert.equal(config.branding?.primaryColor, undefined);
    assert.equal(config.branding?.logoUrl, '/logo.png');
    assert.equal(config.name, 'MSBD');
  }
});

await test('logos and map links accept only https addresses or site paths', () => {
  for (const bad of [
    'http://x.test/a.png',
    'javascript:alert(1)',
    'data:image/svg+xml,x',
    '//evil.test/a.png',
    'ftp://x.test',
  ]) {
    assert.equal(parsePublicConfig({ branding: { logoUrl: bad } }).branding?.logoUrl, undefined);
    assert.equal(
      parsePublicConfig({ branches: [{ name: { en: 'A' }, mapUrl: bad }] }).branches[0]?.mapUrl,
      undefined,
    );
  }
});

await test('valid branches and stories are kept, broken ones dropped, and the limits enforced', () => {
  const config = parsePublicConfig({
    branches: [
      { name: { en: 'A' } },
      'not a branch',
      { name: { en: 'B' } },
      { name: { en: 'C' } },
      { name: { en: 'D' } },
    ],
    successStories: Array.from({ length: 9 }, (_, i) => ({ names: { en: `Couple ${i}` } })),
  });
  assert.deepEqual(
    config.branches.map((b) => b.name.en),
    ['A', 'B', 'C'],
  );
  assert.equal(config.successStories.length, 6);
});

await test('unknown fields are removed so nothing unplanned reaches the public response', () => {
  const config = parsePublicConfig({ name: 'MSBD', secretToken: 'x', branding: { evil: true } });
  assert.equal('secretToken' in config, false);
  assert.equal('evil' in (config.branding ?? {}), false);
});

await test('hostile input never throws', () => {
  assert.doesNotThrow(() =>
    parsePublicConfig({ branches: 'x', successStories: 5, branding: 7, contact: [], home: 'x' }),
  );
});

await test('the tenant mapper cleans the stored config before it can be served', () => {
  const tenant = mapTenant({
    id: '11111111-1111-4111-8111-111111111111',
    hostname: 'localhost',
    name: 'MSBD',
    default_locale: 'bn',
    public_config: { branding: { primaryColor: 'red; x' }, password: 'hunter2' },
  });
  assert.equal(tenant.publicConfig.branding?.primaryColor, undefined);
  assert.equal('password' in tenant.publicConfig, false);
  assert.deepEqual(tenant.publicConfig.branches, []);
  assert.deepEqual(tenant.publicConfig.successStories, []);
});
