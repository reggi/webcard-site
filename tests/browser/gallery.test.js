import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'vite';
import { chromium } from 'playwright';
import { load } from 'cheerio';
import { prepareSite } from '../../src/site/site.js';
import { saveCard } from '../../src/webcard/collection.js';
import { captureURL } from '../../src/capture/capture.js';
import { readArchive } from '../../src/webcard/format.js';
import { archive, fixtureServer, image, temporaryCollection } from '../helpers.js';

test('production root/project builds contain complete HTML and work without JS at all breakpoints', async (t) => {
  const { root, cards } = await temporaryCollection();
  t.after(() => rm(root, { recursive: true }));
  await writeFile(join(root, 'site.config.json'), JSON.stringify({
    title: 'Fixture cards', description: 'Fixture collection', language: 'en',
    theme: 'system', siteURL: '', base: ''
  }));
  await copyFile('theme.css', join(root, 'theme.css'));
  await copyFile('index.html', join(root, 'index.html'));
  await mkdir(join(root, 'src/site'), { recursive: true });
  await copyFile('src/site/styles.css', join(root, 'src/site/styles.css'));
  await copyFile('src/site/masonry.js', join(root, 'src/site/masonry.js'));
  for (let index = 0; index < 6; index++) {
    const url = `https://example.com/${index}`;
    const date = new Date(`2026-01-0${index + 1}T00:00:00.000Z`);
    await saveCard(cards, url, async () => archive({ url, title: `Card ${index}`, bytes: await image(120, 60 + index * 40), date }), { date });
  }
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const base of ['/', '/project/']) {
    const site = await prepareSite(root, { SITE_URL: `https://cards.example${base}`, BASE_PATH: base });
    await build({
      configFile: false, root, base, publicDir: '.generated/public', logLevel: 'error',
      plugins: [{
        name: 'test-static-render',
        transformIndexHtml: { order: 'pre', handler: (html) => html.replace('<!--site-head-->', site.head).replace('<!--site-body-->', site.body) }
      }]
    });
    const html = await readFile(join(root, 'dist/index.html'), 'utf8');
    const $ = load(html);
    assert.equal($('article').length, 6);
    assert.equal($('article h2').first().text(), 'Card 5');
    assert.equal($('script[type="application/ld+json"]').length, 1);
    assert.equal($('link[rel="canonical"]').attr('href'), `https://cards.example${base}`);
    assert.equal($('article h2 a').last().attr('href'), 'https://example.com/0');
    const server = await fixtureServer(async (request, response) => {
      try {
        const path = new URL(request.url, 'http://fixture').pathname;
        if (!path.startsWith(base) || path.includes('..')) { response.writeHead(404); response.end(); return; }
        const local = path.slice(base.length) || 'index.html';
        const bytes = await readFile(join(root, 'dist', local));
        response.writeHead(200, { 'content-type': local.endsWith('.css') ? 'text/css' : local.endsWith('.js') ? 'text/javascript' : local.endsWith('.webp') ? 'image/webp' : 'text/html' });
        response.end(bytes);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        response.writeHead(404); response.end();
      }
    });
    try {
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({ javaScriptEnabled });
        try {
          const page = await context.newPage();
          const failures = [];
          page.on('pageerror', (error) => failures.push(error.message));
          page.on('response', (response) => { if (response.status() >= 400) failures.push(response.url()); });
          for (const width of [320, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`${server.url}${base}`, { waitUntil: 'networkidle' });
            assert.equal(await page.locator('article h2 a').count(), 6);
            assert.equal(await page.locator('article h2').first().textContent(), 'Card 5');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
            await page.locator('article').last().scrollIntoViewIfNeeded();
            await page.waitForFunction(() => [...document.querySelectorAll('article img')].every((img) => img.complete && img.naturalWidth > 0));
            if (javaScriptEnabled) {
              assert.equal(await page.locator('.gallery.masonry').count(), 1);
              assert.ok(await page.locator('.card').first().evaluate((card) => card.style.gridRowEnd.startsWith('span ')));
            } else {
              assert.equal(await page.locator('.gallery.masonry').count(), 0);
            }
          }
          assert.deepEqual(failures, []);
        } finally { await context.close(); }
      }
    } finally { await server.close(); }
  }
});

test('screenshot fallback generates a valid WebP and blocks private browser subresources', async (t) => {
  const server = await fixtureServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<title>Screenshot fixture</title><h1>A rendered page</h1>
      <img src="http://10.0.0.1/secret"><script>fetch('http://169.254.169.254/latest/').catch(() => {});</script>`);
  });
  t.after(server.close);
  const warnings = [];
  const result = await readArchive(await captureURL(server.url, undefined, {
    networkOptions: { testLoopback: true }, warn: (message) => warnings.push(message)
  }));
  assert.equal(result.current.title, 'Screenshot fixture');
  assert.deepEqual(result.images.get(result.current.image.path), { width: 1200, height: 900 });
  assert.ok(warnings.some((message) => message.includes('No preview image')));
  assert.ok(warnings.some((message) => message.includes('blocked')));
});

test('invalid metadata image triggers screenshot rather than a success-shaped broken image', async (t) => {
  const server = await fixtureServer((request, response) => {
    if (request.url === '/broken') { response.writeHead(200, { 'content-type': 'image/png' }); response.end('not an image'); }
    else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Broken preview</title><meta property="og:image" content="/broken">'); }
  });

  test('SVG metadata images are not passed to a filesystem-capable image renderer', async (t) => {
    const server = await fixtureServer((request, response) => {
      if (request.url === '/vector') {
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        response.end('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>');
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<title>Vector preview</title><meta property="og:image" content="/vector">');
      }
    });
    t.after(server.close);
    const warnings = [];
    const card = await readArchive(await captureURL(server.url, undefined, {
      networkOptions: { testLoopback: true }, warn: (message) => warnings.push(message)
    }));
    assert.ok(warnings.some((message) => message.includes('raster previews')));
    assert.equal(card.current.image.mediaType, 'image/webp');
  });
  t.after(server.close);
  const warnings = [];
  const card = await readArchive(await captureURL(server.url, undefined, {
    networkOptions: { testLoopback: true }, warn: (message) => warnings.push(message)
  }));
  assert.ok(warnings.some((message) => message.includes('Preview image unavailable')));
  assert.equal(card.current.image.mediaType, 'image/webp');
  assert.deepEqual(card.images.get(card.current.image.path), { width: 1200, height: 900 });
});
