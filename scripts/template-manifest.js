import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonBytes } from '../src/webcard/format.js';

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const managedPackage = Object.fromEntries(['private', 'type', 'scripts', 'engines', 'dependencies', 'devDependencies'].map((key) => [key, pkg[key]]));
const paths = [
  ...await files('src'), ...await files('scripts'), ...await files('tests'),
  ...await files('.github/workflows'),
  '.gitignore', '.nvmrc', 'eslint.config.js', 'index.html', 'vite.config.js', 'LICENSE'
].sort();
await mkdir('.knitto/files', { recursive: true });
await writeFile('.knitto/files/package.json.hbs', jsonBytes(managedPackage));
const manifest = {
  schemaVersion: 1,
  name: 'webcard-site',
  engine: { package: 'knitto', version: '0.3.0' },
  release: { provider: 'release-please', version: pkg.version, tagFormat: 'v{version}' },
  rules: [
    ...paths.map((path) => ({ id: `file-${path.replaceAll(/[^a-zA-Z0-9-]/g, '-')}`, type: 'file', source: path, destination: path })),
    {
      id: 'package', type: 'content', parser: 'package-json',
      template: 'files/package.json.hbs', destination: 'package.json',
      exact: Object.keys(managedPackage).map((key) => `/${key}`)
    },
    ...['site.config.json', 'theme.css', 'cards/collection.json', 'README.md'].map((path) => ({
      id: `initial-${path.replaceAll(/[^a-zA-Z0-9-]/g, '-')}`,
      type: 'file', source: path, destination: path, ifMissing: true
    }))
  ]
};
await writeFile(join('.knitto', 'template.json'), jsonBytes(manifest));
console.log(`Generated ${manifest.rules.length} explicitly owned Knitto rules`);
