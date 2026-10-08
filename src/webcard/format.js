import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse, visit } from 'jsonc-parser';
import sharp from 'sharp';
import yauzl from 'yauzl';
import yazl from 'yazl';

export const MIME = 'application/vnd.everything.webcard+zip';
export const LIMITS = Object.freeze({
  archive: 64 * 1024 * 1024,
  entries: 1000,
  expanded: 64 * 1024 * 1024,
  json: 256 * 1024,
  asset: 10 * 1024 * 1024,
  pixels: 20_000_000,
  captures: 100
});
const decoder = new TextDecoder('utf-8', { fatal: true });
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
for (const name of ['asset', 'capture', 'webcard']) {
  ajv.addSchema(JSON.parse(await readFile(new URL(`./schemas/${name}.schema.json`, import.meta.url))));
}
const schema = (name) => ajv.getSchema(`https://webcard.app/spec/1.0.0/schemas/${name}.schema.json`);
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function sourceURL(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\//i.test(value)) {
    throw new Error('Expected an absolute HTTP(S) URL without surrounding whitespace');
  }
  const url = new URL(value);
  if (url.username || url.password) throw new Error('URLs must not contain credentials');
  return url;
}

export const cardID = (url) => digest(sourceURL(url).href);

function wellFormed(value) {
  if (typeof value === 'string' && !value.isWellFormed()) throw new Error('Invalid Unicode in JSON');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      wellFormed(key);
      wellFormed(child);
    }
  }
}

export function parseJSON(bytes, label) {
  if (bytes.length > LIMITS.json) throw new Error(`${label}: metadata exceeds ${LIMITS.json} bytes`);
  const text = decoder.decode(bytes);
  const objects = [];
  visit(text, {
    onObjectBegin: () => objects.push(new Set()),
    onObjectProperty: (key) => {
      const keys = objects.at(-1);
      if (keys.has(key)) throw new Error(`${label}: duplicate JSON member ${key}`);
      keys.add(key);
    },
    onObjectEnd: () => objects.pop()
  }, { allowTrailingComma: false, disallowComments: true });
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length) throw new Error(`${label}: malformed JSON`);
  wellFormed(value);
  return value;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`);

function checkSchema(name, value) {
  const validate = schema(name);
  if (!validate(value)) throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
}

function safePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')
    || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
}

export async function imageInfo(bytes) {
  if (!bytes.length || bytes.length > LIMITS.asset) throw new Error('Image exceeds asset byte limits');
  const image = sharp(bytes, { limitInputPixels: LIMITS.pixels, failOn: 'warning' });
  const info = await image.metadata();
  if (info.format !== 'webp' || !info.width || !info.height || info.pages > 1
    || info.width * info.height > LIMITS.pixels) throw new Error('Expected a bounded, single-frame WebP image');
  await image.stats();
  return { width: info.width, height: info.height };
}

export function assetReference(bytes) {
  const sha256 = digest(bytes);
  return { path: `assets/sha256/${sha256}.webp`, mediaType: 'image/webp', sha256, byteLength: bytes.length };
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid UTC timestamp: ${value}`);
  const milliseconds = value.replace(/(\.\d{3})\d*Z$/, '$1Z');
  if (new Date(value).toISOString() !== milliseconds) throw new Error(`Invalid calendar timestamp: ${value}`);
}

export function captureID(date) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '');
}

