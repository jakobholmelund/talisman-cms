import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/admin-router.ts', import.meta.url), 'utf8')
  .replace("'@tanstack/router-vite-plugin'", JSON.stringify(import.meta.resolve('@tanstack/router-vite-plugin')));
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { adminRouterPlugins } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function fixture(t, installed) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'talisman-admin-router-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ui = join(root, installed ? 'node_modules/talisman-cms/ui' : 'checkout/ui');
  mkdirSync(ui, { recursive: true });
  cpSync(new URL('../ui/routes', import.meta.url), join(ui, 'routes'), { recursive: true });
  cpSync(new URL('../ui/routeTree.gen.ts', import.meta.url), join(ui, 'routeTree.gen.ts'));
  return { root, ui };
}

test('installed npm and pnpm packages keep code splitting without a route generator', async (t) => {
  for (const nested of [false, true]) {
    const { root, ui: original } = fixture(t, true);
    const ui = nested ? join(root, 'node_modules/.pnpm/talisman-cms@0.1.0/node_modules/talisman-cms/ui') : original;
    if (nested) cpSync(original, ui, { recursive: true });
    const tree = readFileSync(join(ui, 'routeTree.gen.ts'), 'utf8');
    const plugins = [adminRouterPlugins(ui)].flat(Infinity);
    assert.ok(!plugins.some(plugin => plugin.name.includes('generator')));
    const splitter = plugins.find(plugin => plugin.name.endsWith('compile-reference-file'));
    assert.ok(splitter);
    await splitter.configResolved({ root, command: 'build', plugins });
    for (const name of ['index.tsx', 'collections/$slug/index.tsx', '$section/$slug/$entryId.tsx']) {
      const path = join(ui, 'routes', name);
      const code = readFileSync(path, 'utf8');
      const result = await splitter.transform.handler.call({}, code, path);
      assert.match(result.code, /lazyRouteComponent|tsr-split/, `${name} remains lazy`);
      assert.equal(readFileSync(path, 'utf8'), code);
    }
    assert.equal(readFileSync(join(ui, 'routeTree.gen.ts'), 'utf8'), tree);
  }
});

test('a workspace checkout, including a consumer symlink, retains route generation', async (t) => {
  const { root, ui } = fixture(t, false);
  const linked = join(root, 'node_modules/talisman-cms');
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(ui, '..'), linked, 'dir');
  for (const path of [ui, join(linked, 'ui')]) {
    const plugins = [adminRouterPlugins(path)].flat(Infinity);
    const generator = plugins.find(plugin => plugin.name.includes('generator'));
    assert.ok(generator);
    writeFileSync(join(ui, 'routes/route-regression.tsx'), "import { createFileRoute } from '@tanstack/react-router';\nexport const Route = createFileRoute('/route-regression')({});\n");
    await generator.configResolved({ root });
    assert.match(readFileSync(join(ui, 'routeTree.gen.ts'), 'utf8'), /route-regression/);
  }
});

test('a malformed shipped route fails visibly instead of silently loading eagerly', (t) => {
  const { ui } = fixture(t, true);
  writeFileSync(join(ui, 'routes/index.tsx'), 'export const Route = createFileRoute(dynamicId)({});');
  assert.throws(() => adminRouterPlugins(ui), /missing generated route ID/);
});
