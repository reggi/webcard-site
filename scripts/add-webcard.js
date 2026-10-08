import { join } from 'node:path';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { captureURL } from '../src/capture/capture.js';
import { saveCard } from '../src/webcard/collection.js';
import { jsonBytes } from '../src/webcard/format.js';

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith('--') && arg !== '--refresh') || args.filter((arg) => arg !== '--refresh').length > 1) {
    throw new Error('Usage: npm run card:add -- <url> [--refresh]');
  }
  const url = args.find((arg) => arg !== '--refresh') ?? process.env.CARD_URL;
  if (!url) throw new Error('Provide a URL argument or CARD_URL');
  const refresh = args.includes('--refresh') || process.env.CARD_REFRESH === 'true';
  const date = new Date();
  const result = await saveCard(join(process.cwd(), 'cards'), url, (previous) => captureURL(url, previous, { date }), { refresh, date });
  if (process.env.CARD_OUTPUT) {
    await mkdir(process.env.CARD_OUTPUT, { recursive: true });
    await writeFile(join(process.env.CARD_OUTPUT, 'result.json'), jsonBytes(result));
    await copyFile(join('cards', `${result.id}.webcard`), join(process.env.CARD_OUTPUT, `${result.id}.webcard`));
  }
  console.log(`${result.status}: cards/${result.id}.webcard`);
} catch (error) {
  console.error(`Capture failed: ${error.message}`);
  process.exitCode = 1;
}