export async function validateEntries(entries) {
  if (!(entries instanceof Map) || entries.size > LIMITS.entries) throw new Error('Invalid archive inventory');
  let expanded = 0;
  for (const [name, bytes] of entries) {
    safePath(name);
    expanded += bytes.length;
    if (expanded > LIMITS.expanded) throw new Error('Archive exceeds expanded size limit');
  }
  if (entries.get('mimetype')?.toString('utf8') !== MIME) throw new Error('Invalid mimetype entry');
  const root = parseJSON(entries.get('webcard.json') ?? Buffer.alloc(0), 'webcard.json');
  checkSchema('webcard', root);
  sourceURL(root.sourceURL);
  if (!root.captures.includes(root.currentCapture)) throw new Error('currentCapture is missing from captures');
  if (root.captures.length > LIMITS.captures) throw new Error('Capture history exceeds profile limit');
  if (root.lastRefreshedAt !== undefined) timestamp(root.lastRefreshedAt);
  const referenced = new Set(['mimetype', 'webcard.json']);
  const captures = new Map();
  const images = new Map();
  let previous = -Infinity;
  for (const path of root.captures) {
    const bytes = entries.get(path);
    if (!bytes) throw new Error(`Missing capture: ${path}`);
    referenced.add(path);
    const capture = parseJSON(bytes, path);
    checkSchema('capture', capture);
    sourceURL(capture.canonicalURL);
    timestamp(capture.capturedAt);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}0*Z$/.test(capture.capturedAt)) {
      throw new Error('Capture precision cannot be represented by its millisecond filename');
    }
    const instant = Date.parse(capture.capturedAt);
    if (instant < previous) throw new Error('Capture history is not chronological');
    previous = instant;
    const expectedID = captureID(new Date(instant));
    if (capture.id !== path.slice('captures/'.length, -5)
      || !new RegExp(`^${expectedID.replace('.', '\\.')}(?:-[0-9]+)?$`).test(capture.id)) {
      throw new Error(`Capture timestamp/id mismatch: ${path}`);
    }
    for (const asset of [capture.image, capture.icon].filter(Boolean)) {
      checkSchema('asset', asset);
      const data = entries.get(asset.path);
      if (!data || data.length !== asset.byteLength || digest(data) !== asset.sha256
        || asset.mediaType !== 'image/webp' || asset.path !== `assets/sha256/${asset.sha256}.webp`) {
        throw new Error(`Asset integrity/type mismatch: ${asset.path}`);
      }
      referenced.add(asset.path);
      if (!images.has(asset.path)) images.set(asset.path, await imageInfo(data));
    }
    captures.set(path, capture);
  }
  for (const name of entries.keys()) {
    if (!referenced.has(name) && !/^extensions\/[^/]+\/.+/.test(name) && !/^signatures\/.+/.test(name)) {
      throw new Error(`Unreferenced core entry: ${name}`);
    }
  }
  return { entries, root, captures, current: captures.get(root.currentCapture), images };
}

export async function readArchive(input) {
  if (typeof input === 'string' && (await stat(input)).size > LIMITS.archive) {
    throw new Error('Archive exceeds size limit');
  }
  const bytes = Buffer.isBuffer(input) ? input : await readFile(input);
  if (bytes.length > LIMITS.archive) throw new Error('Archive exceeds size limit');
  const entries = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: false, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      const inventory = new Map();
      const offsets = new Set();
      const normalizedNames = new Set();
      const ranges = [];
      const centralStart = zip.readEntryCursor;
      let total = 0;
      const fail = (err) => { zip.close(); reject(err); };
      zip.on('error', fail);
      zip.on('end', () => {
        ranges.sort((a, b) => a.start - b.start);
        if (!ranges.length || ranges[0].start !== 0
          || ranges.some((range, index) => index && range.start < ranges[index - 1].end)) {
          fail(new Error('Missing first local entry or overlapping ZIP entries')); return;
        }
        resolve(inventory);
      });
      zip.on('entry', (entry) => {
        try {
          const name = decoder.decode(entry.fileName);
          safePath(name);
          if (inventory.size >= LIMITS.entries || normalizedNames.has(name.normalize('NFC')) || offsets.has(entry.relativeOffsetOfLocalHeader)) {
            throw new Error('Duplicate entry or archive entry limit exceeded');
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (entry.compressionMethod !== 0 || (entry.generalPurposeBitFlag & 0x41)
            || ![0, 0o100000].includes(mode) || (entry.externalFileAttributes & 0x10)) {
            throw new Error('Compressed, encrypted, linked, or directory entries are not supported');
          }
          const offset = entry.relativeOffsetOfLocalHeader;
          if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50
            || bytes.readUInt16LE(offset + 8) !== 0
            || bytes.readUInt16LE(offset + 6) !== entry.generalPurposeBitFlag) {
            throw new Error('Invalid local ZIP header');
          }
          const nameLength = bytes.readUInt16LE(offset + 26);
          if (!bytes.subarray(offset + 30, offset + 30 + nameLength).equals(entry.fileName)) {
            throw new Error('Local and central ZIP names disagree');
          }
          if (offset === 0 && name !== 'mimetype') throw new Error('mimetype must be the first local entry');
          if (name === 'mimetype' && offset !== 0) {
            throw new Error('mimetype must be the first archive entry');
          }
          let end = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28) + entry.compressedSize;
          if (entry.generalPurposeBitFlag & 8) {
            if (end + 12 > centralStart) throw new Error('Invalid ZIP data descriptor');
            const descriptor = bytes.readUInt32LE(end) === 0x08074b50 ? end + 4 : end;
            if (descriptor + 12 > centralStart || bytes.readUInt32LE(descriptor) !== entry.crc32
              || bytes.readUInt32LE(descriptor + 4) !== entry.compressedSize
              || bytes.readUInt32LE(descriptor + 8) !== entry.uncompressedSize) throw new Error('ZIP descriptor mismatch');
            end = descriptor + 12;
          } else if (bytes.readUInt32LE(offset + 14) !== entry.crc32
            || bytes.readUInt32LE(offset + 18) !== entry.compressedSize
            || bytes.readUInt32LE(offset + 22) !== entry.uncompressedSize) {
            throw new Error('Local and central ZIP sizes/CRC disagree');
          }
          if (end > centralStart) throw new Error('ZIP entry overlaps central directory');
          total += entry.uncompressedSize;
          if (entry.uncompressedSize > LIMITS.asset || total > LIMITS.expanded
            || entry.compressedSize !== entry.uncompressedSize) throw new Error('Archive entry size limit exceeded');
          offsets.add(offset);
          normalizedNames.add(name.normalize('NFC'));
          ranges.push({ start: offset, end });
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const chunks = [];
            let length = 0;
            stream.on('error', fail);
            stream.on('data', (chunk) => {
              length += chunk.length;
              if (length > entry.uncompressedSize) { stream.destroy(new Error('ZIP length mismatch')); return; }
              chunks.push(chunk);
            });
            stream.on('end', () => {
              const data = Buffer.concat(chunks);
              if (length !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
                fail(new Error(`ZIP length/CRC mismatch: ${name}`)); return;
              }
              inventory.set(name, data);
              zip.readEntry();
            });
          });
        } catch (err) { fail(err); }
      });
      zip.readEntry();
    });
  });
  return validateEntries(entries);
}

