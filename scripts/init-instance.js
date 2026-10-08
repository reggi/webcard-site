import { execFileSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

try {
  const root = process.cwd();
  const origin = process.env.GITHUB_REPOSITORY || execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  if (/reggi[/:]webcard-site(?:\.git)?$/.test(origin)) throw new Error('Do not bootstrap the upstream template itself');
  const template = join(root, '.knitto', 'template.json');
  let embedded = false;
  try { await access(template); embedded = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = JSON.parse(await readFile(join(root, '.knitto.json'), 'utf8'));
  if (config.source.url !== 'https://github.com/reggi/webcard-site.git' || !/^v\d+\.\d+\.\d+$/.test(config.source.ref)) {
    throw new Error('Expected a released, pinned webcard-site source in .knitto.json');
  }
  if (embedded) {
    const manifest = JSON.parse(await readFile(template, 'utf8'));
    if (manifest.name !== 'webcard-site') throw new Error('Refusing to remove an unrelated embedded template');
    await rm(join(root, '.knitto'), { recursive: true });
  }
  execFileSync('npx', ['--no-install', 'knitto', 'apply', root], { stdio: 'inherit' });
  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  console.log('Instance now uses the pinned remote template. Commit .knitto.json, .knitto.lock, and bootstrap changes.');
} catch (error) {
  console.error(`Instance initialization failed: ${error.message}`);
  process.exitCode = 1;
}
