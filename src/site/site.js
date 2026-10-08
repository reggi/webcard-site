import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJSON, sourceURL } from '../webcard/format.js';
import { readCollection } from '../webcard/collection.js';

export const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

export function validateConfig(config, environment = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.title !== 'string' || !config.title.trim() || config.title.length > 200
    || typeof config.description !== 'string' || config.description.length > 2000
    || typeof config.language !== 'string' || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(config.language)
    || !['system', 'light', 'dark'].includes(config.theme)
    || typeof config.siteURL !== 'string' || typeof config.base !== 'string') {
    throw new Error('site.config.json: invalid title, description, language, theme, siteURL, or base');
  }
  const siteURL = config.siteURL || environment.SITE_URL || '';
  let url;
  if (siteURL) {
    url = sourceURL(siteURL);
    if (url.search || url.hash) throw new Error('siteURL must not contain a query or fragment');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
  }
  const base = config.base || (config.siteURL ? url.pathname : environment.BASE_PATH || url?.pathname || '/');
  if (!/^\/(?:[^?#\\\s]*\/)?$/.test(base) || base.includes('//')
    || base.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('base must be an absolute URL path beginning and ending with /');
  }
  if (url && url.pathname !== base) throw new Error('siteURL path must match base');
  return { ...config, siteURL: url?.href ?? '', base };
}

export function renderSite(cards, config) {
  const e = escapeHTML;
  const absolute = (path) => config.siteURL ? new URL(path, config.siteURL).href : undefined;
  const graph = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: config.title,
    description: config.description, ...(config.siteURL ? { url: config.siteURL } : {}),
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: cards.map((card, index) => ({
        '@type': 'ListItem', position: index + 1,
        item: {
          '@type': 'WebPage', name: card.archive.current.title,
          description: card.archive.current.description, url: card.archive.root.sourceURL,
          ...(absolute(`webcard-assets/${card.archive.current.image.sha256}.webp`) ? {
            image: absolute(`webcard-assets/${card.archive.current.image.sha256}.webp`)
          } : {})
        }
      }))
    }
  };
  const firstImage = cards[0]?.archive.current.image.sha256;
  const head = [
    `<title>${e(config.title)}</title>`,
    `<meta name="description" content="${e(config.description)}">`,
    `<meta property="og:title" content="${e(config.title)}">`,
    `<meta property="og:description" content="${e(config.description)}">`,
    '<meta property="og:type" content="website">',
    `<meta name="twitter:card" content="${firstImage && config.siteURL ? 'summary_large_image' : 'summary'}">`,
    config.siteURL ? `<link rel="canonical" href="${e(config.siteURL)}"><meta property="og:url" content="${e(config.siteURL)}">` : '',
    firstImage && config.siteURL ? `<meta property="og:image" content="${e(absolute(`webcard-assets/${firstImage}.webp`))}">` : '',
    `<script type="application/ld+json">${JSON.stringify(graph).replaceAll('<', '\\u003c')}</script>`
  ].join('\n');
  const body = `<a class="skip-link" href="#cards">Skip to webcards</a>
    <header class="site-header"><h1>${e(config.title)}</h1><p>${e(config.description)}</p></header>
    <main id="cards" class="gallery" aria-label="Webcard collection">
    ${cards.length ? cards.map(({ archive }, index) => {
      const card = archive.current;
      const dimensions = archive.images.get(card.image.path);
      return `<article class="card"><div class="card-inner">
        <a class="image-link" href="${e(archive.root.sourceURL)}" tabindex="-1" aria-hidden="true">
          <img src="${e(`${config.base}webcard-assets/${card.image.sha256}.webp`)}"
            width="${dimensions.width}" height="${dimensions.height}" alt="${e(card.sourceMetadata?.imageAlt || `${card.title} preview`)}"
            loading="${index < 3 ? 'eager' : 'lazy'}" decoding="async">
        </a>
        <div class="card-text"><p class="site-name">${e(card.siteName)}</p>
          <h2><a href="${e(archive.root.sourceURL)}">${e(card.title)}</a></h2>
          ${card.description ? `<p class="description">${e(card.description)}</p>` : ''}
          <p class="source-url">${e(new URL(archive.root.sourceURL).hostname)}</p>
        </div></div></article>`;
    }).join('\n') : '<p class="empty-state">No webcards yet. Add a URL using the repository’s capture workflow.</p>'}
    </main>`;
  return { head, body };
}

export async function prepareSite(root = process.cwd(), environment = process.env) {
  const config = validateConfig(parseJSON(await readFile(join(root, 'site.config.json')), 'site.config.json'), environment);
  const cards = await readCollection(join(root, 'cards'));
  const publicDirectory = join(root, '.generated', 'public');
  // This is only the named, ignored staging directory, never the repository root.
  await rm(publicDirectory, { recursive: true, force: true });
  await mkdir(join(publicDirectory, 'webcard-assets'), { recursive: true });
  for (const { archive } of cards) {
    const image = archive.current.image;
    await writeFile(join(publicDirectory, 'webcard-assets', `${image.sha256}.webp`), archive.entries.get(image.path));
  }
  if (config.siteURL) {
    await writeFile(join(publicDirectory, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${config.siteURL}sitemap.xml\n`);
    await writeFile(join(publicDirectory, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHTML(config.siteURL)}</loc></url></urlset>\n`);
  }
  return { config, ...renderSite(cards, config) };
}