export async function writeArchive(entries) {
  await validateEntries(entries);
  const zip = new yazl.ZipFile();
  const names = ['mimetype', ...[...entries.keys()].filter((name) => name !== 'mimetype').sort()];
  for (const name of names) {
    zip.addBuffer(entries.get(name), name, { compress: false, mtime: new Date('1980-01-01T00:00:00Z'), mode: 0o100644 });
  }
  const result = new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    zip.outputStream.on('error', reject);
    zip.outputStream.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMITS.archive) { zip.outputStream.destroy(new Error('Archive exceeds size limit')); return; }
      chunks.push(chunk);
    });
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  const bytes = await result;
  await readArchive(bytes);
  return bytes;
}

export async function appendCapture(previous, source, metadata, image, icon, date = new Date()) {
  if (previous && [...previous.entries.keys()].some((path) => path.startsWith('signatures/'))) {
    throw new Error('Refusing to refresh a signed archive without a supported signature profile');
  }
  const entries = new Map(previous?.entries ?? [['mimetype', Buffer.from(MIME)]]);
  const root = structuredClone(previous?.root ?? { formatVersion: '1.0.0', sourceURL: source, captures: [] });
  const imageAsset = assetReference(image);
  const iconAsset = icon ? assetReference(icon) : undefined;
  const display = { ...metadata, image: imageAsset, ...(iconAsset ? { icon: iconAsset } : {}) };
  const old = previous?.current;
  const oldDisplay = old && Object.fromEntries(Object.entries(old).filter(([key]) => [
    'canonicalURL', 'title', 'description', 'siteName', 'image', 'icon', 'sourceMetadata'
  ].includes(key)));
  root.lastRefreshedAt = date.toISOString();
  if (!old || JSON.stringify(sorted(oldDisplay)) !== JSON.stringify(sorted(display))) {
    if (root.captures.length && date.getTime() < Date.parse(previous.captures.get(root.captures.at(-1)).capturedAt)) {
      throw new Error('New capture cannot precede existing history');
    }
    let id = captureID(date);
    let suffix = 0;
    while (entries.has(`captures/${id}.json`)) id = `${captureID(date)}-${++suffix}`;
    const path = `captures/${id}.json`;
    const capture = { ...display, id, capturedAt: date.toISOString() };
    entries.set(imageAsset.path, image);
    if (iconAsset) entries.set(iconAsset.path, icon);
    entries.set(path, jsonBytes(capture));
    root.captures.push(path);
    root.currentCapture = path;
  }
  entries.set('webcard.json', jsonBytes(root));
  return writeArchive(entries);
}
