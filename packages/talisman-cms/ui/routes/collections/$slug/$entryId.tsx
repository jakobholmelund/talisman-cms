import React, { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { uiLibraries as configuredUiLibraries } from 'virtual:talisman-cms/ui-libraries';
import { Card, CardContent } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { ArrowDown, ArrowLeft, ArrowUp, Archive, ChevronDown, ChevronRight, Clock3, Database, GripVertical, History, Plus, Save, Send } from 'lucide-react';
import { BlockLibraryPicker } from '../../../components/BlockLibraryPicker';
import { ComponentSlotPicker } from '../../../components/ComponentSlotPicker';
import { MediaFieldInput } from '../../../components/MediaFieldInput';
import { PageBuilderComposer } from '../../../components/PageBuilderComposer';
import { RichTextEditor } from '../../../components/RichTextEditor';
import { getSectionCollectionRoute, getSectionEntryRoute, type AdminSection } from '../../../lib/admin-sections';
import {
  describeCommerceEntry,
  getCommerceFlowSummary,
  getCommerceModelGuide,
  getCommerceSupportSlugs,
  getEntryData,
  getRelationOptionLabel,
  type CommerceSupportEntries,
} from '../../../lib/commerce-models';
import {
  getRelationOptionKey,
  getRelationTargets,
  isPolymorphicRelationField,
  isRelationReference,
  type RelationReference,
} from '../../../lib/page-builder';
import {
  buildBlockValue,
  buildDefaultValues,
  buildInlineComponentValue,
  buildPresetReferenceValue,
  collectRelationshipFields,
  getBlockPreviewSummary,
  getCollapsedCardsStorageKey,
  getComponentSlotItems,
  getComponentPreviewSummary,
  getPresetClientSchema,
  getPresetComponentSlug,
  getPresetRecordLabel,
  getZodClientSchemaForFields,
  insertArrayItem,
  isPresetReferenceValue,
  isRelationshipFieldType,
  moveArrayItem,
  normalizeStoredFieldData,
  readCollapsedCardsState,
  writeCollapsedCardsState,
} from '../../../lib/page-builder';
import { validatePresetPayload } from '../../../../src/presets';

type RelationOptionRecord = {
  collectionSlug: string;
  entry: any;
};

function normalizeRelationSelections(field: any, value: any): RelationReference[] {
  const relationTargets = getRelationTargets(field);
  if (relationTargets.length === 0 || value === undefined || value === null || value === '') {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];

  if (isPolymorphicRelationField(field)) {
    return values.filter(isRelationReference);
  }

  const relationTo = relationTargets[0];
  return values.flatMap((item: any) => {
    if (typeof item === 'string') {
      return [{ relationTo, value: item }];
    }

    if (isRelationReference(item)) {
      return [{ relationTo, value: item.value }];
    }

    if (item && typeof item === 'object' && typeof item.id === 'string') {
      return [{ relationTo, value: item.id }];
    }

    return [];
  });
}

function serializeRelationSelections(field: any, selections: RelationReference[]) {
  if (field.hasMany) {
    return isPolymorphicRelationField(field)
      ? selections
      : selections.map((selection) => selection.value);
  }

  if (isPolymorphicRelationField(field)) {
    return selections[0] || null;
  }

  return selections[0]?.value || '';
}

function getRelationSelectionKey(selection: RelationReference) {
  return `${selection.relationTo}:${selection.value}`;
}

function getRelationOptionsForField(field: any, relationOptions: Record<string, RelationOptionRecord[]>) {
  return relationOptions[getRelationOptionKey(field)] || [];
}

function collectionNeedsPresetEntries(collection: any) {
  return (collection?.fields || []).some((field: any) =>
    field.type === 'blocks' &&
    (field.blocks || []).some((block: any) =>
      (block.componentSlots || []).some((slot: any) => slot.allowReferences)
    )
  );
}

export const Route = createFileRoute('/collections/$slug/$entryId')({
  component: CollectionsEntryEditorRoute,
  loader: async ({ params, context }) => loadEntryEditorData(context.adminBasePath || '/admin', params.slug, params.entryId)
});

export async function loadEntryEditorData(basePath: string, slug: string, entryId: string) {
  const isNew = entryId === 'new';

  const [collectionRes] = await Promise.all([
    fetch(`${basePath}/api/collections`),
  ]);
  
  if (!collectionRes.ok) throw new Error('Failed to fetch collection');
  const collections = await collectionRes.json() as any[];
  const collection = collections.find((c: any) => c.slug === slug);

  let entry = null;
  let revisions: any[] = [];
  if (!isNew) {
    const [entryRes, revisionsRes] = await Promise.all([
      fetch(`${basePath}/api/collections/${slug}/entries/${entryId}`),
      fetch(`${basePath}/api/collections/${slug}/entries/${entryId}/revisions`)
    ]);

    if (entryRes.ok) {
      entry = await entryRes.json();
    }

    if (revisionsRes.ok) {
      revisions = await revisionsRes.json();
    }
  }

  const relationOptions: Record<string, RelationOptionRecord[]> = {};
  const relationSupportEntries: CommerceSupportEntries = {};
  if (collection && collection.fields) {
    const relationFields = collectRelationshipFields(collection.fields);
    const relationTargets = [...new Set(relationFields.flatMap((field: any) => getRelationTargets(field)))];
    const supportSlugs = getCommerceSupportSlugs(collection.slug, relationTargets);
    if (collectionNeedsPresetEntries(collection)) {
      supportSlugs.push('_ui_component_presets');
    }
    const relationEntriesBySlug = new Map<string, any[]>();

    for (const relationTo of supportSlugs) {
      const res = await fetch(`${basePath}/api/collections/${relationTo}/entries`);
      const entries = (res.ok ? await res.json() : []) as any[];
      relationEntriesBySlug.set(relationTo, entries);
      relationSupportEntries[relationTo] = entries;
    }

    for (const field of relationFields) {
      relationOptions[getRelationOptionKey(field)] = getRelationTargets(field).flatMap((relationTo) =>
        (relationEntriesBySlug.get(relationTo) || []).map((entry) => ({
          collectionSlug: relationTo,
          entry,
        }))
      );
    }
  }

  return { collection, entry, revisions, isNew, relationOptions, relationSupportEntries };
}

import { useForm } from '@tanstack/react-form';
function getNativeIdColumn(collection: any) {
  return collection?.nativeSchemaMapping?.idColumn || 'id';
}

function isNativeCollection(collection: any) {
  return Boolean(collection?.nativeSchemaMapping);
}

function getEditorFields(collection: any, isNew: boolean) {
  if (!collection?.fields) return [];

  return collection.fields.filter((field: any) => {
    if (!isNativeCollection(collection)) {
      return true;
    }

    if (field.name === 'createdAt' || field.name === 'updatedAt') {
      return false;
    }

    if (!isNew && field.name === getNativeIdColumn(collection)) {
      return false;
    }

    return true;
  });
}

function parseEntryData(entry: any, fields?: any[]) {
  if (!entry?.data) return {};
  const parsed = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
  return normalizeStoredFieldData(fields, parsed);
}

function getEntryStatus(entry: any, collection: any) {
  if (isNativeCollection(collection)) {
    const data = parseEntryData(entry, collection?.fields);
    return typeof data?.status === 'string' && data.status.length > 0 ? data.status : 'synced';
  }

  return entry?.status || 'draft';
}

function getStatusBadgeClass(status: string) {
  const normalized = status.toLowerCase();

  if (normalized === 'published' || normalized === 'active' || normalized === 'paid' || normalized === 'fulfilled' || normalized === 'synced') {
    return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
  }

  if (normalized === 'archived' || normalized === 'cancelled') {
    return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
  }

  return 'bg-zinc-900 text-zinc-200 border-white/10';
}

function addSlotValue(slot: any, fieldApi: any, nextValue: any) {
  if (slot.hasMany) {
    fieldApi.pushValue(nextValue);
    return;
  }

  fieldApi.handleChange(nextValue);
  fieldApi.handleBlur();
}

function removeSlotValue(slot: any, fieldApi: any, index: number) {
  if (slot.hasMany) {
    fieldApi.removeValue(index);
    return;
  }

  fieldApi.handleChange(null);
  fieldApi.handleBlur();
}

function reorderFieldArrayValue(fieldApi: any, fromIndex: number, toIndex: number) {
  const currentValue = Array.isArray(fieldApi.state.value) ? fieldApi.state.value : [];
  const nextValue = moveArrayItem(currentValue, fromIndex, toIndex);

  if (nextValue === currentValue) {
    return;
  }

  fieldApi.handleChange(nextValue);
  fieldApi.handleBlur();
}

function insertFieldArrayValue(fieldApi: any, index: number, nextValue: any) {
  const currentValue = Array.isArray(fieldApi.state.value) ? fieldApi.state.value : [];
  fieldApi.handleChange(insertArrayItem(currentValue, index, nextValue));
  fieldApi.handleBlur();
}

function insertSlotValue(slot: any, fieldApi: any, index: number | null, nextValue: any) {
  if (!slot.hasMany || index === null) {
    addSlotValue(slot, fieldApi, nextValue);
    return;
  }

  insertFieldArrayValue(fieldApi, index, nextValue);
}

function getAllowedPresetEntries(slot: any, presetEntries: any[]) {
  const allowedComponentSlugs = new Set((slot.components || []).map((component: any) => component.slug));
  return presetEntries.filter((preset) => allowedComponentSlugs.has(getPresetComponentSlug(preset)));
}

function isComponentPresetCollection(collection: any) {
  return collection?.slug === '_ui_component_presets';
}

function parsePresetPropsJson(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') return {};

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function buildPresetEditorDefaults(entry: any, editorFields: any[]) {
  const base = entry?.data ? parseEntryData(entry, editorFields) : buildDefaultValues(editorFields);
  return {
    ...base,
    presetProps: parsePresetPropsJson(base.propsJson),
  };
}

function getLibraryDefinitions() {
  return configuredUiLibraries || [];
}

function getLibraryComponentDefinition(libraryId: string | undefined, componentSlug: string | undefined) {
  if (!libraryId || !componentSlug) return null;
  return getLibraryDefinitions()
    .find((library: any) => library.id === libraryId)
    ?.components?.find((componentAdapter: any) => componentAdapter.component.slug === componentSlug)
    ?.component || null;
}

function RelationFieldSummary({
  field,
  value,
  relationSupportEntries,
}: {
  field: any;
  value: any;
  relationSupportEntries: CommerceSupportEntries;
}) {
  const selections = normalizeRelationSelections(field, value);
  if (!field.relationTo || selections.length === 0) {
    return null;
  }

  const selectedEntries = selections
    .map((selection) => ({
      collectionSlug: selection.relationTo,
      entry: (relationSupportEntries[selection.relationTo] || []).find((option: any) => option.id === selection.value) || null,
      value: selection.value,
    }));

  if (selectedEntries.every((selection) => !selection.entry)) {
    return (
      <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
        Selected relation could not be resolved from the current dataset.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {selectedEntries.map((selection) => {
        if (!selection.entry) {
          return (
            <div key={`${selection.collectionSlug}:${selection.value}`} className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Missing record in <span className="font-semibold">{selection.collectionSlug}</span>: {selection.value}
            </div>
          );
        }

        const description = describeCommerceEntry(selection.collectionSlug, selection.entry, relationSupportEntries);
        return (
          <div key={`${selection.collectionSlug}:${selection.entry.id}`} className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium text-zinc-100">{description.title}</div>
              {isPolymorphicRelationField(field) && (
                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                  {selection.collectionSlug}
                </span>
              )}
            </div>
            {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
            {description.details.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {description.details.map((detail) => (
                  <span key={detail} className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-zinc-300">
                    {detail}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RelationshipPicker({
  field,
  value,
  onChange,
  onBlur,
  relationOptions,
  relationSupportEntries,
}: {
  field: any;
  value: any;
  onChange: (value: any) => void;
  onBlur: () => void;
  relationOptions: Record<string, RelationOptionRecord[]>;
  relationSupportEntries: CommerceSupportEntries;
}) {
  const [query, setQuery] = useState('');
  const options = getRelationOptionsForField(field, relationOptions);
  const selections = normalizeRelationSelections(field, value);
  const selectedKeys = new Set(selections.map(getRelationSelectionKey));
  const filteredOptions = options.filter((option) => {
    const label = getRelationOptionLabel(option.collectionSlug, option.entry, relationSupportEntries).toLowerCase();
    const subtitle = describeCommerceEntry(option.collectionSlug, option.entry, relationSupportEntries).subtitle.toLowerCase();
    const search = query.trim().toLowerCase();

    if (!search) return true;
    return label.includes(search) || subtitle.includes(search) || option.collectionSlug.toLowerCase().includes(search);
  });

  function commitSelections(nextSelections: RelationReference[]) {
    onChange(serializeRelationSelections(field, nextSelections));
    onBlur();
  }

  function addSelection(collectionSlug: string, entryId: string) {
    const nextSelection = { relationTo: collectionSlug, value: entryId };
    if (field.hasMany) {
      if (selectedKeys.has(getRelationSelectionKey(nextSelection))) return;
      commitSelections([...selections, nextSelection]);
      return;
    }

    commitSelections([nextSelection]);
  }

  function removeSelection(selectionToRemove: RelationReference) {
    commitSelections(selections.filter((selection) => getRelationSelectionKey(selection) !== getRelationSelectionKey(selectionToRemove)));
  }

  function moveSelection(selectionToMove: RelationReference, direction: -1 | 1) {
    const index = selections.findIndex((selection) => getRelationSelectionKey(selection) === getRelationSelectionKey(selectionToMove));
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= selections.length) return;

    const nextSelections = [...selections];
    const [selection] = nextSelections.splice(index, 1);
    nextSelections.splice(targetIndex, 0, selection);
    commitSelections(nextSelections);
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${field.label.toLowerCase()}...`}
        className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm text-zinc-100 shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
      />

      {selections.length > 0 && (
        <div className="space-y-2">
          {selections.map((selection, index) => {
            const entry = (relationSupportEntries[selection.relationTo] || []).find((candidate: any) => candidate.id === selection.value) || null;
            const description = describeCommerceEntry(selection.relationTo, entry, relationSupportEntries);

            return (
              <div key={getRelationSelectionKey(selection)} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{description.title}</span>
                      <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                        {selection.relationTo}
                      </span>
                    </div>
                    {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {field.hasMany && (
                      <>
                        <Button type="button" size="sm" variant="outline" onClick={() => moveSelection(selection, -1)} disabled={index === 0}>
                          Up
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => moveSelection(selection, 1)} disabled={index === selections.length - 1}>
                          Down
                        </Button>
                      </>
                    )}
                    <Button type="button" size="sm" variant="destructive" onClick={() => removeSelection(selection)}>
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950/30">
        {filteredOptions.length === 0 ? (
          <div className="px-3 py-4 text-sm text-zinc-500">No entries matched this search.</div>
        ) : (
          filteredOptions.map((option) => {
            const description = describeCommerceEntry(option.collectionSlug, option.entry, relationSupportEntries);
            const selection = { relationTo: option.collectionSlug, value: option.entry.id };
            const isSelected = selectedKeys.has(getRelationSelectionKey(selection));

            return (
              <button
                key={`${option.collectionSlug}:${option.entry.id}`}
                type="button"
                onClick={() => addSelection(option.collectionSlug, option.entry.id)}
                disabled={field.hasMany ? isSelected : false}
                className={`flex w-full items-start justify-between gap-4 border-b border-white/5 px-3 py-3 text-left transition-colors last:border-b-0 ${isSelected ? 'bg-indigo-500/10' : 'hover:bg-white/[0.04]'}`}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{description.title}</span>
                    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                      {option.collectionSlug}
                    </span>
                  </div>
                  {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
                </div>
                <span className="text-xs text-zinc-400">{isSelected ? 'Selected' : field.hasMany ? 'Add' : 'Choose'}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function CommerceModelGuide({
  collectionSlug,
  values,
  relationSupportEntries,
}: {
  collectionSlug: string;
  values: Record<string, any>;
  relationSupportEntries: CommerceSupportEntries;
}) {
  const guide = getCommerceModelGuide(collectionSlug);
  const flowSummary = getCommerceFlowSummary(collectionSlug, values, relationSupportEntries);

  if (!guide && flowSummary.length === 0) return null;

  return (
    <div className="space-y-4 rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-5">
      {guide && (
        <>
          <div>
            <div className="text-sm font-semibold text-sky-100">{guide.title}</div>
            <p className="mt-2 text-sm leading-relaxed text-sky-50/80">{guide.body}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {guide.steps.map((step, index) => (
              <span key={`${step}-${index}`} className="rounded-full border border-sky-400/20 bg-black/20 px-2.5 py-1 text-[11px] uppercase tracking-wider text-sky-100/90">
                {index + 1}. {step}
              </span>
            ))}
          </div>
        </>
      )}
      {flowSummary.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {flowSummary.map((item) => (
            <div key={item.label} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.2em] text-sky-100/60">{item.label}</div>
              <div className="mt-1 text-sm text-white">{item.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type ProductVariantValueDraft = {
  localId: string;
  id: string | null;
  value: string;
  sku: string;
  image: string;
  priceOverride: string;
  stockId: string | null;
  stockQuantity: string;
};

type ProductVariantGroupDraft = {
  localId: string;
  id: string | null;
  variantId: string;
  name: string;
  sku: string;
  priceOverride: string;
  inventoryQuantity: string;
  values: ProductVariantValueDraft[];
};

function createDraftId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function asDraftString(value: unknown, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toOptionalNumber(value: string) {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toRequiredNumber(value: string, fallback = 0) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function isCommerceProductCollection(collection: any) {
  return collection?.nativeSchemaMapping?.exportName === 'products';
}

function buildProductVariantDrafts(productId: string, relationSupportEntries: CommerceSupportEntries): ProductVariantGroupDraft[] {
  const stocksByValueId = new Map<string, any>();
  for (const stockEntry of relationSupportEntries._ecommerce_stocks || []) {
    const stockData = getEntryData(stockEntry);
    if (stockData.productVariantValueId) {
      stocksByValueId.set(stockData.productVariantValueId, stockEntry);
    }
  }

  const valuesByGroupId = new Map<string, ProductVariantValueDraft[]>();
  for (const valueEntry of relationSupportEntries._ecommerce_product_variant_values || []) {
    const valueData = getEntryData(valueEntry);
    if (!valueData.productVariantId) continue;

    const stockEntry = stocksByValueId.get(valueEntry.id);
    const stockData = getEntryData(stockEntry);
    const draft: ProductVariantValueDraft = {
      localId: valueEntry.id,
      id: valueEntry.id,
      value: asDraftString(valueData.value),
      sku: asDraftString(valueData.sku),
      image: asDraftString(valueData.image),
      priceOverride: valueData.priceOverride === undefined || valueData.priceOverride === null ? '' : String(valueData.priceOverride),
      stockId: stockEntry?.id || null,
      stockQuantity: stockData.quantity === undefined || stockData.quantity === null ? '0' : String(stockData.quantity),
    };

    const current = valuesByGroupId.get(valueData.productVariantId) || [];
    current.push(draft);
    valuesByGroupId.set(valueData.productVariantId, current);
  }

  return (relationSupportEntries._ecommerce_product_variants || [])
    .filter((entry) => getEntryData(entry).productId === productId)
    .map((entry) => {
      const data = getEntryData(entry);
      const values = valuesByGroupId.get(entry.id) || [];

      return {
        localId: entry.id,
        id: entry.id,
        variantId: asDraftString(data.variantId),
        name: asDraftString(data.name),
        sku: asDraftString(data.sku),
        priceOverride: data.priceOverride === undefined || data.priceOverride === null ? '' : String(data.priceOverride),
        inventoryQuantity: data.inventoryQuantity === undefined || data.inventoryQuantity === null ? '0' : String(data.inventoryQuantity),
        values,
      };
    });
}

type PreviewVariantOption = {
  id: string;
  label: string;
  sku: string;
  imageUrl: string | null;
  quantity: number;
  priceCents: number;
};

type PreviewVariantGroup = {
  id: string;
  label: string;
  values: PreviewVariantOption[];
};

function formatPreviewPrice(cents: number | null | undefined) {
  const normalized = typeof cents === 'number' && !Number.isNaN(cents) ? cents : 0;
  return `$${(normalized / 100).toFixed(2)}`;
}

function getProductImageUrls(productValues: Record<string, any>) {
  if (!Array.isArray(productValues.images)) return [];

  return productValues.images
    .map((image: any) => {
      if (typeof image === 'string') return image;
      if (image && typeof image.url === 'string') return image.url;
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function getProductPrimaryImageUrl(productValues: Record<string, any>) {
  return getProductImageUrls(productValues)[0] ?? null;
}

function buildPreviewVariantGroups(
  productValues: Record<string, any>,
  draftGroups: ProductVariantGroupDraft[],
  relationSupportEntries: CommerceSupportEntries
): PreviewVariantGroup[] {
  const basePrice = typeof productValues.basePrice === 'number' ? productValues.basePrice : 0;
  const definitionsById = new Map(
    (relationSupportEntries._ecommerce_variants || []).map((entry) => [entry.id, entry])
  );

  return draftGroups.map((group) => {
    const definition = group.variantId ? definitionsById.get(group.variantId) : null;
    const label = definition ? describeCommerceEntry('_ecommerce_variants', definition, relationSupportEntries).title : (group.name || 'Option group');

    return {
      id: group.localId,
      label,
      values: group.values.map((value) => ({
        id: value.localId,
        label: value.value || 'Untitled value',
        sku: value.sku,
        imageUrl: value.image.trim() || null,
        quantity: toRequiredNumber(value.stockQuantity, toRequiredNumber(group.inventoryQuantity, 0)),
        priceCents: toRequiredNumber(value.priceOverride, toOptionalNumber(group.priceOverride) ?? basePrice),
      })),
    };
  }).filter((group) => group.values.length > 0);
}

function ProductStorefrontPreview({
  productValues,
  draftGroups,
  relationSupportEntries,
}: {
  productValues: Record<string, any>;
  draftGroups: ProductVariantGroupDraft[];
  relationSupportEntries: CommerceSupportEntries;
}) {
  const imageUrls = getProductImageUrls(productValues);
  const variantGroups = buildPreviewVariantGroups(productValues, draftGroups, relationSupportEntries);
  const defaultVariant = variantGroups
    .flatMap((group) => group.values.map((value) => ({ ...value, groupLabel: group.label })))
    .find((value) => value.quantity > 0) || null;
  const previewImageUrl = defaultVariant?.imageUrl ?? getProductPrimaryImageUrl(productValues);
  const inventory = typeof productValues.inventoryQuantity === 'number' ? productValues.inventoryQuantity : 0;
  const priceCents = defaultVariant?.priceCents ?? (typeof productValues.basePrice === 'number' ? productValues.basePrice : 0);
  const title = productValues.name || productValues.title || 'Untitled product';
  const description = productValues.description || 'This product does not have a storefront description yet.';
  const productType = productValues.type || 'standard';
  const status = productValues.status || 'draft';
  const physical = productValues.isPhysical !== false;
  const inStock = defaultVariant ? defaultVariant.quantity > 0 : inventory > 0 || productType === 'digital';
  const summaryItems = [
    { label: 'Status', value: status },
    { label: 'Type', value: productType },
    { label: 'Media', value: `${imageUrls.length}` },
    { label: 'Variant groups', value: `${variantGroups.length}` },
    { label: 'Physical', value: physical ? 'Ships' : 'Digital' },
    { label: 'Availability', value: inStock ? 'In stock' : 'Preorder / unavailable' },
  ];

  return (
    <div className="space-y-5 rounded-2xl border border-fuchsia-500/20 bg-fuchsia-500/[0.05] p-5">
      <div>
        <h3 className="text-lg font-semibold text-white">Storefront Preview</h3>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-300">
          This is the customer-facing snapshot of the product you are building, based on the current product fields and variant configuration.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-zinc-950/70">
          <div className="grid gap-0 md:grid-cols-2">
            <div className="relative aspect-square overflow-hidden border-b border-white/10 bg-gradient-to-br from-white/10 via-transparent to-fuchsia-500/10 md:border-b-0 md:border-r">
              {previewImageUrl ? (
                <img src={previewImageUrl} alt={title} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-center text-sm font-medium uppercase tracking-[0.3em] text-zinc-500">
                  No hero image
                </div>
              )}
              <div className="absolute left-4 top-4 flex flex-wrap gap-2">
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${inStock ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-200'}`}>
                  {inStock ? 'In stock' : 'Unavailable'}
                </span>
                <span className="rounded-full bg-black/40 px-3 py-1 text-xs font-medium text-zinc-200">
                  {status}
                </span>
              </div>
            </div>

            <div className="space-y-6 p-6">
              <div>
                <div className="text-xs uppercase tracking-[0.25em] text-zinc-500">{productType}</div>
                <h4 className="mt-2 text-3xl font-semibold tracking-tight text-white">{title}</h4>
                <div className="mt-3 text-3xl font-black text-fuchsia-300">{formatPreviewPrice(priceCents)}</div>
              </div>

              <p className="text-sm leading-relaxed text-zinc-300">{description}</p>

              {variantGroups.length > 0 && (
                <div className="space-y-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                  {variantGroups.map((group) => (
                    <div key={group.id}>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">{group.label}</div>
                        <div className="text-[11px] text-zinc-500">{group.values.length} options</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {group.values.map((value) => {
                          const isDefault = defaultVariant?.id === value.id;
                          return (
                            <span
                              key={value.id}
                              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                                isDefault
                                  ? 'border-fuchsia-400/40 bg-fuchsia-500/20 text-fuchsia-100'
                                  : 'border-white/10 bg-white/[0.04] text-zinc-300'
                              }`}
                            >
                              {value.label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Default selection</div>
                  <div className="mt-1 text-sm text-white">
                    {defaultVariant ? `${defaultVariant.groupLabel}: ${defaultVariant.label}` : 'Standard product'}
                  </div>
                  {defaultVariant?.imageUrl && (
                    <div className="mt-2 text-xs text-fuchsia-200">Uses variant-specific image</div>
                  )}
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Availability</div>
                  <div className="mt-1 text-sm text-white">
                    {defaultVariant ? `${defaultVariant.quantity} ready to ship` : `${inventory} in base stock`}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-sm font-medium text-white">Customer-facing summary</div>
            <div className="mt-4 grid gap-3">
              {summaryItems.map((item) => (
                <div key={item.label} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{item.label}</div>
                  <div className="mt-1 text-sm text-zinc-100">{item.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-sm font-medium text-white">What shoppers will understand</div>
            <div className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-300">
              <p>The hero image and title set the first impression.</p>
              <p>The current price reflects the product base price or the default variant override.</p>
              <p>The option chips show which shopper choices exist and which one loads first.</p>
              <p>The stock summary makes it clear whether the default purchase path is available.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductVariantConfigurator({
  productId,
  relationSupportEntries,
  basePath,
  onRefresh,
  productValues,
}: {
  productId: string | null;
  relationSupportEntries: CommerceSupportEntries;
  basePath: string;
  onRefresh: () => Promise<void>;
  productValues: Record<string, any>;
}) {
  const [draftGroups, setDraftGroups] = useState<ProductVariantGroupDraft[]>([]);
  const [newDefinitionName, setNewDefinitionName] = useState('');
  const [localError, setLocalError] = useState('');
  const [localStatus, setLocalStatus] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) {
      setDraftGroups([]);
      return;
    }

    setDraftGroups(buildProductVariantDrafts(productId, relationSupportEntries));
  }, [productId, relationSupportEntries]);

  const variantDefinitions = relationSupportEntries._ecommerce_variants || [];

  const requestCollection = async (collectionSlug: string, method: 'POST' | 'PUT' | 'DELETE', payload?: Record<string, any>, id?: string) => {
    const url = id
      ? `${basePath}/api/collections/${collectionSlug}/entries/${id}`
      : `${basePath}/api/collections/${collectionSlug}/entries`;

    const res = await fetch(url, {
      method,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    if (!res.ok) {
      const errorData: any = await res.json().catch(() => ({}));
      throw new Error(errorData.error || errorData.message || `Failed to ${method} ${collectionSlug}`);
    }

    if (method === 'DELETE') {
      return null;
    }

    return res.json() as Promise<any>;
  };

  const updateGroupDraft = (localId: string, updates: Partial<ProductVariantGroupDraft>) => {
    setDraftGroups((current) =>
      current.map((group) => (group.localId === localId ? { ...group, ...updates } : group))
    );
  };

  const updateValueDraft = (groupLocalId: string, valueLocalId: string, updates: Partial<ProductVariantValueDraft>) => {
    setDraftGroups((current) =>
      current.map((group) =>
        group.localId === groupLocalId
          ? {
              ...group,
              values: group.values.map((value) => (value.localId === valueLocalId ? { ...value, ...updates } : value)),
            }
          : group
      )
    );
  };

  const addGroupDraft = () => {
    setDraftGroups((current) => [
      ...current,
      {
        localId: createDraftId('group'),
        id: null,
        variantId: '',
        name: '',
        sku: '',
        priceOverride: '',
        inventoryQuantity: '0',
        values: [],
      },
    ]);
  };

  const addValueDraft = (groupLocalId: string) => {
    setDraftGroups((current) =>
      current.map((group) =>
        group.localId === groupLocalId
          ? {
              ...group,
              values: [
                ...group.values,
                {
                  localId: createDraftId('value'),
                  id: null,
                  value: '',
                  sku: '',
                  image: '',
                  priceOverride: '',
                  stockId: null,
                  stockQuantity: '0',
                },
              ],
            }
          : group
      )
    );
  };

  const saveDefinition = async () => {
    const trimmedName = newDefinitionName.trim();
    if (!trimmedName) {
      setLocalError('Option definition name is required.');
      return;
    }

    setBusyKey('definition');
    setLocalError('');
    setLocalStatus('');

    try {
      await requestCollection('_ecommerce_variants', 'POST', { data: { name: trimmedName } });
      setNewDefinitionName('');
      await onRefresh();
      setLocalStatus(`Created option definition "${trimmedName}".`);
    } catch (error: any) {
      setLocalError(error.message);
    } finally {
      setBusyKey(null);
    }
  };

  const saveGroup = async (group: ProductVariantGroupDraft) => {
    if (!productId) {
      setLocalError('Save the product first so variant groups can attach to it.');
      return;
    }

    if (!group.name.trim()) {
      setLocalError('Variant group name is required.');
      return;
    }

    setBusyKey(`group:${group.localId}`);
    setLocalError('');
    setLocalStatus('');

    try {
      const payload = {
        data: {
          productId,
          variantId: group.variantId || undefined,
          name: group.name.trim(),
          sku: group.sku.trim() || undefined,
          priceOverride: toOptionalNumber(group.priceOverride),
          inventoryQuantity: toRequiredNumber(group.inventoryQuantity, 0),
        },
      };

      await requestCollection(
        '_ecommerce_product_variants',
        group.id ? 'PUT' : 'POST',
        payload,
        group.id || undefined
      );
      await onRefresh();
      setLocalStatus(`Saved variant group "${group.name.trim()}".`);
    } catch (error: any) {
      setLocalError(error.message);
    } finally {
      setBusyKey(null);
    }
  };

  const saveValue = async (group: ProductVariantGroupDraft, value: ProductVariantValueDraft) => {
    if (!group.id) {
      setLocalError('Save the variant group before adding values.');
      return;
    }

    if (!value.value.trim()) {
      setLocalError('Variant value label is required.');
      return;
    }

    setBusyKey(`value:${value.localId}`);
    setLocalError('');
    setLocalStatus('');

    try {
      const savedValue = await requestCollection(
        '_ecommerce_product_variant_values',
        value.id ? 'PUT' : 'POST',
        {
          data: {
            productVariantId: group.id,
            value: value.value.trim(),
            sku: value.sku.trim() || undefined,
            image: value.image.trim() || undefined,
            priceOverride: toOptionalNumber(value.priceOverride),
          },
        },
        value.id || undefined
      );

      await requestCollection(
        '_ecommerce_stocks',
        value.stockId ? 'PUT' : 'POST',
        {
          data: {
            productVariantValueId: savedValue.id,
            quantity: toRequiredNumber(value.stockQuantity, 0),
          },
        },
        value.stockId || undefined
      );

      await onRefresh();
      setLocalStatus(`Saved variant value "${value.value.trim()}".`);
    } catch (error: any) {
      setLocalError(error.message);
    } finally {
      setBusyKey(null);
    }
  };

  const deleteValue = async (groupLocalId: string, value: ProductVariantValueDraft) => {
    if (!value.id) {
      setDraftGroups((current) =>
        current.map((group) =>
          group.localId === groupLocalId
            ? { ...group, values: group.values.filter((candidate) => candidate.localId !== value.localId) }
            : group
        )
      );
      return;
    }

    if (!window.confirm(`Delete variant value "${value.value || value.id}"?`)) {
      return;
    }

    setBusyKey(`delete-value:${value.localId}`);
    setLocalError('');
    setLocalStatus('');

    try {
      if (value.stockId) {
        await requestCollection('_ecommerce_stocks', 'DELETE', undefined, value.stockId);
      }
      await requestCollection('_ecommerce_product_variant_values', 'DELETE', undefined, value.id);
      await onRefresh();
      setLocalStatus(`Deleted variant value "${value.value || value.id}".`);
    } catch (error: any) {
      setLocalError(error.message);
    } finally {
      setBusyKey(null);
    }
  };

  const deleteGroup = async (group: ProductVariantGroupDraft) => {
    if (!group.id) {
      setDraftGroups((current) => current.filter((candidate) => candidate.localId !== group.localId));
      return;
    }

    if (!window.confirm(`Delete variant group "${group.name || group.id}" and all nested values/stock rows?`)) {
      return;
    }

    setBusyKey(`delete-group:${group.localId}`);
    setLocalError('');
    setLocalStatus('');

    try {
      for (const value of group.values) {
        if (value.stockId) {
          await requestCollection('_ecommerce_stocks', 'DELETE', undefined, value.stockId);
        }
        if (value.id) {
          await requestCollection('_ecommerce_product_variant_values', 'DELETE', undefined, value.id);
        }
      }

      await requestCollection('_ecommerce_product_variants', 'DELETE', undefined, group.id);
      await onRefresh();
      setLocalStatus(`Deleted variant group "${group.name || group.id}".`);
    } catch (error: any) {
      setLocalError(error.message);
    } finally {
      setBusyKey(null);
    }
  };

  if (!productId) {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.07] p-5">
        <div className="text-sm font-semibold text-amber-100">Save Product First</div>
        <p className="mt-2 text-sm leading-relaxed text-amber-50/80">
          Variant groups, values, and stock rows attach to a saved product record. Save the product once, then configure everything here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Options &amp; stock</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-300">
            Set up the choices shoppers can make and the stock available for each one.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={addGroupDraft}>
          Add Variant Group
        </Button>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/20 p-4">
        <div className="text-sm font-medium text-zinc-100">Option Definitions</div>
        <p className="mt-1 text-xs text-zinc-400">Create reusable option families like Size, Color, or Material.</p>
        <div className="mt-4 flex flex-col gap-3 md:flex-row">
          <input
            type="text"
            value={newDefinitionName}
            onChange={(event) => setNewDefinitionName(event.target.value)}
            placeholder="e.g. Size"
            className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
          />
          <Button type="button" onClick={() => void saveDefinition()} disabled={busyKey === 'definition'}>
            {busyKey === 'definition' ? 'Creating...' : 'Create Definition'}
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {variantDefinitions.length === 0 ? (
            <span className="text-xs text-zinc-500">No option definitions yet.</span>
          ) : (
            variantDefinitions.map((definition) => (
              <span key={definition.id} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-zinc-200">
                {describeCommerceEntry('_ecommerce_variants', definition, relationSupportEntries).title}
              </span>
            ))
          )}
        </div>
      </div>

      {localError && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{localError}</div>}
      {localStatus && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">{localStatus}</div>}

      <ProductStorefrontPreview
        productValues={productValues}
        draftGroups={draftGroups}
        relationSupportEntries={relationSupportEntries}
      />

      {draftGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-black/10 p-6 text-sm text-zinc-400">
          No variant groups configured for this product yet.
        </div>
      ) : (
        <div className="space-y-5">
          {draftGroups.map((group, index) => (
            <div key={group.localId} className="rounded-xl border border-white/10 bg-black/20 p-5 space-y-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/60">Variant Group {index + 1}</div>
                  <div className="mt-1 text-base font-medium text-white">{group.name || 'Untitled variant group'}</div>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => void saveGroup(group)} disabled={busyKey === `group:${group.localId}`}>
                    {busyKey === `group:${group.localId}` ? 'Saving...' : group.id ? 'Save Group' : 'Create Group'}
                  </Button>
                  <Button type="button" variant="destructive" onClick={() => void deleteGroup(group)} disabled={busyKey === `delete-group:${group.localId}`}>
                    Delete
                  </Button>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Option Definition</label>
                  <select
                    value={group.variantId}
                    onChange={(event) => updateGroupDraft(group.localId, { variantId: event.target.value })}
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  >
                    <option value="">Select an option definition...</option>
                    {variantDefinitions.map((definition) => (
                      <option key={definition.id} value={definition.id}>
                        {describeCommerceEntry('_ecommerce_variants', definition, relationSupportEntries).title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Group Name</label>
                  <input
                    type="text"
                    value={group.name}
                    onChange={(event) => updateGroupDraft(group.localId, { name: event.target.value })}
                    placeholder="e.g. Shirt Sizes"
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">SKU Override</label>
                  <input
                    type="text"
                    value={group.sku}
                    onChange={(event) => updateGroupDraft(group.localId, { sku: event.target.value })}
                    placeholder="Optional"
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Group Price Override (Cents)</label>
                  <input
                    type="number"
                    value={group.priceOverride}
                    onChange={(event) => updateGroupDraft(group.localId, { priceOverride: event.target.value })}
                    placeholder="Optional"
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Legacy Inventory Quantity</label>
                  <input
                    type="number"
                    value={group.inventoryQuantity}
                    onChange={(event) => updateGroupDraft(group.localId, { inventoryQuantity: event.target.value })}
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  />
                </div>
              </div>

              <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Variant Values</div>
                    <p className="mt-1 text-xs text-zinc-400">These are the shopper-selectable options tied to this group.</p>
                  </div>
                  <Button type="button" variant="outline" onClick={() => addValueDraft(group.localId)} disabled={!group.id}>
                    Add Value
                  </Button>
                </div>

                {!group.id && (
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-100">
                    Save the group once before creating values and stock rows.
                  </div>
                )}

                {group.values.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/10 bg-black/10 p-4 text-sm text-zinc-500">
                    No values configured yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {group.values.map((value) => (
                      <div key={value.localId} className="rounded-lg border border-white/10 bg-black/20 p-4 space-y-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div>
                            <div className="text-sm font-medium text-white">{value.value || 'Untitled value'}</div>
                            <p className="mt-1 text-xs text-zinc-400">Stock rows are saved alongside the value.</p>
                          </div>
                          <div className="flex gap-2">
                            <Button type="button" variant="outline" onClick={() => void saveValue(group, value)} disabled={!group.id || busyKey === `value:${value.localId}`}>
                              {busyKey === `value:${value.localId}` ? 'Saving...' : value.id ? 'Save Value' : 'Create Value'}
                            </Button>
                            <Button type="button" variant="destructive" onClick={() => void deleteValue(group.localId, value)} disabled={busyKey === `delete-value:${value.localId}`}>
                              Delete
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-zinc-300">Value Label</label>
                            <input
                              type="text"
                              value={value.value}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { value: event.target.value })}
                              placeholder="e.g. Small"
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-zinc-300">Value SKU</label>
                            <input
                              type="text"
                              value={value.sku}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { sku: event.target.value })}
                              placeholder="Optional"
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-zinc-300">Variant Image</label>
                            <MediaFieldInput
                              adminBasePath={basePath}
                              value={value.image}
                              onChange={(nextValue) => updateValueDraft(group.localId, value.localId, { image: nextValue })}
                              placeholder="Optional hero image override"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-zinc-300">Price Override (Cents)</label>
                            <input
                              type="number"
                              value={value.priceOverride}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { priceOverride: event.target.value })}
                              placeholder="Optional"
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-zinc-300">Stock Quantity</label>
                            <input
                              type="number"
                              value={value.stockQuantity}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { stockQuantity: event.target.value })}
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldRenderer({ field, form, basePath, relationOptions, relationSupportEntries, collapseStorageKey }: { field: any, form: any, basePath: string, relationOptions: any, relationSupportEntries: CommerceSupportEntries, collapseStorageKey?: string }) {
    const fieldName = basePath ? `${basePath}.${field.name}` : field.name;
    const [dragState, setDragState] = useState<{ listId: string; index: number } | null>(null);
    const [blockLibraryOpen, setBlockLibraryOpen] = useState(false);
    const [pendingBlockInsertIndex, setPendingBlockInsertIndex] = useState<number | null>(null);
    const [slotPickerState, setSlotPickerState] = useState<Record<string, { open: boolean; insertIndex: number | null }>>({});
    const fieldCollapseStorageKey = getCollapsedCardsStorageKey(collapseStorageKey, fieldName);
    const [collapsedCards, setCollapsedCards] = useState<Record<string, boolean>>(() => readCollapsedCardsState(fieldCollapseStorageKey));

    const getCardKey = (listId: string, index: number) => `${listId}:${index}`;
    const isCardCollapsed = (listId: string, index: number) => collapsedCards[getCardKey(listId, index)] === true;
    const toggleCardCollapsed = (listId: string, index: number) => {
        const cardKey = getCardKey(listId, index);
        setCollapsedCards((current) => ({
            ...current,
            [cardKey]: !current[cardKey],
        }));
    };
    const setListCollapsed = (listId: string, count: number, collapsed: boolean) => {
        setCollapsedCards((current) => {
            const nextState = { ...current };
            for (let index = 0; index < count; index += 1) {
                nextState[getCardKey(listId, index)] = collapsed;
            }
            return nextState;
        });
    };
    const getSlotPickerConfig = (slotFieldName: string) => slotPickerState[slotFieldName] || { open: false, insertIndex: null };
    const openSlotPicker = (slotFieldName: string, insertIndex: number | null) => {
        setSlotPickerState((current) => ({
            ...current,
            [slotFieldName]: { open: true, insertIndex },
        }));
    };
    const closeSlotPicker = (slotFieldName: string) => {
        setSlotPickerState((current) => ({
            ...current,
            [slotFieldName]: { open: false, insertIndex: null },
        }));
    };

    useEffect(() => {
        setCollapsedCards(readCollapsedCardsState(fieldCollapseStorageKey));
    }, [fieldCollapseStorageKey]);

    useEffect(() => {
        writeCollapsedCardsState(fieldCollapseStorageKey, collapsedCards);
    }, [fieldCollapseStorageKey, collapsedCards]);

    if (field.type === 'array') {
        return (
            <form.Field
                name={fieldName}
                mode="array"
                children={(fieldApi: any) => {
                    const value = fieldApi.state.value || [];
                    return (
                        <div className="border border-white/10 rounded-lg p-5 space-y-4 bg-zinc-950/40 shadow-inner">
                            <div className="flex items-center justify-between pb-3 border-b border-white/5">
                                <label className="text-sm font-medium text-zinc-300">{field.label}</label>
                                <Button size="sm" variant="outline" type="button" onClick={() => fieldApi.pushValue(buildDefaultValues(field.fields))}>Add Row</Button>
                            </div>
                            {value.map((_: any, i: number) => (
                                <div key={i} className="p-5 border border-white/5 bg-white/[0.02] rounded-lg relative group transition-colors hover:bg-white/[0.04]">
                                    <Button 
                                        size="sm" 
                                        variant="destructive" 
                                        type="button"
                                        className="absolute -right-2 -top-2 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 p-0 rounded-full"
                                        onClick={() => fieldApi.removeValue(i)}
                                    >
                                        &times;
                                    </Button>
                                    <div className="space-y-4">
                                        {field.fields?.map((subField: any) => (
                                            <FieldRenderer key={subField.name} field={subField} form={form} basePath={`${fieldName}[${i}]`} relationOptions={relationOptions} relationSupportEntries={relationSupportEntries} collapseStorageKey={collapseStorageKey} />
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )
                }}
            />
        );
    }
    
    if (field.type === 'blocks') {
        return (
            <PageBuilderComposer
                field={field}
                fieldName={fieldName}
                form={form}
                relationSupportEntries={relationSupportEntries}
                collapseStorageKey={collapseStorageKey}
                renderField={(nestedField, nestedBasePath) => (
                    <FieldRenderer
                        key={`${nestedBasePath}:${nestedField.name}`}
                        field={nestedField}
                        form={form}
                        basePath={nestedBasePath}
                        relationOptions={relationOptions}
                        relationSupportEntries={relationSupportEntries}
                        collapseStorageKey={collapseStorageKey}
                    />
                )}
            />
        );
    }

    if (field.type === 'group') {
        return (
            <div className="border border-white/10 rounded-lg p-5 space-y-4 bg-zinc-950/40 shadow-inner">
                <div className="pb-3 border-b border-white/5">
                    <label className="text-sm font-medium text-zinc-300">{field.label}</label>
                </div>
                <div className="space-y-4">
                    {field.fields?.map((subField: any) => (
                        <FieldRenderer key={subField.name} field={subField} form={form} basePath={fieldName} relationOptions={relationOptions} relationSupportEntries={relationSupportEntries} collapseStorageKey={collapseStorageKey} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <form.Field
            name={fieldName}
            children={(fieldApi: any) => {
                const hasError = fieldApi.state.meta.errors.length > 0;
                return (
                  <div className="space-y-2">
                      {field.type !== 'boolean' && (
                        <label className="text-sm font-medium block text-zinc-300">
                            {field.label} {field.required && <span className="text-red-400">*</span>}
                        </label>
                      )}
                      
                      {field.type === 'media' ? (
                          <MediaFieldInput
                              adminBasePath={basePath}
                              value={(fieldApi.state.value as string) || ''}
                              onChange={fieldApi.handleChange}
                              onBlur={fieldApi.handleBlur}
                          />
                      ) : field.type === 'textarea' ? (
                          <textarea
                              value={(fieldApi.state.value as string) || ''}
                              onChange={(e) => fieldApi.handleChange(e.target.value)}
                              onBlur={fieldApi.handleBlur}
                              className={`w-full bg-zinc-950/50 border rounded-md p-3 text-sm focus:outline-none focus:ring-2 transition-all shadow-inner ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50 focus:border-indigo-500/50'}`}
                          />
                      ) : field.type === 'select' ? (
                          <select
                              value={(fieldApi.state.value as string) || ''}
                              onChange={(e) => fieldApi.handleChange(e.target.value)}
                              onBlur={fieldApi.handleBlur}
                              className={`w-full bg-zinc-950/50 border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all shadow-inner ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50 focus:border-indigo-500/50'}`}
                          >
                              <option value="">Select an option...</option>
                              {(field.options || []).map((option: string) => (
                                  <option key={option} value={option}>
                                      {option}
                                  </option>
                              ))}
                          </select>
                      ) : isRelationshipFieldType(field.type) ? (
                          <RelationshipPicker
                              field={field}
                              value={fieldApi.state.value}
                              onChange={fieldApi.handleChange}
                              onBlur={fieldApi.handleBlur}
                              relationOptions={relationOptions}
                              relationSupportEntries={relationSupportEntries}
                          />
                      ) : field.type === 'richtext' ? (
                          <RichTextEditor
                              value={fieldApi.state.value} // ensure value format works with block editor
                              onChange={(val: any) => fieldApi.handleChange(val)}
                              hasError={hasError}
                          />
                      ) : field.type === 'boolean' ? (
                          <div className="flex items-center gap-2">
                              <input 
                                  type="checkbox" 
                                  id={`field-${fieldName}`} // Make unique for arrays
                                  checked={!!fieldApi.state.value}
                                  onChange={(e) => fieldApi.handleChange(e.target.checked)}
                                  onBlur={fieldApi.handleBlur}
                                  className="w-4 h-4 rounded border-zinc-700 text-indigo-500 focus:ring-indigo-500 bg-zinc-950"
                              />
                              <label htmlFor={`field-${fieldName}`} className="text-sm font-medium">
                                  {field.label} {field.required && <span className="text-red-500">*</span>}
                              </label>
                          </div>
                      ) : (
                          <input 
                              type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} 
                              value={fieldApi.state.value !== undefined ? (fieldApi.state.value as any) : ''}
                              onChange={(e) => fieldApi.handleChange(field.type === 'number' ? (e.target.value ? Number(e.target.value) : undefined) : e.target.value)}
                              onBlur={fieldApi.handleBlur}
                              className={`w-full bg-zinc-950/50 border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all shadow-inner ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50 focus:border-indigo-500/50'}`}
                          />
                      )}

                      {isRelationshipFieldType(field.type) && (
                          <RelationFieldSummary
                              field={field}
                              value={fieldApi.state.value as any}
                              relationSupportEntries={relationSupportEntries}
                          />
                      )}

                      {hasError && (
                          <p className="text-xs text-red-500">{fieldApi.state.meta.errors.join(', ')}</p>
                      )}
                  </div>
                );
            }}
        />
    )
}

function PresetEditorPanel({
  form,
  selectedLibraryId,
  setSelectedLibraryId,
  selectedComponentSlug,
  setSelectedComponentSlug,
  relationOptions,
  relationSupportEntries,
  collapseStorageKey,
}: {
  form: any;
  selectedLibraryId: string;
  setSelectedLibraryId: (value: string) => void;
  selectedComponentSlug: string;
  setSelectedComponentSlug: (value: string) => void;
  relationOptions: Record<string, RelationOptionRecord[]>;
  relationSupportEntries: CommerceSupportEntries;
  collapseStorageKey?: string;
}) {
  const libraries = getLibraryDefinitions();
  const selectedLibrary = libraries.find((library: any) => library.id === selectedLibraryId) || null;
  const selectedComponent = getLibraryComponentDefinition(selectedLibraryId, selectedComponentSlug);

  return (
    <div className="space-y-8 mt-2">
      <form.Field
        name="name"
        children={(fieldApi: any) => (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-300">Preset Name <span className="text-red-400">*</span></label>
            <input
              type="text"
              value={fieldApi.state.value || ''}
              onChange={(event) => fieldApi.handleChange(event.target.value)}
              onBlur={fieldApi.handleBlur}
              className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            />
          </div>
        )}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <form.Field
          name="libraryId"
          children={(fieldApi: any) => (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-300">Library <span className="text-red-400">*</span></label>
              <select
                value={fieldApi.state.value || ''}
                onChange={(event) => {
                  const nextLibraryId = event.target.value;
                  setSelectedLibraryId(nextLibraryId);
                  setSelectedComponentSlug('');
                  fieldApi.handleChange(nextLibraryId);
                  form.setFieldValue('componentSlug', '');
                  form.setFieldValue('presetProps', {});
                  form.setFieldValue('propsJson', '{}');
                }}
                onBlur={fieldApi.handleBlur}
                className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              >
                <option value="">Select a library...</option>
                {libraries.map((library: any) => (
                  <option key={library.id} value={library.id}>{library.name}</option>
                ))}
              </select>
            </div>
          )}
        />

        <form.Field
          name="componentSlug"
          children={(fieldApi: any) => (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-300">Component <span className="text-red-400">*</span></label>
              <select
                value={fieldApi.state.value || ''}
                onChange={(event) => {
                  const nextComponentSlug = event.target.value;
                  setSelectedComponentSlug(nextComponentSlug);
                  fieldApi.handleChange(nextComponentSlug);
                  const nextComponent = getLibraryComponentDefinition(selectedLibraryId, nextComponentSlug);
                  form.setFieldValue('presetProps', nextComponent ? buildDefaultValues(nextComponent.fields) : {});
                  form.setFieldValue('propsJson', '{}');
                }}
                onBlur={fieldApi.handleBlur}
                disabled={!selectedLibrary}
                className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-50"
              >
                <option value="">Select a component...</option>
                {(selectedLibrary?.components || []).map((componentAdapter: any) => (
                  <option key={componentAdapter.component.slug} value={componentAdapter.component.slug}>
                    {componentAdapter.component.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <form.Field
          name="variant"
          children={(fieldApi: any) => (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-300">Variant</label>
              <input
                type="text"
                value={fieldApi.state.value || ''}
                onChange={(event) => fieldApi.handleChange(event.target.value)}
                onBlur={fieldApi.handleBlur}
                placeholder="e.g. primary, growth, compact"
                className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              />
            </div>
          )}
        />

        <div className="rounded-lg border border-white/10 bg-zinc-950/40 p-4">
          <div className="text-sm font-medium text-zinc-200">Preset Scope</div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Presets can be reused in any component slot that accepts the selected component type.
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-white/10 bg-zinc-950/40 p-5 shadow-inner">
        <div className="border-b border-white/5 pb-3">
          <label className="text-sm font-medium text-zinc-300">Component Props</label>
          <p className="mt-1 text-xs text-zinc-500">These fields are stored into the preset payload and injected when the preset is used in a block slot.</p>
        </div>
        {selectedComponent ? (
          <div className="space-y-4">
            {selectedComponent.fields.map((componentField: any) => (
              <FieldRenderer
                key={`preset-${selectedComponent.slug}-${componentField.name}`}
                field={componentField}
                form={form}
                basePath="presetProps"
                relationOptions={relationOptions}
                relationSupportEntries={relationSupportEntries}
                collapseStorageKey={collapseStorageKey}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-sm text-zinc-500">
            Select a library and component to author a reusable preset.
          </div>
        )}
      </div>
    </div>
  );
}

export function CollectionEntryEditor({
  collection,
  entry: rawEntry,
  revisions: initialRevisions,
  isNew,
  relationOptions,
  relationSupportEntries,
  slug,
  entryId,
  basePath,
  section
}: {
  collection: any;
  entry: any;
  revisions: any[];
  isNew: boolean;
  relationOptions: Record<string, RelationOptionRecord[]>;
  relationSupportEntries: CommerceSupportEntries;
  slug: string;
  entryId: string;
  basePath: string;
  section: AdminSection;
}) {
  const initialEntry = rawEntry as any;
  const navigate = useNavigate();
  const router = useRouter();
  const nativeCollection = isNativeCollection(collection);
  const presetCollection = isComponentPresetCollection(collection);
  const versioningEnabled = !nativeCollection;
  const supportsRawView = !nativeCollection && !presetCollection;
  const sectionCollectionRoute = getSectionCollectionRoute(section);
  const sectionEntryRoute = getSectionEntryRoute(section);
  const editorFields = getEditorFields(collection, isNew);
  const nativeIdColumn = getNativeIdColumn(collection);

  const [currentEntry, setCurrentEntry] = useState<any>(initialEntry);
  const [revisions, setRevisions] = useState<any[]>(initialRevisions || []);
  const [entrySlug, setEntrySlug] = useState(initialEntry?.slug || '');
  const [viewMode, setViewMode] = useState<'form' | 'raw'>('form');
  const [isWorking, setIsWorking] = useState(false);

  const defaultValues = (() => {
    if (presetCollection) {
      return buildPresetEditorDefaults(initialEntry, editorFields);
    }

    if (initialEntry?.data) {
      return parseEntryData(initialEntry, editorFields);
    }

    return buildDefaultValues(editorFields);
  })();

  const [selectedPresetLibraryId, setSelectedPresetLibraryId] = useState(defaultValues.libraryId || '');
  const [selectedPresetComponentSlug, setSelectedPresetComponentSlug] = useState(defaultValues.componentSlug || '');
  const selectedPresetComponent = presetCollection
    ? getLibraryComponentDefinition(selectedPresetLibraryId, selectedPresetComponentSlug)
    : null;

  const [rawJsonStr, setRawJsonStr] = useState(() => JSON.stringify(defaultValues, null, 2));

  const [globalError, setGlobalError] = useState('');
  const collapseStorageKey = `talisman-cms:collapsed:collection:${slug}:${currentEntry?.id || entryId}`;

  const form = useForm({
    defaultValues,
    validators: presetCollection
      ? {
          onChange: getPresetClientSchema(editorFields, selectedPresetComponent?.fields) as any
        }
      : {
          onChange: getZodClientSchemaForFields(editorFields) as any
        }
  });

  if (!collection) return <div>Collection not found.</div>;

  const currentStatus = getEntryStatus(currentEntry, collection);
  const showProductConfigurator = isCommerceProductCollection(collection);

  const parseEditorValues = () => {
    if (supportsRawView && viewMode === 'raw') {
      const parsed = JSON.parse(rawJsonStr);
      const normalized = normalizeStoredFieldData(editorFields, parsed);
      form.reset(normalized);
      return normalized;
    }

    if (presetCollection) {
      const values = { ...form.state.values } as Record<string, any>;
      values.propsJson = JSON.stringify(values.presetProps || {}, null, 2);
      delete values.presetProps;
      return values;
    }

    return form.state.values;
  };

  const syncEntryState = (entry: any, nextRevisions?: any[]) => {
    const parsedData = parseEntryData(entry, editorFields);
    setCurrentEntry(entry);
    setEntrySlug(entry?.slug || '');
    setRawJsonStr(JSON.stringify(parsedData, null, 2));
    const nextDefaults = presetCollection ? buildPresetEditorDefaults(entry, editorFields) : parsedData;
    form.reset(nextDefaults);
    if (presetCollection) {
      setSelectedPresetLibraryId(nextDefaults.libraryId || '');
      setSelectedPresetComponentSlug(nextDefaults.componentSlug || '');
    }
    if (nextRevisions) setRevisions(nextRevisions);
  };

  const refreshEntryState = async (targetEntryId: string) => {
    const [entryRes, revisionsRes] = await Promise.all([
      fetch(`${basePath}/api/collections/${slug}/entries/${targetEntryId}`),
      versioningEnabled
        ? fetch(`${basePath}/api/collections/${slug}/entries/${targetEntryId}/revisions`)
        : Promise.resolve(null as any)
    ]);

    if (!entryRes.ok) {
      throw new Error('Failed to refresh entry');
    }

    const nextEntry = await entryRes.json();
    const nextRevisions = revisionsRes && revisionsRes.ok ? await revisionsRes.json() : revisions;
    syncEntryState(nextEntry, nextRevisions);
    await router.invalidate();
    return nextEntry;
  };

  const broadcastChange = (targetEntryId: string) => {
    try {
      const channel = new BroadcastChannel('talisman-cms-preview');
      channel.postMessage({
        type: 'GALAXY_ENTRY_SAVED',
        collectionSlug: slug,
        entryId: targetEntryId,
      });
    } catch (err) {
      console.error('[Talisman CMS] Failed to broadcast save event', err);
    }
  };

  const persistDraft = async (navigateAfterCreate = true) => {
    const value = parseEditorValues();
    if (presetCollection) {
      const presetValidation = validatePresetPayload(getLibraryDefinitions() as any, value);
      if (!presetValidation.success) {
        throw new Error(presetValidation.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      }
    }
    const method = isNew ? 'POST' : 'PUT';
    const url = isNew
      ? `${basePath}/api/collections/${slug}/entries`
      : `${basePath}/api/collections/${slug}/entries/${entryId}`;
    const body = nativeCollection
      ? { data: value }
      : { slug: entrySlug, data: value, ...(!isNew ? { expectedRevisionId: currentEntry?.latestRevisionId } : {}) };

    const res = await fetch(url, {
      method,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errData: any = await res.json();
      throw new Error(errData.error || errData.message || 'Failed to save draft');
    }

    const savedEntry: any = await res.json();
    broadcastChange(savedEntry.id);

    if (isNew && navigateAfterCreate) {
      navigate({ to: sectionEntryRoute, params: { slug, entryId: savedEntry.id } });
      return savedEntry;
    }

    return refreshEntryState(savedEntry.id);
  };

  const runEntryAction = async (action: 'save' | 'publish' | 'archive') => {
    setGlobalError('');
    setIsWorking(true);

    try {
      if (action === 'save') {
        await persistDraft();
        return;
      }

      const targetEntry = await persistDraft(false);

      const res = await fetch(`${basePath}/api/collections/${slug}/entries/${targetEntry.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevisionId: targetEntry.latestRevisionId })
      });

      if (!res.ok) {
        const errData: any = await res.json();
        throw new Error(errData.error || errData.message || `Failed to ${action}`);
      }

      broadcastChange(targetEntry.id);
      const nextEntry: any = await res.json();

      if (isNew) {
        navigate({ to: sectionEntryRoute, params: { slug, entryId: nextEntry.id } });
        return;
      }

      await refreshEntryState(nextEntry.id);
    } catch (e: any) {
      setGlobalError(e.message);
    } finally {
      setIsWorking(false);
    }
  };

  const handleRestoreRevision = async (revisionId: string) => {
    if (!currentEntry?.id) return;

    setGlobalError('');
    setIsWorking(true);

    try {
      const res = await fetch(`${basePath}/api/collections/${slug}/entries/${currentEntry.id}/revisions/${revisionId}/restore`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevisionId: currentEntry.latestRevisionId })
      });

      if (!res.ok) {
        const errData: any = await res.json();
        throw new Error(errData.error || errData.message || 'Failed to restore revision');
      }

      const restored: any = await res.json();
      broadcastChange(restored.id);
      await refreshEntryState(restored.id);
    } catch (e: any) {
      setGlobalError(e.message);
    } finally {
      setIsWorking(false);
    }
  };

  const toggleViewMode = () => {
    if (viewMode === 'form') {
       // Sync form values to raw view
       setRawJsonStr(JSON.stringify(form.state.values, null, 2));
       setViewMode('raw');
    } else {
       // Try syncing raw view back to form
       try {
         const parsed = JSON.parse(rawJsonStr);
         // Overwrite entire form state
         form.reset(parsed);
         setViewMode('form');
         setGlobalError('');
       } catch (e) {
         setGlobalError('Fix JSON format before switching to form view');
       }
    }
  };

  const handleManualSaveClick = () => {
    void runEntryAction('save');
  };

  const refreshCommerceData = async () => {
    if (currentEntry?.id) {
      await refreshEntryState(currentEntry.id);
      return;
    }

    await router.invalidate();
  };

  const entryData = parseEntryData(currentEntry, editorFields);
  const displayLabel = showProductConfigurator && typeof entryData.name === 'string' && entryData.name
    ? entryData.name
    : initialEntry?.slug || initialEntry?.id?.substring(0, 8) || slug;
  const recordLabel = nativeCollection ? 'record' : 'entry';

  return (
    <div className="space-y-6 w-full pb-24">
      <div className="flex items-center justify-between pointer-events-none mb-2">
        <Link to={sectionCollectionRoute} params={{ slug }} className="hover:text-white transition-colors flex items-center gap-1 text-sm bg-white/5 px-2.5 py-1 rounded-md backdrop-blur-sm border border-white/5 hover:bg-white/10 hover:border-white/10 text-zinc-400 pointer-events-auto">
          <ArrowLeft size={14} /> Back to {collection.name}
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-white shadow-sm">
          {isNew ? `New ${nativeCollection ? 'Record' : 'Entry'}` : <span className="text-zinc-400 font-medium text-2xl mr-2">Edit:</span>}
          {!isNew && <span className="bg-gradient-to-r from-indigo-400 to-indigo-300 bg-clip-text text-transparent">{displayLabel}</span>}
        </h1>
        <p className="text-zinc-400 mt-2 text-sm max-w-xl">
          {showProductConfigurator
            ? 'Edit the details shoppers see, then manage options and stock below.'
            : collection.description || `Edit this ${nativeCollection ? 'record' : 'content entry'} in ${collection.name}.`}
        </p>
        {collection.readOnly && <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">This record is managed by the payment workflow and is read-only in the CMS.</p>}
        {showProductConfigurator && <nav aria-label="Product editor sections" className="mt-5 flex flex-wrap gap-2 text-xs font-medium">
          <a href="#product-details" className="rounded-full border border-indigo-400/30 bg-indigo-400/10 px-3 py-2 text-indigo-200 hover:bg-indigo-400/20">Product details</a>
          <a href="#product-options" className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-zinc-300 hover:bg-white/10">Options &amp; stock</a>
        </nav>}
      </div>

      <div className="space-y-8 w-full">
        <div id={showProductConfigurator ? 'product-details' : undefined} className={`space-y-6 scroll-mt-24 ${collection.readOnly ? 'pointer-events-none opacity-80' : ''}`}>
          <Card>
             <CardContent className="pt-6">
                <div className="space-y-8">
                  {!showProductConfigurator && <CommerceModelGuide
                    collectionSlug={collection.slug}
                    values={form.state.values as Record<string, any>}
                    relationSupportEntries={relationSupportEntries}
                  />}

                  {!nativeCollection && (
                    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-5">
                      <label className="text-sm font-medium mb-2 block text-zinc-300">Slug (Optional)</label>
                      <input 
                         type="text" 
                         value={entrySlug}
                         onChange={(e) => setEntrySlug(e.target.value)}
                         placeholder="e.g. my-awesome-post"
                         className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all placeholder:text-zinc-600 shadow-inner"
                      />
                      <p className="text-xs text-zinc-500 mt-2 flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-indigo-500/50" />Leave blank to auto-generate from ID.</p>
                    </div>
                  )}

                  {nativeCollection && (
                    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-5">
                      <div className="text-sm font-medium text-zinc-300">{showProductConfigurator ? 'Product details' : 'Record fields'}</div>
                      <p className="text-sm text-zinc-400 mt-2">
                        {showProductConfigurator ? 'Set the shopper-facing name, story, images, price, and availability here. Save these details before editing options and stock.' : 'Changes to this record are saved directly.'}
                      </p>
                      {isNew && editorFields.some((field: any) => field.name === nativeIdColumn) && (
                        <p className="text-xs text-zinc-500 mt-3">Leave the <code>{nativeIdColumn}</code> field blank to auto-generate one.</p>
                      )}
                    </div>
                  )}

                  <div className="pt-2">
                     <div className="flex items-center justify-between mb-6 pb-4 border-b border-white/5">
                         <label className="text-base font-medium block text-white flex items-center gap-2">
                           <span className="p-1 rounded bg-indigo-500/10 text-indigo-400">
                             <Database size={14} />
                           </span>
                           {showProductConfigurator ? 'Product fields' : nativeCollection ? 'Record fields' : 'Content fields'}
                         </label>
                         {supportsRawView && (
                           <button 
                               type="button"
                               onClick={toggleViewMode}
                               className="text-xs text-zinc-400 font-mono hover:text-white bg-white/5 border border-white/5 px-2.5 py-1.5 rounded-md hover:bg-white/10 transition-colors"
                           >
                               {viewMode === 'form' ? 'Switch to Raw JSON' : 'Switch to Form'}
                           </button>
                         )}
                     </div>
                     
                     {supportsRawView && viewMode === 'raw' ? (
                         <textarea 
                             value={rawJsonStr}
                             onChange={(e) => setRawJsonStr(e.target.value)}
                             spellCheck={false}
                             className="w-full bg-black/50 border border-white/10 rounded-lg p-5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 min-h-[500px] shadow-inner text-indigo-100 leading-relaxed"
                         />
                    ) : (
                        <div className="space-y-8 mt-2">
                            {editorFields.length === 0 ? (
                                <p className="text-sm text-zinc-500 italic">No editable fields defined for this {recordLabel}.</p>
                            ) : presetCollection ? (
                                <PresetEditorPanel
                                  form={form}
                                  selectedLibraryId={selectedPresetLibraryId}
                                  setSelectedLibraryId={setSelectedPresetLibraryId}
                                  selectedComponentSlug={selectedPresetComponentSlug}
                                  setSelectedComponentSlug={setSelectedPresetComponentSlug}
                                  relationOptions={relationOptions}
                                  relationSupportEntries={relationSupportEntries}
                                  collapseStorageKey={collapseStorageKey}
                                />
                            ) : (
                                editorFields.map((field: any) => (
                                    <FieldRenderer 
                                        key={field.name} 
                                        field={field} 
                                        form={form} 
                                        basePath=""
                                        relationOptions={relationOptions}
                                        relationSupportEntries={relationSupportEntries}
                                        collapseStorageKey={collapseStorageKey}
                                    />
                                ))
                            )}
                        </div>
                    )}
                 </div>
               </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-8">
           <Card>
              <CardContent className="pt-6 space-y-6">
                 <div>
                   <label className="text-sm font-medium mb-2 block text-zinc-300">{nativeCollection ? 'State' : 'Status'}</label>
                   <div className={`inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium ${getStatusBadgeClass(currentStatus)}`}>
                     {currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1)}
                   </div>
                   {!versioningEnabled && !showProductConfigurator && (
                     <p className="text-xs text-zinc-500 mt-2">Native collections bypass the draft/publish workflow and revision history.</p>
                   )}
                 </div>

                 <div className="pt-2">
                    {!collection.readOnly && <Button onClick={handleManualSaveClick} disabled={isWorking} className="w-full gap-2 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] transition-all duration-300 border-0 h-11 text-base">
                      <Save size={18} /> {isWorking ? 'Working...' : versioningEnabled ? 'Save Draft' : 'Save Changes'}
                    </Button>}
                    {versioningEnabled && (
                      <div className="grid grid-cols-2 gap-3 mt-3">
                        <Button type="button" variant="outline" disabled={isWorking} onClick={() => void runEntryAction('publish')} className="gap-2">
                          <Send size={16} /> Publish
                        </Button>
                        <Button type="button" variant="outline" disabled={isWorking || isNew} onClick={() => void runEntryAction('archive')} className="gap-2">
                          <Archive size={16} /> Archive
                        </Button>
                      </div>
                    )}
                    {globalError && <p className="text-red-400 text-sm mt-3 text-center">{globalError}</p>}
                 </div>

                 {!isNew && currentEntry && (
                   <div className="pt-6 border-t border-white/5 space-y-4">
                     <div className="bg-white/[0.02] rounded-md p-3 border border-white/5">
                       <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">{nativeCollection ? 'Record ID' : 'Entry ID'}</div>
                       <div className="text-sm font-mono text-zinc-300 truncate" title={currentEntry.id}>{currentEntry.id}</div>
                     </div>
                     {nativeCollection && entryData[nativeIdColumn] && entryData[nativeIdColumn] !== currentEntry.id && (
                       <div className="bg-white/[0.02] rounded-md p-3 border border-white/5">
                         <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Primary Key</div>
                         <div className="text-sm font-mono text-zinc-300 truncate" title={entryData[nativeIdColumn]}>{entryData[nativeIdColumn]}</div>
                       </div>
                     )}
                     <div className="grid grid-cols-2 gap-4">
                       <div>
                         <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Created</div>
                         <div className="text-xs text-zinc-400">{new Date(currentEntry.createdAt).toLocaleDateString()}</div>
                       </div>
                       <div>
                         <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Updated</div>
                         <div className="text-xs text-zinc-400">{new Date(currentEntry.updatedAt).toLocaleDateString()}</div>
                       </div>
                     </div>
                     {currentEntry.publishedAt && (
                       <div className="bg-white/[0.02] rounded-md p-3 border border-white/5">
                         <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Published</div>
                         <div className="text-xs text-zinc-400">{new Date(currentEntry.publishedAt).toLocaleString()}</div>
                       </div>
                     )}
                   </div>
                 )}

                 {versioningEnabled && !isNew && (
                   <div className="pt-6 border-t border-white/5 space-y-4">
                     <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                       <History size={14} />
                       Revision History
                     </div>
                     {revisions.length === 0 ? (
                       <p className="text-xs text-zinc-500">No revisions saved yet.</p>
                     ) : (
                       <div className="space-y-3">
                         {revisions.map((revision: any) => (
                           <div key={revision.id} className="rounded-md border border-white/5 bg-white/[0.02] p-3 space-y-2">
                             <div className="flex items-center justify-between gap-3">
                               <div>
                                 <div className="text-sm text-zinc-200">Revision #{revision.revisionNumber}</div>
                                 <div className="text-[11px] uppercase tracking-widest text-zinc-500">{revision.type.replace('_', ' ')}</div>
                               </div>
                               <Button type="button" variant="ghost" size="sm" disabled={isWorking} onClick={() => void handleRestoreRevision(revision.id)}>
                                 Restore
                               </Button>
                             </div>
                             <div className="flex items-center gap-2 text-xs text-zinc-500">
                               <Clock3 size={12} />
                               {new Date(revision.createdAt).toLocaleString()}
                             </div>
                           </div>
                         ))}
                       </div>
                     )}
                   </div>
                 )}
              </CardContent>
           </Card>
        </div>
        {showProductConfigurator && <div id="product-options" className={`scroll-mt-24 ${collection.readOnly ? 'pointer-events-none opacity-80' : ''}`}>
          <ProductVariantConfigurator
            productId={currentEntry?.id || null}
            relationSupportEntries={relationSupportEntries}
            basePath={basePath}
            onRefresh={refreshCommerceData}
            productValues={form.state.values as Record<string, any>}
          />
        </div>}
      </div>
    </div>
  );
}

function CollectionsEntryEditorRoute() {
  const { collection, entry, revisions, isNew, relationOptions, relationSupportEntries } = Route.useLoaderData();
  const { slug, entryId } = Route.useParams();
  const routerContext = Route.useRouteContext();

  return (
    <CollectionEntryEditor
      collection={collection}
      entry={entry}
      revisions={revisions}
      isNew={isNew}
      relationOptions={relationOptions}
      relationSupportEntries={relationSupportEntries}
      slug={slug}
      entryId={entryId}
      basePath={routerContext.adminBasePath || '/admin'}
      section="collections"
    />
  );
}
