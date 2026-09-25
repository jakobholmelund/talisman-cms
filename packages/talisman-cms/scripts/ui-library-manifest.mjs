import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim() !== ''))];
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortedById(values, key = 'id') {
  return [...values].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function normalizeRelationships(relationships) {
  return {
    slots: toArray(relationships?.slots).map((slot) => ({
      name: slot?.name || '',
      label: slot?.label || '',
      description: slot?.description || undefined,
      hasMany: slot?.hasMany !== false,
      componentItemIds: unique(toArray(slot?.componentItemIds)),
      componentAdapterSlugs: unique(toArray(slot?.componentAdapterSlugs)),
      allowInline: slot?.allowInline !== false,
      allowReferences: slot?.allowReferences !== false,
    })),
    usedIn: toArray(relationships?.usedIn).map((usage) => ({
      itemId: usage?.itemId || '',
      slotName: usage?.slotName || '',
    })),
  };
}

function normalizeItem(item) {
  return {
    catalogOrigin: item?.catalogOrigin === 'custom' ? 'custom' : 'upstream',
    upstreamItemId: item?.upstreamItemId || '',
    upstreamItemName: item?.upstreamItemName || '',
    kind: item?.kind === 'block' ? 'block' : 'component',
    category: item?.category || '',
    variants: unique(toArray(item?.variants)),
    setupRequirements: unique(toArray(item?.setupRequirements)),
    relationships: normalizeRelationships(item?.relationships),
    coverageStatus: item?.coverageStatus,
    notes: item?.notes || undefined,
    rendererTarget: item?.rendererTarget
      ? {
          modulePath: item.rendererTarget.modulePath || '',
          localFilePath: item.rendererTarget.localFilePath || undefined,
          exportName: item.rendererTarget.exportName || undefined,
        }
      : null,
    adapter: item?.adapter ? { ...item.adapter } : undefined,
  };
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, value) {
  writeFileSync(filePath, stringifyJson(value), 'utf8');
}

export function readManifest(filePath) {
  const manifest = readJson(filePath);
  return {
    ...manifest,
    upstreamCatalog: sortedById(toArray(manifest.upstreamCatalog)),
    items: sortedById(toArray(manifest.items).map(normalizeItem), 'upstreamItemId'),
  };
}

export function readUpstreamCatalog(filePath) {
  return sortedById(toArray(readJson(filePath)).map((item) => ({
    id: item?.id || '',
    name: item?.name || '',
    kind: item?.kind === 'block' ? 'block' : 'component',
    category: item?.category || '',
    variants: unique(toArray(item?.variants)),
  })));
}

export function mergeManifestWithUpstreamCatalog(manifest, upstreamCatalog) {
  const existingById = new Map(
    toArray(manifest.items).map((item) => [item.upstreamItemId, normalizeItem(item)]),
  );

  const mergedItems = upstreamCatalog.map((catalogItem) => {
    const existing = existingById.get(catalogItem.id);
    if (!existing) {
      return normalizeItem({
        catalogOrigin: 'upstream',
        upstreamItemId: catalogItem.id,
        upstreamItemName: catalogItem.name,
        kind: catalogItem.kind,
        category: catalogItem.category,
        variants: catalogItem.variants,
        setupRequirements: [],
        relationships: { slots: [], usedIn: [] },
        coverageStatus: 'unsupported',
        notes: 'Imported from upstream catalog. Classify before release.',
        rendererTarget: null,
      });
    }

    return normalizeItem({
      ...existing,
      catalogOrigin: 'upstream',
      upstreamItemId: catalogItem.id,
      upstreamItemName: catalogItem.name,
      kind: catalogItem.kind,
      category: catalogItem.category,
      variants: catalogItem.variants,
    });
  });

  const customItems = toArray(manifest.items)
    .map(normalizeItem)
    .filter((item) => item.catalogOrigin === 'custom');

  return {
    ...manifest,
    upstreamCatalog,
    items: sortedById([...mergedItems, ...customItems], 'upstreamItemId'),
  };
}

export function buildCoverageReport(manifest, upstreamCatalog = manifest.upstreamCatalog) {
  const items = toArray(manifest.items).map(normalizeItem);
  const upstreamItems = toArray(upstreamCatalog);
  const upstreamIds = new Set(upstreamItems.map((item) => item.id));
  const upstreamManifestItems = items.filter((item) => item.catalogOrigin !== 'custom');
  const itemsById = new Map(upstreamManifestItems.map((item) => [item.upstreamItemId, item]));

  const missingItemIds = upstreamItems
    .filter((item) => !itemsById.has(item.id))
    .map((item) => item.id);

  const unclassifiedItemIds = upstreamItems
    .map((item) => itemsById.get(item.id))
    .filter(Boolean)
    .filter((item) => !['complete', 'partial', 'unsupported'].includes(item.coverageStatus))
    .map((item) => item.upstreamItemId);

  const invalidCompleteItemIds = upstreamItems
    .map((item) => itemsById.get(item.id))
    .filter(Boolean)
    .filter((item) => item.coverageStatus === 'complete')
    .filter((item) => {
      const hasAdapter = Boolean(item.adapter && item.adapter.slug && Array.isArray(item.adapter.fields));
      const hasRenderer = Boolean(item.rendererTarget?.modulePath);
      return !hasAdapter || !hasRenderer;
    })
    .map((item) => item.upstreamItemId);

  const manifestOnlyUpstreamItemIds = upstreamManifestItems
    .filter((item) => !upstreamIds.has(item.upstreamItemId))
    .map((item) => item.upstreamItemId);

  const countedItems = upstreamItems
    .map((item) => itemsById.get(item.id))
    .filter(Boolean);

  const completeCount = countedItems.filter((item) => item.coverageStatus === 'complete').length;
  const partialCount = countedItems.filter((item) => item.coverageStatus === 'partial').length;
  const unsupportedCount = countedItems.filter((item) => item.coverageStatus === 'unsupported').length;
  const customCount = items.filter((item) => item.catalogOrigin === 'custom').length;

  return {
    libraryId: manifest.library?.id || 'unknown',
    totalUpstreamItems: upstreamItems.length,
    completeCount,
    partialCount,
    unsupportedCount,
    customCount,
    missingItemIds,
    unclassifiedItemIds,
    manifestOnlyUpstreamItemIds,
    invalidCompleteItemIds,
    hasErrors:
      missingItemIds.length > 0 ||
      unclassifiedItemIds.length > 0 ||
      invalidCompleteItemIds.length > 0 ||
      manifestOnlyUpstreamItemIds.length > 0,
  };
}

export function validateManifest(manifest, upstreamCatalog = manifest.upstreamCatalog) {
  const errors = [];
  const report = buildCoverageReport(manifest, upstreamCatalog);
  const items = toArray(manifest.items).map(normalizeItem);
  const upstreamIds = new Set(toArray(upstreamCatalog).map((item) => item.id));
  const itemIds = new Set();

  if (!manifest?.pluginName) errors.push('Manifest is missing pluginName.');
  if (!manifest?.library?.id) errors.push('Manifest is missing library.id.');
  if (!manifest?.library?.name) errors.push('Manifest is missing library.name.');
  if (!Array.isArray(manifest?.library?.requirements)) errors.push('Manifest is missing library.requirements.');
  if (!manifest?.generation?.generatedFilePath) errors.push('Manifest is missing generation.generatedFilePath.');

  for (const requirement of toArray(manifest?.library?.requirements)) {
    if (!requirement?.id || !requirement?.kind || !requirement?.label || !requirement?.value) {
      errors.push(`Requirement ${JSON.stringify(requirement)} is missing required fields.`);
    }
  }

  for (const item of items) {
    if (!item.upstreamItemId) errors.push('Manifest item is missing upstreamItemId.');
    if (itemIds.has(item.upstreamItemId)) errors.push(`Duplicate manifest item id: ${item.upstreamItemId}.`);
    itemIds.add(item.upstreamItemId);
    if (!item.upstreamItemName) errors.push(`Manifest item ${item.upstreamItemId} is missing upstreamItemName.`);
    if (!item.category) errors.push(`Manifest item ${item.upstreamItemId} is missing category.`);
    if (!Array.isArray(item.variants)) errors.push(`Manifest item ${item.upstreamItemId} variants must be an array.`);
    if (!Array.isArray(item.setupRequirements)) errors.push(`Manifest item ${item.upstreamItemId} setupRequirements must be an array.`);
    if (!isObject(item.relationships)) errors.push(`Manifest item ${item.upstreamItemId} relationships must be an object.`);
    if (!['complete', 'partial', 'unsupported'].includes(item.coverageStatus)) {
      errors.push(`Manifest item ${item.upstreamItemId} has invalid coverageStatus.`);
    }

    for (const requirementId of item.setupRequirements) {
      if (!toArray(manifest?.library?.requirements).some((requirement) => requirement.id === requirementId)) {
        errors.push(`Manifest item ${item.upstreamItemId} references unknown setup requirement ${requirementId}.`);
      }
    }

    if (item.catalogOrigin !== 'custom' && !upstreamIds.has(item.upstreamItemId)) {
      errors.push(`Manifest item ${item.upstreamItemId} is marked upstream but does not exist in the upstream catalog.`);
    }

    if (item.adapter) {
      if (!item.adapter.slug || !item.adapter.name || !Array.isArray(item.adapter.fields)) {
        errors.push(`Manifest item ${item.upstreamItemId} adapter is missing slug, name, or fields.`);
      }
      if (item.adapter.kind !== item.kind) {
        errors.push(`Manifest item ${item.upstreamItemId} adapter kind does not match item kind.`);
      }
    }

    if (item.kind === 'block') {
      for (const slot of toArray(item.relationships?.slots)) {
        if (!slot?.name || !slot?.label) {
          errors.push(`Manifest item ${item.upstreamItemId} contains a slot missing name or label.`);
        }
      }
    }
  }

  for (const missingId of report.missingItemIds) {
    errors.push(`Upstream item ${missingId} is missing from the manifest.`);
  }
  for (const invalidId of report.invalidCompleteItemIds) {
    errors.push(`Complete item ${invalidId} is missing adapter or renderer metadata.`);
  }

  return { errors, report };
}

export function formatCoverageReport(report) {
  const lines = [
    `Coverage for ${report.libraryId}`,
    `Total upstream items: ${report.totalUpstreamItems}`,
    `Complete: ${report.completeCount}`,
    `Partial: ${report.partialCount}`,
    `Unsupported: ${report.unsupportedCount}`,
    `Custom items: ${report.customCount}`,
  ];

  if (report.missingItemIds.length > 0) {
    lines.push(`Missing manifest entries: ${report.missingItemIds.join(', ')}`);
  }
  if (report.unclassifiedItemIds.length > 0) {
    lines.push(`Unclassified entries: ${report.unclassifiedItemIds.join(', ')}`);
  }
  if (report.invalidCompleteItemIds.length > 0) {
    lines.push(`Invalid complete entries: ${report.invalidCompleteItemIds.join(', ')}`);
  }
  if (report.manifestOnlyUpstreamItemIds.length > 0) {
    lines.push(`Manifest-only upstream entries: ${report.manifestOnlyUpstreamItemIds.join(', ')}`);
  }

  if (!report.hasErrors) {
    lines.push('Coverage status: OK');
  }

  return `${lines.join('\n')}\n`;
}

function serializeForTs(value) {
  return JSON.stringify(value, null, 2);
}

function resolveSlotComponents(slot, itemsById) {
  const slugs = [...toArray(slot.componentAdapterSlugs)];
  for (const itemId of toArray(slot.componentItemIds)) {
    const item = itemsById.get(itemId);
    if (!item?.adapter?.slug) {
      throw new Error(`Slot ${slot.name} references ${itemId}, but that item has no adapter slug.`);
    }
    slugs.push(item.adapter.slug);
  }

  return unique(slugs);
}

function buildBlockAdapter(manifest, item, itemsById) {
  const componentSlots = toArray(item.relationships?.slots).map((slot) => ({
    name: slot.name,
    label: slot.label,
    description: slot.description || undefined,
    hasMany: slot.hasMany !== false,
    componentsFromPlugins: resolveSlotComponents(slot, itemsById),
    allowInline: slot.allowInline !== false,
    allowReferences: slot.allowReferences !== false,
  }));

  return {
    block: {
      slug: item.adapter.slug,
      name: item.adapter.name,
      description: item.adapter.description || undefined,
      category: item.adapter.category || item.category,
      fields: toArray(item.adapter.fields),
      componentSlots,
      source: {
        plugin: manifest.pluginName,
        library: manifest.library.id,
        item: item.upstreamItemId,
      },
      tags: toArray(item.adapter.tags).length > 0 ? toArray(item.adapter.tags) : undefined,
    },
    renderer: item.rendererTarget?.modulePath
      ? {
          modulePath: item.rendererTarget.modulePath,
          exportName: item.rendererTarget.exportName || undefined,
        }
      : undefined,
  };
}

function buildComponentAdapter(manifest, item) {
  const adapter = {
    component: {
      slug: item.adapter.slug,
      name: item.adapter.name,
      description: item.adapter.description || undefined,
      category: item.adapter.category || item.category,
      fields: toArray(item.adapter.fields),
      advanced: item.adapter.advanced || undefined,
      source: {
        plugin: manifest.pluginName,
        library: manifest.library.id,
        item: item.upstreamItemId,
      },
    },
    renderer: item.rendererTarget?.modulePath
      ? {
          modulePath: item.rendererTarget.modulePath,
          exportName: item.rendererTarget.exportName || undefined,
        }
      : undefined,
    presets: toArray(item.adapter.presets).map((preset) => ({
      ...preset,
      componentSlug: item.adapter.slug,
      libraryId: manifest.library.id,
    })),
  };

  if (!adapter.presets.length) {
    delete adapter.presets;
  }

  return adapter;
}

export function createGeneratedSource({
  manifest,
  libraryExportName,
  pluginExportName,
}) {
  const items = toArray(manifest.items)
    .map(normalizeItem)
    .filter((item) => item.adapter && item.coverageStatus !== 'unsupported')
    .sort((left, right) => left.upstreamItemId.localeCompare(right.upstreamItemId));
  const itemsById = new Map(items.map((item) => [item.upstreamItemId, item]));
  const blocks = items
    .filter((item) => item.kind === 'block')
    .map((item) => buildBlockAdapter(manifest, item, itemsById));
  const components = items
    .filter((item) => item.kind === 'component')
    .map((item) => buildComponentAdapter(manifest, item));
  const requirements = toArray(manifest.library.requirements).map(({ id, ...requirement }) => requirement);

  return `import type { Plugin, UiLibraryBlockAdapter, UiLibraryComponentAdapter, UiLibraryDefinition } from 'talisman-cms';

const libraryRequirements = ${serializeForTs(requirements)} satisfies UiLibraryDefinition['requirements'];
const blockAdapters = ${serializeForTs(blocks)} satisfies UiLibraryBlockAdapter[];
const componentAdapters = ${serializeForTs(components)} satisfies UiLibraryComponentAdapter[];
const presets = componentAdapters.flatMap((component) => component.presets || []);

export function ${libraryExportName}(): UiLibraryDefinition {
  return {
    id: ${JSON.stringify(manifest.library.id)},
    name: ${JSON.stringify(manifest.library.name)},
    requirements: libraryRequirements,
    blocks: blockAdapters,
    components: componentAdapters,
    presets,
  };
}

export function ${pluginExportName}(): Plugin {
  return {
    name: ${JSON.stringify(manifest.pluginName)},
    onInit: (config: any) => config,
    uiLibraries: [${libraryExportName}()],
  };
}
`;
}

export function createRendererStubSource(item) {
  const title = item.adapter?.name || item.upstreamItemName || item.upstreamItemId;
  return `---
const props = Astro.props;
---

<section data-talisman-ui-stub=${JSON.stringify(item.upstreamItemId)}>
  <pre>{JSON.stringify({ item: ${JSON.stringify(title)}, props }, null, 2)}</pre>
</section>
`;
}

export function writeGeneratedSourceFile(filePath, source) {
  writeFileSync(filePath, source, 'utf8');
}

export function ensureRendererStubs(manifest, cwd) {
  const createdFiles = [];

  for (const item of toArray(manifest.items).map(normalizeItem)) {
    const localFilePath = item.rendererTarget?.localFilePath;
    if (!localFilePath || !item.adapter || item.coverageStatus === 'unsupported') continue;

    const absolutePath = path.resolve(cwd, localFilePath);
    if (existsSync(absolutePath)) continue;

    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, createRendererStubSource(item), 'utf8');
    createdFiles.push(localFilePath);
  }

  return createdFiles;
}
