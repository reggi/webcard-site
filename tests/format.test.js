import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import yazl from 'yazl';
import {
  appendCapture, assetReference, cardID, digest, jsonBytes, LIMITS, MIME,
  parseJSON, readArchive, sourceURL, validateEntries, writeArchive
} from '../src/webcard/format.js';
import { archive, image } from './helpers.js';

test('round trip emits STORE ZIP with exact first mimetype and verified WebP', async () => {
  const bytes = await archive();
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(8), 0);
  assert.equal(bytes.subarray(30, 38).toString(), 'mimetype');
  const result = await readArchive(bytes);
  assert.equal(result.root.formatVersion, '1.0.0');
  assert.equal(result.current.title, 'Example');
  assert.equal(result.entries.get('mimetype').toString(), MIME);
  assert.equal(result.current.image.sha256, digest(result.entries.get(result.current.image.path)));
  assert.deepEqual(result.images.get(result.current.image.path), { width: 120, height: 80 });
  assert.ok(bytes.equals(await writeArchive(result.entries)), 'production is deterministic');
});

test('refresh preserves history and extensions; identical capture only updates refresh time', async () => {
  const first = await readArchive(await archive());
  first.root.extensions = { 'https://example.com/extension': { preserved: true } };
  first.entries.set('webcard.json', jsonBytes(first.root));
  first.entries.set('extensions/example/opaque.bin', Buffer.from([0, 255, 12]));
  const originalCapture = first.entries.get(first.root.currentCapture);
  const next = await readArchive(await archive({ previous: first, title: 'Changed', date: new Date('2026-01-02T00:00:00.123Z') }));
  assert.equal(next.root.captures.length, 2);
  assert.ok(next.entries.get(first.root.currentCapture).equals(originalCapture));
  assert.ok(next.entries.get('extensions/example/opaque.bin').equals(Buffer.from([0, 255, 12])));
  assert.deepEqual(next.root.extensions, first.root.extensions);
  const unchanged = await readArchive(await archive({ previous: next, title: 'Changed', date: new Date('2026-01-03T00:00:00.123Z') }));
  assert.equal(unchanged.root.captures.length, 2);
  assert.equal(unchanged.root.lastRefreshedAt, '2026-01-03T00:00:00.123Z');
});

test('timestamp collisions get deterministic suffixes', async () => {
  const first = await readArchive(await archive());
  const next = await readArchive(await archive({ previous: first, title: 'Changed' }));
  assert.match(next.current.id, /-1$/);
});

test('refuses signed refresh and chronological rollback', async () => {
  const first = await readArchive(await archive());
  await assert.rejects(archive({ previous: first, title: 'changed', date: new Date('2025-01-01') }), /precede/);
  first.entries.set('signatures/opaque.json', Buffer.from('{}'));
  await assert.rejects(archive({ previous: first }), /signed/);
});

test('JSON rejects duplicate keys, comments, malformed Unicode and size overflow', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '{"a":1,}', '{/*x*/"a":1}', '{"a":"\\ud800"}']) {
    assert.throws(() => parseJSON(Buffer.from(text), 'fixture'));
  }
  assert.throws(() => parseJSON(Buffer.from([0xff]), 'fixture'));
  assert.throws(() => parseJSON(Buffer.alloc(LIMITS.json + 1), 'fixture'), /exceeds/);
  assert.deepEqual(parseJSON(Buffer.from('{"a":1,"b":{"a":2}}'), 'fixture'), { a: 1, b: { a: 2 } });
  const boundary = `{"a":"${'x'.repeat(LIMITS.json - 8)}"}`;
  assert.equal(Buffer.byteLength(boundary), LIMITS.json);
  assert.equal(parseJSON(Buffer.from(boundary), 'fixture').a.length, LIMITS.json - 8);
});

test('URL identity does not strip query, fragment, or merge by canonical URL', () => {
  assert.notEqual(cardID('https://example.com/?a=1'), cardID('https://example.com/?a=2'));
  assert.notEqual(cardID('https://example.com/#a'), cardID('https://example.com/#b'));
  assert.equal(cardID('https://EXAMPLE.com:443/'), cardID('https://example.com/'));
  for (const value of ['https://user:pass@example.com/', 'file:///tmp/a', '/relative', ' https://example.com/']) {
    assert.throws(() => sourceURL(value));
  }
});

