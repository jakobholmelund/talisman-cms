import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validateRenderers } from '../scripts/renderers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCoverageReport,
  createGeneratedSource,
  readManifest,
  readUpstreamCatalog,
  validateManifest,
} from '../../talisman-cms/scripts/ui-library-manifest.mjs';
import { starwindUiLibrary, starwindUiPlugin } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(packageRoot, 'catalog.manifest.json');
const upstreamPath = path.join(packageRoot, 'catalog.upstream.json');

test('generated Starwind library preserves the existing runtime registration', () => {
  const library = starwindUiLibrary();
  const plugin = starwindUiPlugin();

  assert.equal(library.id, 'starwind');
  assert.deepEqual(
    library.blocks?.map((entry) => entry.block.slug).sort(),
    ['starwindMetricsBand', 'starwindSplitFeature'],
  );
  assert.deepEqual(
    library.components?.map((entry) => entry.component.slug).sort(),
    ['starwindMetric', 'starwindTextLink'],
  );
  assert.equal(plugin.uiLibraries?.[0]?.id, 'starwind');
  assert.equal(library.presets?.[0]?.componentSlug, 'starwindMetric');
});

test('Starwind accounting distinguishes four shipped custom compositions from 46 unsupported upstream entries', () => {
  const manifest = readManifest(manifestPath);
  const upstreamCatalog = readUpstreamCatalog(upstreamPath);
  const report = buildCoverageReport(manifest, upstreamCatalog);
  const source = createGeneratedSource({
    manifest,
    libraryExportName: 'starwindUiLibrary',
    pluginExportName: 'starwindUiPlugin',
  });

  assert.equal(report.totalUpstreamItems, 46);
  assert.equal(report.completeCount, 0);
  assert.equal(report.partialCount, 0);
  assert.equal(report.unsupportedCount, 46);
  assert.equal(report.customCount, 4);
  assert.match(source, /starwindSplitFeature/);
  assert.match(source, /starwindMetricsBand/);
  assert.doesNotMatch(source, /Alert Dialog/);
});

test('Starwind coverage validation flags missing upstream items', () => {
  const manifest = readManifest(manifestPath);
  const upstreamCatalog = readUpstreamCatalog(upstreamPath);
  const invalidManifest = {
    ...manifest,
    items: manifest.items.filter((item) => item.upstreamItemId !== 'accordion'),
  };

  const validation = validateManifest(invalidManifest, upstreamCatalog);

  assert(validation.errors.some((error) => error.includes('accordion')));
});

test('generated Starwind source file exists and is checked in', () => {
  const generated = readFileSync(path.join(packageRoot, 'src/generated.ts'), 'utf8');
  const manifest = readManifest(manifestPath);
  assert.equal(generated, createGeneratedSource({ manifest, libraryExportName: 'starwindUiLibrary', pluginExportName: 'starwindUiPlugin' }));
});


test('the editor registers only custom compositions and the required renderer scan', () => {
  const manifest = readManifest(manifestPath);
  const library = starwindUiLibrary();
  assert.equal(library.name, 'Starwind (Talisman compositions)');
  assert.equal(library.requirements.length, 1);
  assert.equal(library.requirements[0].optional, undefined);
  assert.match(library.requirements[0].value, /@source.*plugin-ui-starwind\/src\/renderers/);
  assert.doesNotMatch(JSON.stringify(library), /@starwind\/ui|Starwind styles/);
  for (const entry of [...library.blocks.map((entry) => entry.block), ...library.components.map((entry) => entry.component)]) {
    assert.match(entry.name, /\(custom\)/);
    assert.match(entry.description, /Custom Talisman composition/);
  }
  for (const item of manifest.items.filter((item) => item.catalogOrigin === 'upstream')) {
    assert.equal(item.coverageStatus, 'unsupported');
    assert.equal(item.rendererTarget, null);
    assert.equal(item.adapter, undefined);
    assert.deepEqual(item.setupRequirements, []);
  }
  assert.deepEqual(validateRenderers(manifest, packageRoot), []);
});

test('supported custom entries fail validation when their renderer is missing or a generated stub', () => {
  const manifest = readManifest(manifestPath);
  const item = manifest.items.find((item) => item.catalogOrigin === 'custom');
  const fixture = mkdtempSync(path.join(tmpdir(), 'starwind-catalog-'));
  try {
    const supported = { ...manifest, items: [item] };
    assert.match(validateRenderers(supported, fixture).join(' '), /does not exist/);
    const file = path.join(fixture, item.rendererTarget.localFilePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '<section data-talisman-ui-stub="metric"><pre>placeholder</pre></section>');
    assert.match(validateRenderers(supported, fixture).join(' '), /placeholder/);
    assert.match(validateRenderers({ ...supported, items: [{ ...item, rendererTarget: null }] }, fixture).join(' '), /needs an adapter and a local renderer/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
