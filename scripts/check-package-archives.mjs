import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const archiveDir = mkdtempSync(join(tmpdir(), 'talisman-release-'));
const licenseText = readFileSync(join(root, 'LICENSE.md'), 'utf8');
// Each package keeps a copy of the root NOTICE, because pnpm packs only files inside the package.
const noticeText = readFileSync(join(root, 'NOTICE'), 'utf8');
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).license, 'Apache-2.0');
assert.match(licenseText, /Apache License\s+Version 2\.0, January 2004/);

function targets(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(targets);
  return [];
}

try {
  for (const packageDir of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!packageDir.isDirectory()) continue;
    const cwd = join(root, 'packages', packageDir.name);
    const archive = execFileSync('pnpm', ['pack', '--pack-destination', archiveDir], {
      cwd,
      encoding: 'utf8',
    }).trim().split('\n').at(-1);
    assert.ok(archive?.endsWith('.tgz'), `${packageDir.name}: pack did not create an archive`);

    const entries = new Set(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'));
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
    assert.ok(entries.has('package/LICENSE.md'), `${manifest.name}: missing license text`);
    assert.equal(manifest.license, 'Apache-2.0', `${manifest.name}: incorrect license metadata`);
    if (manifest.name.startsWith('@talisman-cms/')) {
      assert.equal(manifest.publishConfig?.access, 'public', `${manifest.name}: scoped package must publish publicly`);
    }
    const packedLicense = execFileSync('tar', ['-xOzf', archive, 'package/LICENSE.md'], { encoding: 'utf8' });
    assert.equal(packedLicense, licenseText, `${manifest.name}: packed license differs from repository license`);
    assert.ok(entries.has('package/NOTICE'), `${manifest.name}: missing NOTICE (add "NOTICE" to files and copy the root NOTICE)`);
    const packedNotice = execFileSync('tar', ['-xOzf', archive, 'package/NOTICE'], { encoding: 'utf8' });
    assert.equal(packedNotice, noticeText, `${manifest.name}: packed NOTICE differs from the root NOTICE; copy it again`);
    for (const rawTarget of [...targets(manifest.exports), manifest.main, manifest.types].filter(Boolean)) {
      const target = rawTarget.startsWith('./') ? rawTarget.slice(2) : rawTarget;
      assert.ok(!target.startsWith('/') && !target.includes('..'), `${manifest.name}: unexpected export target ${rawTarget}`);
      if (target.includes('*')) {
        const prefix = `package/${target.split('*')[0]}`;
        assert.ok([...entries].some((entry) => entry.startsWith(prefix)), `${manifest.name}: empty export ${target}`);
      } else {
        assert.ok(entries.has(`package/${target}`), `${manifest.name}: missing export ${target}`);
      }
    }
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      assert.ok(!version.startsWith('workspace:'), `${manifest.name}: unresolved dependency ${name}`);
    }
    if (manifest.name === 'talisman-cms') {
      const journal = JSON.parse(readFileSync(join(cwd, 'drizzle', 'meta', '_journal.json'), 'utf8'));
      assert.ok(journal.entries?.length, 'talisman-cms: migration journal is empty');
      for (const { tag } of journal.entries) {
        assert.ok(entries.has(`package/drizzle/${tag}.sql`), `talisman-cms: missing migration ${tag}`);
      }
    }
    console.log(`${manifest.name}@${manifest.version}: ${entries.size} archived files; exports and dependencies verified`);
  }
} finally {
  rmSync(archiveDir, { recursive: true, force: true });
}
