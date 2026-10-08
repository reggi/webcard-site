import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cardID, digest, parseJSON, readArchive } from '../src/webcard/format.js';
import { loadCollection, saveCard } from '../src/webcard/collection.js';

export async function persistCard(directory, artifact) {
  const result = parseJSON(await readFile(join(artifact, 'result.json')), 'capture result');
  if (result?.id !== cardID(result.sourceURL)
    || !['added', 'refreshed', 'cached', 'unchanged'].includes(result.status)
    || !Number.isFinite(Date.parse(result.addedAt))) throw new Error('Invalid capture result');
  const path = join(directory, `${result.id}.webcard`);
  const collection = await loadCollection(directory);
  const item = collection.cards.find((card) => card.id === result.id);
  const currentBytes = item ? await readFile(path) : undefined;
  if (currentBytes) await readArchive(currentBytes);
  if (['cached', 'unchanged'].includes(result.status)) {
    if (!item) throw new Error('Cached card was removed before persistence; rerun dispatch');
    return { status: 'cached', changed: false };
  }
  const currentDigest = currentBytes ? digest(currentBytes) : null;
  if (currentDigest !== result.previousDigest) {
    throw new Error('This card changed during capture; rerun dispatch rather than overwrite it');
  }
  const bytes = await readFile(join(artifact, `${result.id}.webcard`));
  const archive = await readArchive(bytes);
  if (cardID(archive.root.sourceURL) !== result.id) throw new Error('Captured archive source identity mismatch');
  return saveCard(directory, result.sourceURL, () => bytes, { refresh: true, date: new Date(result.addedAt) });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const artifact = process.argv[2];
    if (!artifact) throw new Error('Usage: node scripts/persist-card.js <artifact directory>');
    console.log(JSON.stringify(await persistCard(join(process.cwd(), 'cards'), artifact)));
  } catch (error) {
    console.error(`Persistence failed: ${error.message}`);
    process.exitCode = 1;
  }
}
