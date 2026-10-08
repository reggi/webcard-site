import { lookup } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';
import { sourceURL } from '../webcard/format.js';

export function publicIP(address) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export function guardedLookup(hostname, options, callback, { testLoopback = false } = {}) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !publicIP(address)
      && !(testLoopback && ['127.0.0.1', '::1'].includes(address)))) {
      return callback(new Error(`Blocked non-public DNS destination: ${hostname}`));
    }
    const usable = options.family ? addresses.filter((item) => item.family === options.family) : addresses;
    if (!usable.length) return callback(new Error(`No usable DNS addresses: ${hostname}`));
    if (options.all) return callback(null, usable);
    callback(null, usable[0].address, usable[0].family);
  });
}

export function createNetwork({ testLoopback = false } = {}) {
  const agent = new Agent({
    connect: { lookup: (host, options, callback) => guardedLookup(host, options, callback, { testLoopback }) },
    connections: 4
  });
  async function get(value, { limit = 10 * 1024 * 1024, timeout = 30_000, signal } = {}) {
    let url = sourceURL(value);
    const deadline = AbortSignal.timeout(timeout);
    const abort = signal ? AbortSignal.any([deadline, signal]) : deadline;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (ipaddr.isValid(host) && !publicIP(host)
        && !(testLoopback && ['127.0.0.1', '::1'].includes(host))) {
        throw new Error(`Blocked non-public IP destination: ${host}`);
      }
      const response = await fetch(url, {
        dispatcher: agent,
        redirect: 'manual',
        signal: abort,
        headers: { 'user-agent': 'WebcardSite/0.1 (+https://github.com/reggi/webcard-site)' }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('Invalid or excessive HTTP redirects');
        url = sourceURL(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} for ${url.href}`);
      }
      const advertised = response.headers.get('content-length');
      if (advertised && Number(advertised) > limit) {
        await response.body?.cancel();
        throw new Error(`Response exceeds ${limit} byte limit`);
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > limit) throw new Error(`Response exceeds ${limit} byte limit`);
          chunks.push(chunk);
        }
      } catch (error) {
        await reader.cancel();
        throw error;
      } finally {
        reader.releaseLock();
      }
      return { bytes: Buffer.concat(chunks), url: url.href, contentType: response.headers.get('content-type') ?? '' };
    }
    throw new Error('Excessive redirects');
  }
  return { get, close: () => agent.close() };
}
