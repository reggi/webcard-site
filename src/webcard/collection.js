import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cardID, digest, jsonBytes, LIMITS, parseJSON, readArchive, sourceURL } from './format.js';

export async function loadCollection(directory) {
  const path = join(directory, 'collection.json');
  const info = await lstat(path);
  if (!info.isFile() || info.size > LIMITS.json) throw new Error(`${path}: invalid collection file`);
  const collection = parseJSON(await readFile(path), path);
  if (collection?.version !== 1 || !Array.isArray(collection.cards) || collection.cards.length > 1000) {
    throw new Error(`${path}: expected version 1 and at most 1000 cards`);
  }
  const ids = new Set();
  for (const item of collection.cards) {
    if (!item || item.id !== cardID(item.sourceURL) || ids.has(item.id)
      || typeof item.addedAt !== 'string' || !Number.isFinite(Date.parse(item.addedAt))
      || new Date(item.addedAt).toISOString() !== item.addedAt) {
      throw new Error(`${path}: invalid/duplicate collection entry`);
    }
    ids.add(item.id);
    const archivePath = join(directory, `${item.id}.webcard`);
    const archiveInfo = await lstat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > LIMITS.archive) {
      throw new Error(`${archivePath}: invalid archive file`);
    }
  }
  for (const filename of await readdir(directory)) {
    if (filename.endsWith('.webcard') && !ids.has(filename.slice(0, -8))) {
      throw new Error(`${filename}: archive is not registered in collection.json`);
    }
  }
  return collection;
}

export async function readCollection(directory) {
  const collection = await loadCollection(directory);
  const cards = [];
  for (const item of collection.cards) {
    try {
      const archive = await readArchive(join(directory, `${item.id}.webcard`));
      if (cardID(archive.root.sourceURL) !== item.id) throw new Error('Source URL does not match collection identity');
      cards.push({ ...item, archive });
    } catch (error) {
      throw new Error(`${item.id}.webcard: ${error.message}`, { cause: error });
    }
  }
  return cards.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
}

export async function saveCard(directory, source, capture, { refresh = false, date = new Date() } = {}) {
  sourceURL(source);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.capture-lock');
  await mkdir(lock).catch((error) => {
    throw new Error(`Cannot acquire collection lock (${lock}): ${error.message}`, { cause: error });
  });
  const id = cardID(source);
  const path = join(directory, `${id}.webcard`);
  const temp = join(directory, `.${id}.tmp`);
  const indexTemp = join(directory, '.collection.tmp');
  let installed = false;
  let oldBytes;
  try {
    const collection = await loadCollection(directory);
    const item = collection.cards.find((entry) => entry.id === id);
    const previous = item ? await readArchive(path) : undefined;
    if (previous && cardID(previous.root.sourceURL) !== id) throw new Error('Cached archive has incorrect source identity');
    if (previous) oldBytes = await readFile(path);
    const result = { id, sourceURL: source, addedAt: item?.addedAt ?? date.toISOString(), previousDigest: oldBytes ? digest(oldBytes) : null };
    if (previous && !refresh) return { ...result, status: 'cached', changed: false };
    const bytes = await capture(previous);
    await readArchive(bytes);
    if (!item) collection.cards.push({ id, sourceURL: source, addedAt: date.toISOString() });
    if (oldBytes?.equals(bytes)) return { ...result, status: 'unchanged', changed: false };
    await writeFile(temp, bytes, { flag: 'wx' });
    await writeFile(indexTemp, jsonBytes(collection), { flag: 'wx' });
    await rename(temp, path);
    installed = true;
    await rename(indexTemp, join(directory, 'collection.json'));
    return { ...result, status: previous ? 'refreshed' : 'added', changed: true };
  } catch (error) {
    if (installed) {
      if (oldBytes) {
        await writeFile(temp, oldBytes);
        await rename(temp, path);
      } else {
        await rm(path);
      }
    }
    throw error;
  } finally {
    await rm(temp, { force: true });
    await rm(indexTemp, { force: true });
    await rmdir(lock);
  }
}