test('validates root selection, version, asset integrity and inventory', async () => {
  const valid = await readArchive(await archive());
  const mutate = async (callback, pattern) => {
    const entries = new Map(valid.entries);
    await callback(entries);
    await assert.rejects(validateEntries(entries), pattern);
  };
  await mutate((entries) => entries.set('mimetype', Buffer.from(`${MIME}\n`)), /mimetype/);
  await mutate((entries) => entries.set('webcard.json', jsonBytes({ ...valid.root, formatVersion: '2.0.0' })), /webcard/);
  await mutate((entries) => entries.set('webcard.json', jsonBytes({ ...valid.root, currentCapture: 'captures/20990101T000000.000Z.json' })), /currentCapture/);
  await mutate((entries) => entries.set(valid.current.image.path, Buffer.from('invalid')), /integrity/);
  await mutate((entries) => entries.set('unexpected.txt', Buffer.from('x')), /Unreferenced/);
  await mutate((entries) => entries.set('../outside', Buffer.from('x')), /Unsafe/);
  await mutate((entries) => entries.set(valid.root.currentCapture, jsonBytes({ ...valid.current, capturedAt: '2026-02-30T00:00:00.123Z' })), /timestamp|capture/);
});

test('rejects ZIP compression, duplicate entry names, and non-first mimetype', async () => {
  const valid = await readArchive(await archive());
  const zipBytes = async (names, compress) => {
    const zip = new yazl.ZipFile();
    for (const name of names) zip.addBuffer(valid.entries.get(name), name, { compress });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      zip.outputStream.on('data', (chunk) => chunks.push(chunk));
      zip.outputStream.on('error', reject);
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    zip.end();
    return done;
  };
  await assert.rejects(readArchive(await zipBytes([...valid.entries.keys()], true)), /Compressed/);
  await assert.rejects(readArchive(await zipBytes(['mimetype', 'mimetype'], false)), /Duplicate/);
  await assert.rejects(readArchive(await zipBytes(['webcard.json', 'mimetype'], false)), /first/);
});

test('rejects corrupted local names, payload CRC, oversized archive and false image type', async () => {
  const bytes = await archive();
  const corrupted = Buffer.from(bytes);
  corrupted[30] = 120;
  await assert.rejects(readArchive(corrupted), /names disagree/);
  const badCRC = Buffer.from(bytes);
  badCRC[30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28)] ^= 1;
  await assert.rejects(readArchive(badCRC), /CRC/);
  await assert.rejects(readArchive(Buffer.alloc(LIMITS.archive + 1)), /size limit/);
  const valid = await readArchive(bytes);
  const fake = Buffer.from('not a WebP');
  const asset = assetReference(fake);
  valid.entries.delete(valid.current.image.path);
  valid.entries.set(asset.path, fake);
  valid.entries.set(valid.root.currentCapture, jsonBytes({ ...valid.current, image: asset }));
  await assert.rejects(validateEntries(valid.entries));
});

test('all capture assets and metadata are validated, not only current selection', async () => {
  const first = await readArchive(await archive());
  const next = await readArchive(await appendCapture(first, first.root.sourceURL, {
    canonicalURL: first.root.sourceURL, title: 'Second', description: '', siteName: 'Example'
  }, await image(80, 120), undefined, new Date('2026-01-02T00:00:00.123Z')));
  next.entries.set(first.root.currentCapture, Buffer.from('{}'));
  await assert.rejects(validateEntries(next.entries), /capture/);
});

test('capture timestamps preserve representable extra precision and reject different instants', async () => {
  const valid = await readArchive(await archive());
  valid.entries.set(valid.root.currentCapture, jsonBytes({ ...valid.current, capturedAt: '2026-01-01T00:00:00.123000Z' }));
  await validateEntries(valid.entries);
  valid.entries.set(valid.root.currentCapture, jsonBytes({ ...valid.current, capturedAt: '2026-01-01T00:00:00.123400Z' }));
  await assert.rejects(validateEntries(valid.entries), /precision/);
});

test('published Webcard 1.0.0 minimal example interoperates without rewriting metadata/assets', async () => {
  const names = [
    'mimetype', 'webcard.json', 'captures/20260924T042656.575Z.json',
    'assets/sha256/01ccfcbb2f0635b02dc28020140fae2e23466f5c8a0b431d968b5898dd926412.webp'
  ];
  const entries = new Map();
  for (const name of names) {
    const binary = name.endsWith('.webp');
    const bytes = await readFile(new URL(`./fixtures/spec-minimal/${name}${binary ? '.base64' : ''}`, import.meta.url));
    entries.set(name, binary ? Buffer.from(bytes.toString('utf8').trim(), 'base64') : bytes);
  }
  entries.set('mimetype', Buffer.from(entries.get('mimetype').toString().trimEnd()));
  const result = await readArchive(await writeArchive(entries));
  assert.equal(result.root.formatVersion, '1.0.0');
  assert.ok(result.entries.get('webcard.json').equals(entries.get('webcard.json')));
  assert.ok(result.entries.get(result.current.image.path).equals(entries.get(result.current.image.path)));
});
