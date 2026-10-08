import assert from 'node:assert/strict';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readCollection, saveCard } from '../src/webcard/collection.js';
import { archive, temporaryCollection } from './helpers.js';

test('cache skips capture, refresh keeps added order and preserves old versions', async (t) => {
  const { root, cards } = await temporaryCollection();
  t.after(() => rm(root, { recursive: true }));
  let calls = 0;
  const capture = (previous) => { calls++; return archive({ previous }); };
  const first = await saveCard(cards, 'https://example.com/', capture, { date: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(first.status, 'added');
  const cached = await saveCard(cards, 'https://example.com/', capture);
  assert.equal(cached.status, 'cached');
  assert.equal(calls, 1);
  await saveCard(cards, 'https://example.org/', () => archive({ url: 'https://example.org/' }), { date: new Date('2026-01-02T00:00:00.000Z') });
  await saveCard(cards, 'https://example.com/', (previous) => archive({ previous, title: 'new title', date: new Date('2026-01-03') }), { refresh: true });
  const collection = await readCollection(cards);
  assert.equal(collection[0].sourceURL, 'https://example.org/');
  assert.equal(collection[1].addedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(collection[1].archive.root.captures.length, 2);
});

test('failed refresh leaves existing archive and manifest untouched', async (t) => {
  const { root, cards } = await temporaryCollection();
  t.after(() => rm(root, { recursive: true }));
  const result = await saveCard(cards, 'https://example.com/', () => archive());
  const original = await readFile(join(cards, `${result.id}.webcard`));
  const index = await readFile(join(cards, 'collection.json'));
  await assert.rejects(saveCard(cards, 'https://example.com/', () => { throw new Error('capture failed'); }, { refresh: true }), /capture failed/);
  assert.ok(original.equals(await readFile(join(cards, `${result.id}.webcard`))));
  assert.ok(index.equals(await readFile(join(cards, 'collection.json'))));
  await assert.rejects(saveCard(cards, 'https://example.org/', () => Buffer.from('invalid')));
  assert.equal((await readCollection(cards)).length, 1);
});

test('corrupt cache and symlinks fail rather than triggering network capture', async (t) => {
  const { root, cards } = await temporaryCollection();
  t.after(() => rm(root, { recursive: true }));
  const result = await saveCard(cards, 'https://example.com/', () => archive());
  const path = join(cards, `${result.id}.webcard`);
  await writeFile(path, Buffer.from('corrupt'));
  await assert.rejects(saveCard(cards, 'https://example.com/', () => assert.fail('should never capture')));
  await rm(path);
  await writeFile(join(root, 'external.webcard'), await archive());
  await symlink(join(root, 'external.webcard'), path);
  await assert.rejects(readCollection(cards), /invalid archive file/);
});
