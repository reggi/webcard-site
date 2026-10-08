import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'cheerio';
import { prepareSite, renderSite, validateConfig } from '../src/site/site.js';
import { saveCard, readCollection } from '../src/webcard/collection.js';
import { jsonBytes } from '../src/webcard/format.js';
import { archive, temporaryCollection } from './helpers.js';

export const config = { title: 'My cards', description: 'Saved links', language: 'en', theme: 'system', siteURL: '', base: '' };

test('configuration derives root/project bases and explicit URL takes precedence', () => {
  assert.equal(validateConfig(config, {}).base, '/');
  assert.equal(validateConfig(config, { SITE_URL: 'https://owner.github.io/project/', BASE_PATH: '/project/' }).base, '/project/');
  assert.equal(validateConfig({ ...config, siteURL: 'https://cards.example/' }, { BASE_PATH: '/project/' }).base, '/');
  for (const invalid of [{ theme: 'automatic' }, { base: '/x' }, { base: '/../' }, { language: 'en" onclick="' }, { siteURL: 'https://example.com/?query=1' }, { siteURL: 'https://example.com/', base: '/x/' }]) {
    assert.throws(() => validateConfig({ ...config, ...invalid }, {}));
  }
});

test('all card content and links are rendered as escaped HTML, with SEO metadata', async (t) => {
  const { root, cards } = await temporaryCollection();
  t.after(() => rm(root, { recursive: true }));
  await saveCard(cards, 'https://example.com/', () => archive({ title: '<script>alert("x")</script>' }));
  const rendered = renderSite(await readCollection(cards), validateConfig({ ...config, siteURL: 'https://owner.github.io/project/' }, {}));
  const $ = load(`<html><head>${rendered.head}</head><body>${rendered.body}</body></html>`);
  assert.equal($('article').length, 1);
  assert.equal($('article h2').text(), '<script>alert("x")</script>');
  assert.equal($('article script').length, 0);
  assert.equal($('article h2 a').attr('href'), 'https://example.com/');
  assert.equal($('meta[name="description"]').attr('content'), 'Saved links');
  assert.equal($('link[rel="canonical"]').attr('href'), 'https://owner.github.io/project/');
  assert.match($('article img').attr('src'), /^\/project\/webcard-assets\/[a-f0-9]{64}\.webp$/);
  const graph = JSON.parse($('script[type="application/ld+json"]').text());
  assert.equal(graph.mainEntity.itemListElement[0].item.name, '<script>alert("x")</script>');
  assert.ok(!rendered.head.includes('<script>alert'));
});

test('offline build preparation emits selected assets, sitemap, robots and explicit empty state', async (t) => {
  const { root } = await temporaryCollection();
  t.after(() => rm(root, { recursive: true }));
  await writeFile(join(root, 'site.config.json'), jsonBytes({ ...config, siteURL: 'https://cards.example/' }));
  const rendered = await prepareSite(root, {});
  assert.match(rendered.body, /No webcards yet/);
  assert.match(await readFile(join(root, '.generated/public/sitemap.xml'), 'utf8'), /https:\/\/cards.example\//);
  assert.match(await readFile(join(root, '.generated/public/robots.txt'), 'utf8'), /Sitemap:/);
});
