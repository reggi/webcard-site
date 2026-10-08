import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archive } from '../tests/helpers.js';
import { saveCard } from '../src/webcard/collection.js';

const root = process.cwd();
const cli = fileURLToPath(new URL('../node_modules/knitto/dist/src/cli.js', import.meta.url));
const invoke = (args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CI: 'true' } });
let manifest;
try { manifest = await readFile(join(root, '.knitto/template.json')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!manifest) {
  console.log(invoke(['check', root]));
} else {
  const consumer = await mkdtemp(join(tmpdir(), 'webcard-consumer-'));
  const snapshot = await mkdtemp(join(tmpdir(), 'webcard-template-'));
  try {
    const definition = JSON.parse(manifest);
    await writeFile(join(snapshot, 'template.json'), manifest);
    for (const rule of definition.rules) {
      if (rule.type === 'delete') continue;
      const from = rule.source ? join(root, rule.source) : join(root, '.knitto', rule.template);
      const to = join(snapshot, rule.source ?? rule.template);
      await mkdir(join(to, '..'), { recursive: true });
      await copyFile(from, to);
    }
    await writeFile(join(consumer, 'package.json'), '{"name":"custom-consumer","description":"Instance-owned"}\n');
    await writeFile(join(consumer, '.knitto.json'), JSON.stringify({
      source: { type: 'local', path: snapshot }, engine: { package: 'knitto', version: '0.3.0' }
    }));
    invoke(['apply', consumer]);
    const config = '{"title":"Owned configuration"}\n';
    const theme = ':root { --accent: rebeccapurple; }\n';
    await writeFile(join(consumer, 'site.config.json'), config);
    await writeFile(join(consumer, 'theme.css'), theme);
    const card = await saveCard(join(consumer, 'cards'), 'https://example.com/', () => archive());
    const bytes = await readFile(join(consumer, 'cards', `${card.id}.webcard`));
    const collection = await readFile(join(consumer, 'cards/collection.json'));
    const stylesheet = await readFile(join(snapshot, 'src/site/styles.css'), 'utf8');
    await writeFile(join(snapshot, 'src/site/styles.css'), `${stylesheet}\n/* template upgrade fixture */\n`);
    invoke(['apply', consumer, '--update']);
    invoke(['check', consumer]);
    assert.match(await readFile(join(consumer, 'src/site/styles.css'), 'utf8'), /template upgrade fixture/);
    await writeFile(join(snapshot, 'src/site/styles.css'), stylesheet);
    invoke(['apply', consumer, '--update']);
    invoke(['check', consumer]);
    assert.equal(await readFile(join(consumer, 'src/site/styles.css'), 'utf8'), stylesheet);
    assert.equal(await readFile(join(consumer, 'site.config.json'), 'utf8'), config);
    assert.equal(await readFile(join(consumer, 'theme.css'), 'utf8'), theme);
    assert.ok(bytes.equals(await readFile(join(consumer, 'cards', `${card.id}.webcard`))));
    assert.ok(collection.equals(await readFile(join(consumer, 'cards/collection.json'))));
    const pkg = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'custom-consumer');
    assert.equal(pkg.description, 'Instance-owned');
    assert.equal(pkg.scripts.build, 'node scripts/build-site.js');
    assert.ok((await readFile(join(consumer, '.knitto.lock'), 'utf8')).includes('sha256:'));
    const fixture = 'tests/fixtures/spec-minimal/assets/sha256/01ccfcbb2f0635b02dc28020140fae2e23466f5c8a0b431d968b5898dd926412.webp.base64';
    assert.ok((await readFile(join(root, fixture))).equals(await readFile(join(consumer, fixture))));
    await symlink(join(root, 'node_modules'), join(consumer, 'node_modules'), 'dir');
    execFileSync('npm', ['test'], { cwd: consumer, encoding: 'utf8' });
    execFileSync('npm', ['run', 'test:browser'], { cwd: consumer, encoding: 'utf8' });
    console.log('Template bootstrap, upgrade, rollback, owned metadata/theme/cards, and digest lock verified');
    console.log('Generated consumer unit and browser suites passed with non-default instance configuration');
  } finally {
    await rm(consumer, { recursive: true });
    await rm(snapshot, { recursive: true });
  }
}
