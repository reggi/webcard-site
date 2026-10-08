import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { persistCard } from '../scripts/persist-card.js';
import { cardID, digest, jsonBytes } from '../src/webcard/format.js';
import { readCollection, saveCard } from '../src/webcard/collection.js';
import { archive, temporaryCollection } from './helpers.js';

test('artifact persistence merges unrelated additions and rejects stale same-card refresh', async (t) => {
  const { root, cards } = await temporaryCollection();
  t.after(() => rm(root, { recursive: true }));
  const artifact = join(root, 'artifact');
  await mkdir(artifact);
  const url = 'https://example.com/';
  const id = cardID(url);
  await writeFile(join(artifact, 'result.json'), jsonBytes({ id, sourceURL: url, addedAt: '2026-01-01T00:00:00.000Z', previousDigest: null, status: 'added' }));
  await writeFile(join(artifact, `${id}.webcard`), await archive());
  await saveCard(cards, 'https://unrelated.example/', () => archive({ url: 'https://unrelated.example/' }));
  await persistCard(cards, artifact);
  assert.equal((await readCollection(cards)).length, 2);
  const bytes = await readFile(join(cards, `${id}.webcard`));
  await writeFile(join(artifact, 'result.json'), jsonBytes({ id, sourceURL: url, addedAt: '2026-01-01T00:00:00.000Z', previousDigest: digest(bytes), status: 'refreshed' }));
  await saveCard(cards, url, (previous) => archive({ previous, title: 'Concurrent refresh', date: new Date('2026-01-04') }), { refresh: true });
  await assert.rejects(persistCard(cards, artifact), /changed during capture/);
});
