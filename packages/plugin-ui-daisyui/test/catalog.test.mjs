import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGeneratedSource,
  mergeManifestWithUpstreamCatalog,
  readManifest,
  readUpstreamCatalog,
  validateManifest,
} from '../../talisman-cms/scripts/ui-library-manifest.mjs';
import { daisyUiLibrary, daisyUiPlugin } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(packageRoot, 'catalog.manifest.json');
const upstreamPath = path.join(packageRoot, 'catalog.upstream.json');

test('generated Daisy library preserves the existing runtime registration', () => {
  const manifest = readManifest(manifestPath);
  const library = daisyUiLibrary();
  const plugin = daisyUiPlugin();
  const expectedBlocks = manifest.items
    .filter((item) => item.coverageStatus !== 'unsupported' && item.adapter?.kind === 'block')
    .map((item) => item.adapter.slug)
    .sort();
  const expectedComponents = manifest.items
    .filter((item) => item.coverageStatus !== 'unsupported' && item.adapter?.kind === 'component')
    .map((item) => item.adapter.slug)
    .sort();

  assert.equal(library.id, 'daisyui');
  assert.deepEqual(
    library.blocks?.map((entry) => entry.block.slug).sort(),
    expectedBlocks,
  );
  assert.deepEqual(
    library.components?.map((entry) => entry.component.slug).sort(),
    expectedComponents,
  );
  assert.equal(plugin.uiLibraries?.[0]?.id, 'daisyui');
  assert.equal(library.presets?.[0]?.componentSlug, 'daisyButtonAction');
});

test('Daisy generation keeps handwritten renderer mappings and emits block/component adapters', () => {
  const manifest = readManifest(manifestPath);
  const upstreamCatalog = readUpstreamCatalog(upstreamPath);
  const merged = mergeManifestWithUpstreamCatalog(manifest, [
    ...upstreamCatalog,
    { id: 'new-widget', name: 'New Widget', kind: 'component', category: 'Actions', variants: [] },
  ]);

  const button = merged.items.find((item) => item.upstreamItemId === 'button');
  const newWidget = merged.items.find((item) => item.upstreamItemId === 'new-widget');
  const source = createGeneratedSource({
    manifest,
    libraryExportName: 'daisyUiLibrary',
    pluginExportName: 'daisyUiPlugin',
  });

  assert.equal(
    button?.rendererTarget?.modulePath,
    '@talisman-cms/plugin-ui-daisyui/renderers/DaisyButtonAction.astro',
  );
  assert.equal(newWidget?.coverageStatus, 'unsupported');
  assert.match(source, /daisyHeroBanner/);
  assert.match(source, /daisyFeatureGrid/);
  assert.match(source, /daisyButtonAction/);
  assert.match(source, /daisyAlertNotice/);
  assert.match(source, /daisyTooltipHint/);
  assert.match(source, /daisyTabsNav/);
  assert.match(source, /daisyTimelineTrack/);
  assert.match(source, /daisyAccordionList/);
  assert.match(source, /daisyModalDialog/);
  assert.match(source, /daisyBreadcrumbTrail/);
  assert.match(source, /daisyRatingStars/);
  assert.match(source, /daisyThemeController/);
  assert.match(source, /daisyCountdownTimer/);
  assert.match(source, /daisyValidatorMessage/);
  assert.match(source, /daisyCarouselStrip/);
});

test('Daisy coverage validation flags missing upstream items and invalid complete entries', () => {
  const manifest = readManifest(manifestPath);
  const upstreamCatalog = readUpstreamCatalog(upstreamPath);
  const button = manifest.items.find((item) => item.upstreamItemId === 'button');

  const invalidManifest = {
    ...manifest,
    items: manifest.items
      .filter((item) => item.upstreamItemId !== 'tooltip')
      .map((item) => item.upstreamItemId === 'button' ? { ...item, rendererTarget: null } : item),
  };

  const validation = validateManifest(invalidManifest, upstreamCatalog);

  assert(validation.errors.some((error) => error.includes('tooltip')));
  assert(validation.errors.some((error) => error.includes('button')));
  assert.equal(button?.coverageStatus, 'complete');
});

test('generated Daisy source file exists and is checked in', () => {
  const generated = readFileSync(path.join(packageRoot, 'src/generated.ts'), 'utf8');
  assert.match(generated, /export function daisyUiLibrary/);
});
