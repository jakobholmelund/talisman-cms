import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
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

test('Starwind coverage is complete for catalog accounting even when upstream items are unsupported', () => {
  const manifest = readManifest(manifestPath);
  const upstreamCatalog = readUpstreamCatalog(upstreamPath);
  const report = buildCoverageReport(manifest, upstreamCatalog);
  const source = createGeneratedSource({
    manifest,
    libraryExportName: 'starwindUiLibrary',
    pluginExportName: 'starwindUiPlugin',
  });

  assert.equal(report.totalUpstreamItems, 46);
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
  assert.match(generated, /export function starwindUiLibrary/);
});
