import assert from 'node:assert/strict';
import test from 'node:test';
import { captureURL, extractMetadata } from '../src/capture/capture.js';
import { createNetwork, publicIP } from '../src/capture/network.js';
import { readArchive } from '../src/webcard/format.js';
import { fixtureServer, image } from './helpers.js';

test('metadata precedence, relative URLs, fallback text and unsafe URL warnings', () => {
  const warnings = [];
  const result = extractMetadata(`<title>Fallback</title><meta property="og:title" content="  Preferred  ">
    <meta name="description" content="Description"><link rel="canonical" href="/canonical">
    <meta property="og:image" content="/image"><link rel="icon" href="/icon">
    <meta property="article:author" content="Author">`, 'https://example.com/page', (message) => warnings.push(message));
  assert.equal(result.metadata.title, 'Preferred');
  assert.equal(result.metadata.description, 'Description');
  assert.equal(result.metadata.canonicalURL, 'https://example.com/canonical');
  assert.equal(result.imageURL, 'https://example.com/image');
  assert.equal(result.iconURL, 'https://example.com/icon');
  assert.equal(result.metadata.sourceMetadata.author, 'Author');
  const invalid = extractMetadata('<meta property="og:image" content="file:///secret">', 'https://example.com/', (message) => warnings.push(message));
  assert.equal(invalid.imageURL, undefined);
  assert.equal(warnings.length, 1);
});

test('public-network policy rejects local, private, reserved and mapped addresses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(publicIP(address), false, address);
  }
  assert.equal(publicIP('1.1.1.1'), true);
  assert.equal(publicIP('2606:4700:4700::1111'), true);
  const network = createNetwork();
  try {
    await assert.rejects(network.get('http://127.0.0.1/'), /Blocked/);
    await assert.rejects(network.get('http://localhost/'), /fetch failed/);
    await assert.rejects(network.get('http://[::ffff:127.0.0.1]/'), /Blocked/);
  } finally { await network.close(); }
});

test('bounded network reader handles redirect policy and byte limits', async (t) => {
  const server = await fixtureServer((request, response) => {
    if (request.url === '/private') { response.writeHead(302, { location: 'http://10.0.0.1/' }); response.end(); }
    else if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); }
    else if (request.url === '/advertised') { response.writeHead(200, { 'content-length': '1000' }); response.end('x'); }
    else { response.writeHead(200); response.write('123456'); response.end('789012'); }
  });
  t.after(server.close);
  const network = createNetwork({ testLoopback: true });
  t.after(() => network.close());
  await assert.rejects(network.get(`${server.url}/private`), /Blocked/);
  await assert.rejects(network.get(`${server.url}/loop`), /redirects/);
  await assert.rejects(network.get(`${server.url}/advertised`, { limit: 10 }), /limit/);
  await assert.rejects(network.get(`${server.url}/chunked`, { limit: 10 }), /limit/);
  assert.equal((await network.get(`${server.url}/chunked`, { limit: 12 })).bytes.length, 12);
});

test('captures metadata image locally, retains requested URL and observed canonical URL', async (t) => {
  const bytes = await image();
  const server = await fixtureServer((request, response) => {
    if (request.url === '/image') { response.writeHead(200, { 'content-type': 'image/webp' }); response.end(bytes); }
    else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<title>Fixture</title><meta property="og:image" content="/image"><link rel="canonical" href="/canonical">');
    }
  });
  t.after(server.close);
  const result = await readArchive(await captureURL(`${server.url}/requested`, undefined, {
    networkOptions: { testLoopback: true }, warn: () => assert.fail('no warnings expected')
  }));
  assert.equal(result.root.sourceURL, `${server.url}/requested`);
  assert.equal(result.current.canonicalURL, `${server.url}/canonical`);
  assert.equal(result.current.title, 'Fixture');
});

test('failed source fetch is explicit', async (t) => {
  const server = await fixtureServer((_, response) => { response.writeHead(503); response.end('unavailable'); });
  t.after(server.close);
  await assert.rejects(captureURL(server.url, undefined, { networkOptions: { testLoopback: true } }), /HTTP 503/);
});
