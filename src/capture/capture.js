import { load } from 'cheerio';
import sharp from 'sharp';
import { appendCapture, LIMITS, sourceURL } from '../webcard/format.js';
import { createNetwork } from './network.js';

const text = (value, max) => (value ?? '').replace(/\s+/g, ' ').trim().normalize('NFC').slice(0, max).toWellFormed();

export function extractMetadata(html, pageURL, warn = console.warn) {
  const $ = load(html);
  const meta = (name) => $('meta').filter((_, element) => {
    return ($(element).attr('property') ?? $(element).attr('name') ?? '').toLowerCase() === name;
  }).first().attr('content') ?? '';
  const resolve = (value) => {
    if (!value) return undefined;
    try { return sourceURL(new URL(value, pageURL).href).href; }
    catch (error) { warn(`Ignoring invalid metadata URL: ${error.message}`); return undefined; }
  };
  const canonical = $('link[rel="canonical"]').first().attr('href') || meta('og:url');
  const metadata = {
    canonicalURL: resolve(canonical) ?? pageURL,
    title: text(meta('og:title') || meta('twitter:title') || $('title').first().text() || new URL(pageURL).hostname, 500),
    description: text(meta('og:description') || meta('twitter:description') || meta('description'), 2000),
    siteName: text(meta('og:site_name') || new URL(pageURL).hostname, 300)
  };
  const sourceMetadata = {};
  for (const [field, name] of Object.entries({
    author: 'article:author', contentType: 'og:type', imageAlt: 'og:image:alt',
    locale: 'og:locale', modifiedTime: 'article:modified_time', publishedTime: 'article:published_time',
    section: 'article:section', twitterCard: 'twitter:card'
  })) {
    const value = text(meta(name), 2000);
    if (value) sourceMetadata[field] = value;
  }
  if (!sourceMetadata.author && meta('author')) sourceMetadata.author = text(meta('author'), 2000);
  if (Object.keys(sourceMetadata).length) metadata.sourceMetadata = sourceMetadata;
  return {
    metadata,
    imageURL: resolve(meta('og:image') || meta('twitter:image')),
    iconURL: resolve($('link[rel~="icon"]').first().attr('href'))
  };
}

async function webp(bytes) {
  const image = sharp(bytes, { limitInputPixels: LIMITS.pixels, failOn: 'warning' });
  const metadata = await image.metadata();
  if (metadata.pages > 1) throw new Error('Animated images are not supported');
  const converted = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  if (converted.length > LIMITS.asset) throw new Error('Converted image exceeds asset limit');
  return converted;
}

export async function screenshot(url, network, warn) {
  const { chromium } = await import('playwright');
  // Intercept and fulfill all browser HTTP traffic through the DNS-bound reader.
  // The dead proxy blocks anything the interception API cannot handle.
  const browser = await chromium.launch({
    proxy: { server: 'http://127.0.0.1:9' },
    args: ['--proxy-bypass-list=<-loopback>', '--disable-quic']
  });
  let requests = 0;
  let bytes = 0;
  let failures = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 }, serviceWorkers: 'block',
      acceptDownloads: false, javaScriptEnabled: true
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      const request = route.request();
      try {
        if (++requests > 100 || bytes >= 50 * 1024 * 1024 || request.method() !== 'GET') {
          throw new Error('Browser request budget/method exceeded');
        }
        const response = await network.get(request.url(), { signal: controller.signal, limit: 10 * 1024 * 1024 });
        bytes += response.bytes.length;
        if (bytes > 50 * 1024 * 1024) throw new Error('Browser response budget exceeded');
        await route.fulfill({ status: 200, contentType: response.contentType, body: response.bytes });
      } catch (error) {
        failures++;
        if (request.isNavigationRequest()) warn(`Browser navigation blocked/failed: ${error.message}`);
        await route.abort();
      }
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response?.ok()) throw new Error('Screenshot navigation did not succeed');
    await page.waitForTimeout(800);
    const image = await page.screenshot({ type: 'png', timeout: 10_000, animations: 'disabled' });
    if (failures) warn(`${failures} browser requests failed or were blocked by capture policy`);
    return webp(image);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await browser.close();
  }
}

export async function captureURL(url, previous, { date = new Date(), warn = console.warn, networkOptions } = {}) {
  sourceURL(url);
  const network = createNetwork(networkOptions);
  try {
    const page = await network.get(url, { limit: 2 * 1024 * 1024 });
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(page.contentType)) {
      throw new Error(`Expected HTML, received ${page.contentType || 'no content type'}`);
    }
    const { metadata, imageURL, iconURL } = extractMetadata(page.bytes.toString('utf8'), page.url, warn);
    let image;
    let icon;
    if (imageURL) {
      try { image = await webp((await network.get(imageURL)).bytes); }
      catch (error) { warn(`Preview image unavailable; using screenshot: ${error.message}`); }
    } else {
      warn('No preview image found; using a bounded browser screenshot');
    }
    if (!image) image = await screenshot(page.url, network, warn);
    if (iconURL) {
      try { icon = await webp((await network.get(iconURL)).bytes); }
      catch (error) { warn(`Optional icon unavailable: ${error.message}`); }
    }
    return appendCapture(previous, url, metadata, image, icon, date);
  } finally {
    await network.close();
  }
}
