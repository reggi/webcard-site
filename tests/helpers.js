import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { appendCapture, jsonBytes } from '../src/webcard/format.js';

export async function temporaryCollection() {
  const root = await mkdtemp(join(tmpdir(), 'webcard-site-test-'));
  const cards = join(root, 'cards');
  await mkdir(cards);
  await writeFile(join(cards, 'collection.json'), jsonBytes({ version: 1, cards: [] }));
  return { root, cards };
}

export async function image(width = 120, height = 80, color = '#3974cb') {
  return sharp({ create: { width, height, channels: 3, background: color } }).webp().toBuffer();
}

export async function archive({ previous, url = 'https://example.com/', title = 'Example', date = new Date('2026-01-01T00:00:00.123Z'), bytes } = {}) {
  return appendCapture(previous, url, { canonicalURL: url, title, description: 'A saved place', siteName: 'Example' }, bytes ?? await image(), undefined, date);
}

export async function fixtureServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
