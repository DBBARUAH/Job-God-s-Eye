import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'finance-store-test-'));
  const stores = [];
  t.after(async () => {
    try {
      for (const store of stores) await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const create = () => {
    const store = new Store(directory);
    stores.push(store);
    return store;
  };
  return { directory, create, store: await create().init() };
}

const record = (overrides = {}) => ({
  kind: 'job', url: 'https://example.com/jobs/1', title: 'Financial Analyst',
  text: 'Financial Analyst at Example Corp.', observedAt: '2026-01-01T12:00:00Z',
  ...overrides,
});

test('fresh stores persist preferences, boards and records across reopen', async t => {
  const { store, create, directory } = await fixture(t);
  assert.equal(store.snapshot().version, 1);
  assert.deepEqual(store.snapshot().records, []);
  assert.deepEqual(store.snapshot().boards, []);
  await store.mutate(data => {
    data.preferences.graduationDate = '2026-05-15';
    data.boards.push({ provider: 'lever', identifier: 'example' });
  });
  const saved = await store.upsert(record());
  assert.match(saved.id, /^[a-f0-9]{24}$/);
  const expected = store.snapshot();
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'records.json'), 'utf8')), expected);
  await store.close();
  assert.deepEqual((await create().init()).snapshot(), expected);
  assert.deepEqual((await readdir(directory)).sort(), ['records.json', 'store.lock']);
});

test('upsert removes tracking and fragments, updates duplicates, and separates kinds', async t => {
  const { store } = await fixture(t);
  const first = await store.upsert(record({ url: 'https://example.com/jobs/1?utm_source=a&trk=b&trackingId=c&refId=d#top' }));
  assert.equal(first.url, 'https://example.com/jobs/1');
  const updated = await store.upsert(record({ title: 'Updated analyst', url: 'https://example.com/jobs/1?utm_medium=email#other' }));
  assert.equal(updated.id, first.id);
  assert.equal(store.snapshot().records.length, 1);
  assert.equal(store.snapshot().records[0].title, 'Updated analyst');
  const contact = await store.upsert(record({ kind: 'contact' }));
  assert.notEqual(contact.id, first.id);
  const distinctQuery = await store.upsert(record({ url: 'https://example.com/jobs/1?posting=2' }));
  assert.notEqual(distinctQuery.id, first.id, 'Non-tracking query parameters identify distinct records');
  assert.equal(store.snapshot().records.length, 3);
});

test('delete via mutation is persisted and a repeated delete is harmless', async t => {
  const { store, create } = await fixture(t);
  const saved = await store.upsert(record());
  const remove = () => store.mutate(data => {
    const before = data.records.length;
    data.records = data.records.filter(item => item.id !== saved.id);
    return before !== data.records.length;
  });
  assert.equal(await remove(), true);
  assert.equal(await remove(), false);
  await store.close();
  assert.deepEqual((await create().init()).snapshot().records, []);
});

test('snapshots and mutation return values cannot mutate live state', async t => {
  const { store } = await fixture(t);
  const saved = await store.upsert(record());
  saved.title = 'Changed outside store';
  const snapshot = store.snapshot();
  snapshot.records.length = 0;
  snapshot.preferences.roles.length = 0;
  assert.equal(store.snapshot().records[0].title, 'Financial Analyst');
  assert.ok(store.snapshot().preferences.roles.length > 0);
});

test('queued concurrent upserts do not lose records; failed mutations roll back', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.upsert(record({ url: `https://example.com/jobs/${i}` }))));
  assert.equal(store.snapshot().records.length, 12);
  const before = store.snapshot();
  await assert.rejects(store.mutate(data => {
    data.records = [];
    throw new Error('Deliberate operation failure');
  }), /Deliberate operation failure/);
  assert.deepEqual(store.snapshot(), before);
  await store.upsert(record({ url: 'https://example.com/jobs/next' }));
  assert.equal(store.snapshot().records.length, 13);
});

test('exclusive lock rejects competing stores without removing the active lock', async t => {
  const { store, create, directory } = await fixture(t);
  const lockPath = path.join(directory, 'store.lock');
  assert.equal(await readFile(lockPath, 'utf8'), String(process.pid));
  const competitor = create();
  await assert.rejects(competitor.init(), /already locked/);
  await competitor.close();
  assert.equal(await readFile(lockPath, 'utf8'), String(process.pid));
  await store.close();
  await store.close();
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  await assert.rejects(store.mutate(() => {}), /Store is closed/);
  const replacement = await create().init();
  await replacement.upsert(record());
});

test('close drains pending writes before releasing its lock', async t => {
  const { store, create, directory } = await fixture(t);
  const writes = Array.from({ length: 5 }, (_, i) => store.upsert(record({ url: `https://example.com/jobs/${i}` })));
  await store.close();
  await Promise.all(writes);
  await assert.rejects(readFile(path.join(directory, 'store.lock')), { code: 'ENOENT' });
  assert.equal((await create().init()).snapshot().records.length, 5);
});

for (const [name, raw] of [
  ['invalid JSON', '{not valid JSON\n'],
  ['unsupported version', JSON.stringify({ version: 2, preferences: {}, boards: [], records: [] })],
  ['malformed record collection', JSON.stringify({ version: 1, preferences: {}, boards: [], records: {} })],
  ['missing preferences', JSON.stringify({ version: 1, boards: [], records: [] })],
]) {
  test(`corrupt preservation: ${name} is not overwritten and init releases its lock`, async t => {
    const { store, create, directory } = await fixture(t);
    await store.close();
    const file = path.join(directory, 'records.json');
    await writeFile(file, raw);
    await assert.rejects(create().init());
    assert.equal(await readFile(file, 'utf8'), raw);
    await assert.rejects(readFile(path.join(directory, 'store.lock')), { code: 'ENOENT' });
    await assert.rejects(create().init());
    assert.equal(await readFile(file, 'utf8'), raw);
    assert.deepEqual(await readdir(directory), ['records.json']);
  });
}
