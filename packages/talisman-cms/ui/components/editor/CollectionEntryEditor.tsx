import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useRouter } from '@tanstack/react-router';
import { useForm, useStore } from '@tanstack/react-form';
import { uiLibraries as configuredUiLibraries } from 'virtual:talisman-cms/ui-libraries';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { ArrowLeft, Archive, Clock3, Database, History, Save, Send } from 'lucide-react';
import { AdminBasePathContext, FieldRenderer, ServerFieldErrorsContext, type RelationOptionRecord, type ServerFieldErrors } from '../fields';
import { MediaFieldInput } from '../MediaFieldInput';
import { getSectionCollectionRoute, getSectionEntryRoute, type AdminSection } from '../../lib/admin-sections';
import { fetchCollectionConfigs, fetchEntriesBySlug } from '../../lib/admin-api';
import {
  describeRequestError,
  EditorRequestError,
  isNativeCollection,
  isSlugConflictError,
  isStaleEditError,
  requestEditorApi,
  REVISION_LIST_LIMIT,
} from '../../lib/entry-editor-data';
import {
  describeSettledTransition,
  describeVariantChangeFailure,
  getPagePath,
  getPendingSlugRename,
  getVariantChangeRecovery,
  hasEntryMovedOn,
  prepareFieldValuesForSave,
  readPendingTransition,
  waitForPendingTransition,
  type PendingTransition,
} from '../../lib/entry-save';
import {
  describeCommerceEntry,
  formatMoney,
  getCommerceFlowSummary,
  getCommerceModelGuide,
  getEntryData,
  getInventoryFieldNames,
  type CommerceSupportEntries,
} from '../../lib/commerce-models';
import { readCommerceCurrency } from '../../commerce-currency';
import {
  buildDefaultValues,
  getPresetClientSchema,
  getZodClientSchemaForFields,
  normalizeStoredFieldData,
} from '../../lib/page-builder';
import { validatePresetPayload } from '../../../src/presets';

/** The tables the product's variant editor reads and writes; it reloads these after each change. */
const PRODUCT_CONFIGURATOR_SLUGS = [
  '_ecommerce_variants',
  '_ecommerce_product_variants',
  '_ecommerce_product_variant_values',
  '_ecommerce_stocks',
];

/** Human-readable label for a form field path such as `layout[0].title`. */
function describeFieldPath(fieldPath: string, fields: any[], values: any) {
  if (!fieldPath) return 'Entry';
  const labels: string[] = [];
  let scopeFields: any[] = fields || [];
  let field: any = null;
  let value: any = values;

  for (const segment of fieldPath.split(/[.[\]]+/).filter(Boolean)) {
    if (/^\d+$/.test(segment)) {
      value = Array.isArray(value) ? value[Number(segment)] : undefined;
      const item = field?.blocks?.find((block: any) => block.slug === value?.blockType)
        || field?.components?.find((component: any) => component.slug === value?.componentType);
      labels.push(`${item?.name || 'Item'} ${Number(segment) + 1}`);
      scopeFields = item ? [...(item.fields || []), ...(item.componentSlots || [])] : field?.fields || [];
      continue;
    }

    field = scopeFields.find((candidate: any) => candidate.name === segment) || null;
    labels.push(field?.label || segment);
    value = value?.[segment];
    const component = value && !Array.isArray(value)
      ? field?.components?.find((candidate: any) => candidate.slug === value.componentType)
      : null;
    scopeFields = component?.fields || field?.fields || [];
  }

  return labels.join(' › ');
}

/** The native row's updatedAt as loaded, sent back so the server can refuse stale writes. */
function getLoadedUpdatedAt(entry: any) {
  const updatedAt = getEntryData(entry)?.updatedAt;
  return typeof updatedAt === 'string' || typeof updatedAt === 'number' ? updatedAt : null;
}

// A message that must survive the remount when a newly created entry opens at its own URL.
function getEditorNoticeKey(slug: string, entryId: string) {
  return `talisman-cms:editor-notice:${slug}:${entryId}`;
}

function stashEditorNotice(slug: string, entryId: string, message: string) {
  try {
    window.sessionStorage.setItem(getEditorNoticeKey(slug, entryId), message);
  } catch {
    // Storage can be unavailable; the entry still opens.
  }
}

function takeEditorNotice(slug: string, entryId: string) {
  try {
    const key = getEditorNoticeKey(slug, entryId);
    const message = window.sessionStorage.getItem(key);
    if (message) window.sessionStorage.removeItem(key);
    return message || '';
  } catch {
    return '';
  }
}

// A publish or archive still running when a newly created entry opens at its own URL; the editor
// there keeps waiting for it.
function getPendingTransitionKey(slug: string, entryId: string) {
  return `talisman-cms:editor-pending:${slug}:${entryId}`;
}

function stashPendingTransition(slug: string, pending: PendingTransition) {
  try {
    window.sessionStorage.setItem(getPendingTransitionKey(slug, pending.entryId), JSON.stringify(pending));
  } catch {
    // Storage can be unavailable; the entry still opens, without the notice.
  }
}

function takePendingTransition(slug: string, entryId: string): PendingTransition | null {
  try {
    const key = getPendingTransitionKey(slug, entryId);
    const stored = window.sessionStorage.getItem(key);
    if (!stored) return null;
    window.sessionStorage.removeItem(key);
    const pending = JSON.parse(stored);
    return pending?.entryId === entryId && typeof pending.action === 'string' && typeof pending.message === 'string'
      ? { action: pending.action, entryId, fromRevisionId: typeof pending.fromRevisionId === 'string' ? pending.fromRevisionId : null, message: pending.message }
      : null;
  } catch {
    return null;
  }
}

function getNativeIdColumn(collection: any) {
  return collection?.nativeSchemaMapping?.idColumn || 'id';
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
  // As loaded: stock is only written when the quantity changed, and writes carry updatedAt.
  savedStockQuantity: string | null;
  updatedAt: string | number | null;
  stockUpdatedAt: string | number | null;
};

type ProductVariantGroupDraft = {
  localId: string;
  id: string | null;
  variantId: string;
  name: string;
  sku: string;
  priceOverride: string;
  inventoryQuantity: string;
  savedInventoryQuantity: string | null;
  updatedAt: string | number | null;
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
      savedStockQuantity: stockEntry ? asDraftString(stockData.quantity, '0') : null,
      updatedAt: getLoadedUpdatedAt(valueEntry),
      stockUpdatedAt: stockEntry ? getLoadedUpdatedAt(stockEntry) : null,
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
      const inventoryQuantity = data.inventoryQuantity === undefined || data.inventoryQuantity === null ? '0' : String(data.inventoryQuantity);

      return {
        localId: entry.id,
        id: entry.id,
        variantId: asDraftString(data.variantId),
        name: asDraftString(data.name),
        sku: asDraftString(data.sku),
        priceOverride: data.priceOverride === undefined || data.priceOverride === null ? '' : String(data.priceOverride),
        inventoryQuantity,
        savedInventoryQuantity: inventoryQuantity,
        updatedAt: getLoadedUpdatedAt(entry),
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

function formatPreviewPrice(amount: number | null | undefined, currency: string) {
  return formatMoney(typeof amount === 'number' && !Number.isNaN(amount) ? amount : 0, currency);
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
  const currency = readCommerceCurrency();
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
                <div className="mt-3 text-3xl font-black text-fuchsia-300">{formatPreviewPrice(priceCents, currency)}</div>
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
  const [hasStaleRows, setHasStaleRows] = useState(false);
  const idPrefix = useId();
  const controlId = (...parts: string[]) => [idPrefix, ...parts].join('-');

  useEffect(() => {
    if (!productId) {
      setDraftGroups([]);
      return;
    }

    setDraftGroups(buildProductVariantDrafts(productId, relationSupportEntries));
  }, [productId, relationSupportEntries]);

  const variantDefinitions = relationSupportEntries._ecommerce_variants || [];

  const requestCollection = async (collectionSlug: string, method: 'POST' | 'PUT', payload: Record<string, any>, id?: string) => {
    const url = id
      ? `${basePath}/api/collections/${collectionSlug}/entries/${id}`
      : `${basePath}/api/collections/${collectionSlug}/entries`;

    return requestEditorApi(url, { method, body: JSON.stringify(payload) }, `Failed to save ${collectionSlug}`);
  };

  const showRequestError = (error: unknown) => {
    // Only a stale row is fixed by loading the latest values; a clash such as a SKU another record
    // already uses is reported as the server words it.
    if (isStaleEditError(error)) {
      setHasStaleRows(true);
      setLocalError('This option or its stock changed after the page loaded, for example because a checkout reserved stock, so the change was refused. Load the latest values, then make your change again.');
      return;
    }
    setLocalError(describeRequestError(error));
  };

  /**
   * Loads the saved groups, values and stock rows again: null when they loaded, or why they did not.
   * The drafts are only rebuilt from a complete read. Until one succeeds, creating a value is refused,
   * because a value saved a moment ago can be missing from the drafts.
   */
  const reloadRows = async (): Promise<Error | null> => {
    try {
      await onRefresh();
      setHasStaleRows(false);
      return null;
    } catch (error) {
      setHasStaleRows(true);
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  const loadLatestRows = async () => {
    setBusyKey('refresh');
    setLocalError('');
    const loadError = await reloadRows();
    if (loadError) setLocalError(`${describeRequestError(loadError).replace(/\.?$/, '.')} Your edits are still here.`);
    setBusyKey(null);
  };

  /**
   * Values with their stock rows, and deletes, go to the commerce plugin, which applies each change in
   * one batch. A refusal the server answered wrote nothing, so the edits stay for another try. When the
   * rows changed or are gone, or when no answer says what happened (the change may have been saved),
   * the saved rows are loaded again, so a retry updates a value instead of creating it twice.
   */
  const sendVariantChange = async (key: string, change: Record<string, any>, messages: { failed: string; done: string }) => {
    setBusyKey(key);
    setLocalError('');
    setLocalStatus('');
    try {
      await requestEditorApi(`${basePath}/api/ecommerce/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      }, messages.failed);
    } catch (error) {
      const failure = error instanceof EditorRequestError ? error : new EditorRequestError(describeRequestError(error), 0);
      if (getVariantChangeRecovery(failure) === 'keep') {
        // Includes an expired session: the edits wait until the admin has signed in again.
        showRequestError(failure);
      } else {
        const loadError = await reloadRows();
        setLocalError(describeVariantChangeFailure(failure, messages.failed, !loadError));
      }
      setBusyKey(null);
      return;
    }
    setLocalStatus(messages.done);
    if (await reloadRows()) {
      setLocalError('The change is saved, but the saved options and stock could not be loaded again. Load them before creating another value.');
    }
    setBusyKey(null);
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
        savedInventoryQuantity: null,
        updatedAt: null,
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
                  savedStockQuantity: null,
                  updatedAt: null,
                  stockUpdatedAt: null,
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
    } catch (error) {
      showRequestError(error);
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
      const inventoryChanged = group.savedInventoryQuantity === null ||
        toRequiredNumber(group.inventoryQuantity, 0) !== toRequiredNumber(group.savedInventoryQuantity, 0);
      const payload = {
        // A blank optional value is sent as null, so clearing it on a saved group clears the column.
        data: {
          productId,
          variantId: group.variantId || null,
          name: group.name.trim(),
          sku: group.sku.trim() || null,
          priceOverride: toOptionalNumber(group.priceOverride) ?? null,
          ...(inventoryChanged ? { inventoryQuantity: toRequiredNumber(group.inventoryQuantity, 0) } : {}),
        },
        ...(group.id && group.updatedAt !== null ? { expectedUpdatedAt: group.updatedAt } : {}),
      };

      await requestCollection(
        '_ecommerce_product_variants',
        group.id ? 'PUT' : 'POST',
        payload,
        group.id || undefined
      );
      await onRefresh();
      setLocalStatus(`Saved variant group "${group.name.trim()}".`);
    } catch (error) {
      showRequestError(error);
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

    // A value whose save failed to answer may exist already; creating it again would duplicate it.
    if (!value.id && hasStaleRows) {
      setLocalError('Load the latest options and stock before creating a value: the ones shown may be out of date.');
      return;
    }

    // Checkout reserves stock in place, so only write the quantity the user actually changed.
    const stockChanged = !value.stockId || value.savedStockQuantity === null ||
      toRequiredNumber(value.stockQuantity, 0) !== toRequiredNumber(value.savedStockQuantity, 0);
    await sendVariantChange(`value:${value.localId}`, {
      action: 'saveValue',
      groupId: group.id,
      value: {
        ...(value.id ? { id: value.id, ...(value.updatedAt !== null ? { expectedUpdatedAt: value.updatedAt } : {}) } : {}),
        value: value.value.trim(),
        sku: value.sku.trim() || null,
        image: value.image.trim() || null,
        priceOverride: toOptionalNumber(value.priceOverride) ?? null,
      },
      ...(stockChanged ? {
        stock: {
          ...(value.stockId ? { id: value.stockId, ...(value.stockUpdatedAt !== null ? { expectedUpdatedAt: value.stockUpdatedAt } : {}) } : {}),
          quantity: toRequiredNumber(value.stockQuantity, 0),
        },
      } : {}),
    }, { failed: 'Failed to save the variant value', done: `Saved variant value "${value.value.trim()}".` });
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

    if (!window.confirm(`Delete variant value "${value.value || value.id}" with its stock row and variant component rows?`)) {
      return;
    }

    await sendVariantChange(`delete-value:${value.localId}`, { action: 'deleteValue', valueId: value.id },
      { failed: 'Failed to delete the variant value', done: `Deleted variant value "${value.value || value.id}".` });
  };

  const deleteGroup = async (group: ProductVariantGroupDraft) => {
    if (!group.id) {
      setDraftGroups((current) => current.filter((candidate) => candidate.localId !== group.localId));
      return;
    }

    if (!window.confirm(`Delete variant group "${group.name || group.id}" and all its values, with their stock rows and variant component rows?`)) {
      return;
    }

    await sendVariantChange(`delete-group:${group.localId}`, { action: 'deleteGroup', groupId: group.id },
      { failed: 'Failed to delete the variant group', done: `Deleted variant group "${group.name || group.id}".` });
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
          <label htmlFor={controlId('new-definition')} className="sr-only">New option definition name</label>
          <input
            id={controlId('new-definition')}
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

      {localError && (
        <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          <p>{localError}</p>
          {hasStaleRows && (
            <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void loadLatestRows()} disabled={busyKey === 'refresh'}>
              {busyKey === 'refresh' ? 'Loading...' : 'Load latest options and stock'}
            </Button>
          )}
        </div>
      )}
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
                  <Button type="button" variant="destructive" aria-label={`Delete variant group ${group.name || index + 1}`} onClick={() => void deleteGroup(group)} disabled={busyKey === `delete-group:${group.localId}`}>
                    Delete
                  </Button>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor={controlId(group.localId, 'definition')} className="text-sm font-medium text-zinc-300">Option Definition</label>
                  <select
                    id={controlId(group.localId, 'definition')}
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
                  <label htmlFor={controlId(group.localId, 'name')} className="text-sm font-medium text-zinc-300">Group Name</label>
                  <input
                    id={controlId(group.localId, 'name')}
                    type="text"
                    value={group.name}
                    onChange={(event) => updateGroupDraft(group.localId, { name: event.target.value })}
                    placeholder="e.g. Shirt Sizes"
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor={controlId(group.localId, 'sku')} className="text-sm font-medium text-zinc-300">SKU Override</label>
                  <input
                    id={controlId(group.localId, 'sku')}
                    type="text"
                    value={group.sku}
                    onChange={(event) => updateGroupDraft(group.localId, { sku: event.target.value })}
                    placeholder="Optional"
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor={controlId(group.localId, 'price')} className="text-sm font-medium text-zinc-300">Group Price Override (smallest currency unit)</label>
                  <input
                    id={controlId(group.localId, 'price')}
                    type="number"
                    value={group.priceOverride}
                    onChange={(event) => updateGroupDraft(group.localId, { priceOverride: event.target.value })}
                    placeholder="Optional"
                    className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor={controlId(group.localId, 'inventory')} className="text-sm font-medium text-zinc-300">Legacy Inventory Quantity</label>
                  <input
                    id={controlId(group.localId, 'inventory')}
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
                            <Button type="button" variant="destructive" aria-label={`Delete variant value ${value.value || 'Untitled value'}`} onClick={() => void deleteValue(group.localId, value)} disabled={busyKey === `delete-value:${value.localId}`}>
                              Delete
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'label')} className="text-sm font-medium text-zinc-300">Value Label</label>
                            <input
                              id={controlId(value.localId, 'label')}
                              type="text"
                              value={value.value}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { value: event.target.value })}
                              placeholder="e.g. Small"
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'sku')} className="text-sm font-medium text-zinc-300">Value SKU</label>
                            <input
                              id={controlId(value.localId, 'sku')}
                              type="text"
                              value={value.sku}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { sku: event.target.value })}
                              placeholder="Optional"
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'image')} className="text-sm font-medium text-zinc-300">Variant Image</label>
                            <MediaFieldInput
                              inputId={controlId(value.localId, 'image')}
                              adminBasePath={basePath}
                              value={value.image}
                              onChange={(nextValue) => updateValueDraft(group.localId, value.localId, { image: nextValue })}
                              placeholder="Optional hero image override"
                            />
                          </div>
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'price')} className="text-sm font-medium text-zinc-300">Price Override (smallest currency unit)</label>
                            <input
                              id={controlId(value.localId, 'price')}
                              type="number"
                              value={value.priceOverride}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { priceOverride: event.target.value })}
                              placeholder="Optional"
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'stock')} className="text-sm font-medium text-zinc-300">Stock Quantity</label>
                            <input
                              id={controlId(value.localId, 'stock')}
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
  const idPrefix = useId();
  const libraries = getLibraryDefinitions();
  const selectedLibrary = libraries.find((library: any) => library.id === selectedLibraryId) || null;
  const selectedComponent = getLibraryComponentDefinition(selectedLibraryId, selectedComponentSlug);

  return (
    <div className="space-y-8 mt-2">
      <form.Field
        name="name"
        children={(fieldApi: any) => (
          <div className="space-y-2">
            <label htmlFor={`${idPrefix}-name`} className="block text-sm font-medium text-zinc-300">Preset Name <span aria-hidden="true" className="text-red-400">*</span></label>
            <input
              id={`${idPrefix}-name`}
              aria-required="true"
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
              <label htmlFor={`${idPrefix}-library`} className="block text-sm font-medium text-zinc-300">Library <span aria-hidden="true" className="text-red-400">*</span></label>
              <select
                id={`${idPrefix}-library`}
                aria-required="true"
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
              <label htmlFor={`${idPrefix}-component`} className="block text-sm font-medium text-zinc-300">Component <span aria-hidden="true" className="text-red-400">*</span></label>
              <select
                id={`${idPrefix}-component`}
                aria-required="true"
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
              <label htmlFor={`${idPrefix}-variant`} className="block text-sm font-medium text-zinc-300">Variant</label>
              <input
                id={`${idPrefix}-variant`}
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
          <div className="text-sm font-medium text-zinc-300">Component Props</div>
          <p className="mt-1 text-xs text-zinc-500">These fields are stored into the preset payload and injected when the preset is used in a block slot.</p>
        </div>
        {selectedComponent ? (
          <div className="space-y-4">
            {selectedComponent.fields.map((componentField: any) => (
              <FieldRenderer
                key={`preset-${selectedComponent.slug}-${componentField.name}`}
                field={componentField}
                form={form}
                fieldPath="presetProps"
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

type EditorAction = 'save' | 'publish' | 'archive' | 'restore';

// Local edits kept after a 409, so the user can compare, copy or re-apply them.
type EditConflict = {
  action: EditorAction;
  /** Only the top-level fields the user changed from the version they opened, with the edited values. */
  changes: Record<string, any>;
  /** The edited slug, or null when the user did not change it. */
  slug: string | null;
  latestLoaded: boolean;
};

/** Top-level fields whose value differs between the edited values and the version the edits started from. */
function getChangedFieldNames(values: Record<string, any>, baseline: Record<string, any>) {
  return [...new Set([...Object.keys(values), ...Object.keys(baseline)])]
    .filter((name) => JSON.stringify(values[name]) !== JSON.stringify(baseline[name]));
}

export function CollectionEntryEditor({
  collection,
  entry: rawEntry,
  revisions: initialRevisions,
  isNew,
  relationOptions,
  relationSupportEntries: loadedSupportEntries,
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
  const isAdmin = router.options.context.user?.role === 'admin';
  const nativeCollection = isNativeCollection(collection);
  const presetCollection = isComponentPresetCollection(collection);
  const versioningEnabled = !nativeCollection;
  const supportsRawView = !nativeCollection && !presetCollection;
  const sectionCollectionRoute = getSectionCollectionRoute(section);
  const sectionEntryRoute = getSectionEntryRoute(section);
  const editorFields = getEditorFields(collection, isNew);
  const nativeIdColumn = getNativeIdColumn(collection);
  const recordLabel = nativeCollection ? 'record' : 'entry';

  const [currentEntry, setCurrentEntry] = useState<any>(initialEntry);
  const [revisions, setRevisions] = useState<any[]>(initialRevisions || []);
  const [entrySlug, setEntrySlug] = useState(initialEntry?.slug || '');
  const [slugError, setSlugError] = useState('');
  const slugInputId = useId();
  // Records next to the entry (relation targets, commerce options and stock). The variant editor
  // reloads its own tables into this, rather than reloading the whole page.
  const [relationSupportEntries, setRelationSupportEntries] = useState<CommerceSupportEntries>(loadedSupportEntries);
  useEffect(() => setRelationSupportEntries(loadedSupportEntries), [loadedSupportEntries]);
  const [viewMode, setViewMode] = useState<'form' | 'raw'>('form');
  const [isWorking, setIsWorking] = useState(false);

  // Computed once: useForm re-applies changed defaultValues to an untouched form on every render,
  // which would undo the form.reset calls below. Resets keep these defaults for the same reason.
  const [defaultValues] = useState<Record<string, any>>(() => {
    if (presetCollection) {
      return buildPresetEditorDefaults(initialEntry, editorFields);
    }

    if (initialEntry?.data) {
      return parseEntryData(initialEntry, editorFields);
    }

    return buildDefaultValues(editorFields);
  });

  const [selectedPresetLibraryId, setSelectedPresetLibraryId] = useState(defaultValues.libraryId || '');
  const [selectedPresetComponentSlug, setSelectedPresetComponentSlug] = useState(defaultValues.componentSlug || '');
  const selectedPresetComponent = presetCollection
    ? getLibraryComponentDefinition(selectedPresetLibraryId, selectedPresetComponentSlug)
    : null;

  const [rawJsonStr, setRawJsonStr] = useState(() => JSON.stringify(defaultValues, null, 2));

  const [globalError, setGlobalError] = useState('');
  const [notice, setNotice] = useState('');
  // A publish or archive answered with HTTP 202: a Workflow is still running it. The editor checks the
  // entry a few times ('checking'), then leaves the next reload to the user ('waiting'). Entry actions
  // stay disabled until a reload, so a second click cannot start another instance.
  const [pendingTransition, setPendingTransition] = useState<(PendingTransition & { phase: 'checking' | 'waiting' }) | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<ServerFieldErrors>({});
  const [conflict, setConflict] = useState<EditConflict | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
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

  // The last loaded or saved state. The editor has unsaved changes while the form, slug or raw JSON differ from it.
  const savedSnapshotRef = useRef({ values: JSON.stringify(defaultValues), slug: initialEntry?.slug || '' });
  const rawSnapshotRef = useRef(rawJsonStr);
  const formValuesChanged = useStore(form.store, (state: any) => JSON.stringify(state.values) !== savedSnapshotRef.current.values);
  const hasUnsavedChanges = Boolean(collection) && !collection.readOnly && (
    formValuesChanged ||
    entrySlug !== savedSnapshotRef.current.slug ||
    (viewMode === 'raw' && rawJsonStr !== rawSnapshotRef.current)
  );
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  hasUnsavedChangesRef.current = hasUnsavedChanges;
  // After a 409 and "Load latest version" the user's edits are only in the conflict panel until they are
  // put back. They still count as unsaved for the badge and the leave guards, but not for "save a draft
  // before publishing", which would only save the unchanged latest version again.
  const conflictHoldsChanges = Boolean(conflict?.latestLoaded && (Object.keys(conflict.changes).length > 0 || conflict.slug != null));
  const hasUnsavedWork = hasUnsavedChanges || conflictHoldsChanges;
  const hasUnsavedWorkRef = useRef(hasUnsavedWork);
  hasUnsavedWorkRef.current = hasUnsavedWork;
  // Set when the editor itself navigates away after a successful save (opening a newly created entry).
  const leavingEditorRef = useRef(false);

  const shouldBlockNavigation = useCallback(({ current, next }: { current: { pathname: string }; next: { pathname: string } }) => {
    // Same-page hash links (the product section nav) are not a navigation away.
    if (leavingEditorRef.current || !hasUnsavedWorkRef.current || current.pathname === next.pathname) return false;
    return !window.confirm('You have unsaved changes. Leave this page and discard them?');
  }, []);
  const warnBeforeUnload = useCallback(() => !leavingEditorRef.current && hasUnsavedWorkRef.current, []);
  useBlocker({ shouldBlockFn: shouldBlockNavigation, enableBeforeUnload: warnBeforeUnload });

  useEffect(() => {
    const carriedNotice = takeEditorNotice(slug, entryId);
    if (carriedNotice) setGlobalError(carriedNotice);
    const carriedTransition = takePendingTransition(slug, entryId);
    if (carriedTransition) setPendingTransition({ ...carriedTransition, phase: 'checking' });
  }, [slug, entryId]);

  // Checks a pending publish or archive a few times. The handlers it calls are defined after the
  // collection check below; a transition can only be pending once the editor rendered past it.
  useEffect(() => {
    if (!collection || !pendingTransition || pendingTransition.phase !== 'checking') return;
    const pending = pendingTransition;
    let cancelled = false;
    void waitForPendingTransition(pending, {
      loadEntry: () => fetchEntry(pending.entryId),
      isCancelled: () => cancelled,
    }).then((latest) => {
      if (cancelled) return;
      if (latest) void settlePendingTransition(pending, latest);
      else setPendingTransition({ ...pending, phase: 'waiting' });
    });
    return () => {
      cancelled = true;
    };
  }, [pendingTransition]);

  const clearServerFieldError = useCallback((fieldPath: string) => {
    setServerFieldErrors((current) => {
      if (!(fieldPath in current)) return current;
      const next = { ...current };
      delete next[fieldPath];
      return next;
    });
  }, []);
  const serverFieldErrorsContext = useMemo(
    () => ({ errors: serverFieldErrors, clearError: clearServerFieldError }),
    [serverFieldErrors, clearServerFieldError]
  );

  if (!collection) return <div>Collection not found.</div>;

  const currentStatus = getEntryStatus(currentEntry, collection);
  const entryActionsLocked = isWorking || pendingTransition !== null;
  const pendingSlugRename = versioningEnabled ? getPendingSlugRename(currentEntry, entrySlug) : null;
  const formatSlugForDisplay = (value: string) => (slug === 'pages' ? getPagePath(value) : value);
  const showProductConfigurator = isCommerceProductCollection(collection);
  const inventoryFieldNames = getInventoryFieldNames(collection);

  const parseEditorValues = () => {
    if (supportsRawView && viewMode === 'raw') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJsonStr);
      } catch (error) {
        throw new Error(`Fix the raw JSON before saving: ${error instanceof Error ? error.message : String(error)}`);
      }
      const normalized = normalizeStoredFieldData(editorFields, parsed);
      form.reset(normalized, { keepDefaultValues: true });
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
    const nextDefaults = presetCollection ? buildPresetEditorDefaults(entry, editorFields) : parsedData;
    const nextRawJson = JSON.stringify(parsedData, null, 2);
    savedSnapshotRef.current = { values: JSON.stringify(nextDefaults), slug: entry?.slug || '' };
    rawSnapshotRef.current = nextRawJson;
    setCurrentEntry(entry);
    setEntrySlug(entry?.slug || '');
    setRawJsonStr(nextRawJson);
    form.reset(nextDefaults, { keepDefaultValues: true });
    if (presetCollection) {
      setSelectedPresetLibraryId(nextDefaults.libraryId || '');
      setSelectedPresetComponentSlug(nextDefaults.componentSlug || '');
    }
    if (nextRevisions) setRevisions(nextRevisions);
  };

  const fetchEntry = (targetEntryId: string) =>
    requestEditorApi(`${basePath}/api/collections/${slug}/entries/${targetEntryId}`, {}, `Failed to load this ${recordLabel}`);

  // Reloads only this entry and its history. The route drops its cached load when the editor is
  // left (gcTime 0), so there is no need to rerun the whole loader after every save.
  // `keepUnsavedWork`: when the form has unsaved changes once the entry is loaded, leave it as it is
  // and resolve with null.
  const refreshEntryState = async (targetEntryId: string, { keepUnsavedWork = false } = {}) => {
    const [nextEntry, nextRevisions] = await Promise.all([
      fetchEntry(targetEntryId),
      versioningEnabled
        ? requestEditorApi(`${basePath}/api/collections/${slug}/entries/${targetEntryId}/revisions?limit=${REVISION_LIST_LIMIT}`, {}, 'Failed to load revision history')
          .catch(() => revisions)
        : Promise.resolve(revisions)
    ]);

    if (keepUnsavedWork && hasUnsavedWorkRef.current) return null;
    syncEntryState(nextEntry, nextRevisions);
    return nextEntry;
  };

  const broadcastChange = (targetEntryId: string) => {
    try {
      const channel = new BroadcastChannel('talisman-cms-preview');
      channel.postMessage({
        type: 'TALISMAN_ENTRY_SAVED',
        collectionSlug: slug,
        entryId: targetEntryId,
      });
    } catch (err) {
      console.error('[Talisman CMS] Failed to broadcast save event', err);
    }
  };

  // The entry moved on from a pending publish or archive. Edits made while waiting stay in the form:
  // their next save gets the conflict panel, which loads the latest version and keeps them. Without
  // edits the entry and its history are reloaded, unless the user starts typing during that reload.
  const settlePendingTransition = async (pending: PendingTransition, latest: any) => {
    broadcastChange(pending.entryId);
    try {
      const shown = hasUnsavedWorkRef.current ? null : await refreshEntryState(pending.entryId, { keepUnsavedWork: true });
      if (!shown) {
        // A publish or archive leaves the content as it was, so take on the new status and revision
        // under the user's edits; otherwise their next save is refused as a stale edit.
        const values = presetCollection ? buildPresetEditorDefaults(latest, editorFields) : parseEntryData(latest, editorFields);
        if (JSON.stringify(values) === savedSnapshotRef.current.values && (latest?.slug || '') === savedSnapshotRef.current.slug) {
          setCurrentEntry(latest);
        }
      }
      setNotice(shown
        ? describeSettledTransition(shown, pending, recordLabel)
        : `${describeSettledTransition(latest, pending, recordLabel)} Your unsaved changes are still in the form.`);
    } catch (error) {
      setGlobalError(describeRequestError(error));
    } finally {
      setPendingTransition(null);
    }
  };

  // After the automatic checks, the user reloads the entry. That ends the wait either way, so a
  // transition that failed in its Workflow can be tried again.
  const checkPendingTransition = async () => {
    if (!pendingTransition) return;
    const pending = pendingTransition;
    setGlobalError('');
    setIsWorking(true);
    try {
      const latest = await fetchEntry(pending.entryId);
      if (hasEntryMovedOn(latest, pending)) {
        await settlePendingTransition(pending, latest);
        return;
      }
      setPendingTransition(null);
      setNotice(`The ${pending.action} has not finished yet. It can still finish in the background: reload the page in a minute and check the status before you try again.`);
    } catch (error) {
      setGlobalError(describeRequestError(error));
    } finally {
      setIsWorking(false);
    }
  };

  // Native rows are written in place. Checkout changes stock with `quantity = quantity - n`, so an
  // inventory value the user did not touch is left out rather than written back as loaded (the
  // server validates native updates partially and keeps the stored value).
  const buildNativeWriteData = (value: Record<string, any>) => {
    const savedValues = JSON.parse(savedSnapshotRef.current.values);
    const data = { ...value };
    for (const name of inventoryFieldNames) {
      if (JSON.stringify(data[name]) === JSON.stringify(savedValues[name])) delete data[name];
    }
    return data;
  };

  const persistDraft = async () => {
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
    const loadedUpdatedAt = getLoadedUpdatedAt(currentEntry);
    // Optional fields left blank are sent as null (or left out of a new native row), not as ''.
    const data = prepareFieldValuesForSave(editorFields, value, nativeCollection
      ? { native: true, mode: isNew ? 'create' : 'update', baseline: JSON.parse(savedSnapshotRef.current.values) }
      : {});
    const body = nativeCollection
      ? isNew
        ? { data }
        : { data: buildNativeWriteData(data), ...(loadedUpdatedAt !== null ? { expectedUpdatedAt: loadedUpdatedAt } : {}) }
      : { slug: entrySlug, data, ...(!isNew ? { expectedRevisionId: currentEntry?.latestRevisionId ?? null } : {}) };

    const savedEntry = await requestEditorApi(url, {
      method,
      body: JSON.stringify(body)
    }, `Failed to save this ${recordLabel}`);
    broadcastChange(savedEntry.id);
    return savedEntry;
  };

  // A new entry opens at its own URL; the route remounts the editor there with the saved state.
  const openCreatedEntry = (createdEntryId: string) => {
    leavingEditorRef.current = true;
    void navigate({ to: sectionEntryRoute, params: { slug, entryId: createdEntryId }, replace: true });
  };

  // Keep only what the user changed. Re-applying the whole form would write back fields that
  // someone else (or a checkout, for stock) changed since the editor loaded.
  const collectUserChanges = (values: Record<string, any>): Pick<EditConflict, 'changes' | 'slug'> => {
    const baseline = JSON.parse(savedSnapshotRef.current.values);
    const changes = Object.fromEntries(getChangedFieldNames(values, baseline).map((name) => [name, values[name]]));
    const slugChanged = entrySlug !== savedSnapshotRef.current.slug;
    return { changes, slug: slugChanged ? entrySlug : null };
  };

  const handleRequestError = (error: unknown, action: EditorAction) => {
    // The server also answers 409 for a slug or unique value another record uses. Only a stale edit
    // opens the conflict panel: loading the latest version cannot fix the others.
    if (isStaleEditError(error) && currentEntry?.id) {
      setConflict({ action, ...collectUserChanges(form.state.values as Record<string, any>), latestLoaded: false });
      setCopyState('idle');
      return;
    }

    if (isSlugConflictError(error)) {
      setSlugError(error.message);
      setGlobalError(`${error.message} Choose a different slug, then try the ${action} again.`);
      return;
    }

    if (error instanceof EditorRequestError && Object.keys(error.fieldErrors).length > 0) {
      setServerFieldErrors(error.fieldErrors);
      setGlobalError(error.status === 400 ? 'Some fields need attention. Fix them and try again.' : error.message);
      return;
    }

    setGlobalError(error instanceof Error ? error.message : String(error));
  };

  const resetFeedback = () => {
    setGlobalError('');
    setNotice('');
    setServerFieldErrors({});
    setSlugError('');
    setConflict(null);
  };

  const runEntryAction = async (action: Exclude<EditorAction, 'restore'>) => {
    if (pendingTransition) return;
    if (!confirmDiscardConflictChanges(`The ${action} will not include them and they will be lost. Continue?`)) return;
    resetFeedback();
    setIsWorking(true);
    let createdEntryId: string | null = null;

    try {
      let targetEntry = currentEntry;
      // Publish and archive act on the stored draft, so only save first when there is something to save.
      if (action === 'save' || isNew || hasUnsavedChangesRef.current) {
        const savedEntry = await persistDraft();
        if (isNew) {
          createdEntryId = savedEntry.id;
          if (action === 'save') {
            openCreatedEntry(savedEntry.id);
            return;
          }
          targetEntry = await fetchEntry(savedEntry.id);
        } else {
          targetEntry = await refreshEntryState(savedEntry.id);
        }
      }

      if (action === 'save') return;

      const nextEntry = await requestEditorApi(`${basePath}/api/collections/${slug}/entries/${targetEntry.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevisionId: targetEntry.latestRevisionId ?? null })
      }, `Failed to ${action} this ${recordLabel}`);
      // HTTP 202: a Workflow is still running the transition, and the answer is the entry before it.
      const pending = readPendingTransition(nextEntry, {
        action,
        entryId: targetEntry.id,
        fromRevisionId: targetEntry.latestRevisionId,
        recordLabel,
      });
      // Preview windows hear about a pending transition once it has happened.
      if (!pending) broadcastChange(targetEntry.id);

      if (createdEntryId) {
        if (pending) stashPendingTransition(slug, pending);
        openCreatedEntry(createdEntryId);
        return;
      }

      if (!pending) {
        await refreshEntryState(nextEntry.id);
        return;
      }

      // The form is left alone: it already holds the entry before the transition (a draft save reloads
      // it first), and anything typed during the server's wait or from now on must stay in it.
      setPendingTransition({ ...pending, phase: 'checking' });
      const latest = await fetchEntry(pending.entryId).catch(() => null);
      if (latest && hasEntryMovedOn(latest, pending)) await settlePendingTransition(pending, latest);
    } catch (error) {
      if (createdEntryId) {
        // The draft exists now; open it so a retry updates it instead of creating a duplicate.
        stashEditorNotice(slug, createdEntryId, `The ${recordLabel} was saved as a draft, but the ${action} failed: ${describeRequestError(error)}`);
        openCreatedEntry(createdEntryId);
        return;
      }
      handleRequestError(error, action);
    } finally {
      // Stay disabled while the created entry opens, so a second click cannot create a duplicate.
      if (!leavingEditorRef.current) setIsWorking(false);
    }
  };

  const handleRestoreRevision = async (revisionId: string) => {
    if (!currentEntry?.id || pendingTransition) return;
    if (hasUnsavedWorkRef.current && !window.confirm('Restoring this revision replaces your unsaved changes. Continue?')) return;

    resetFeedback();
    setIsWorking(true);

    try {
      const restored = await requestEditorApi(`${basePath}/api/collections/${slug}/entries/${currentEntry.id}/revisions/${revisionId}/restore`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevisionId: currentEntry.latestRevisionId ?? null })
      }, 'Failed to restore this revision');

      broadcastChange(restored.id);
      await refreshEntryState(restored.id);
    } catch (error) {
      handleRequestError(error, 'restore');
    } finally {
      setIsWorking(false);
    }
  };

  const conflictFieldNames = conflict ? Object.keys(conflict.changes) : [];
  const conflictHasChanges = conflictFieldNames.length > 0 || conflict?.slug != null;
  const conflictChangeLabels = [
    ...(conflict?.slug != null ? ['Slug'] : []),
    ...conflictFieldNames.map((name) => describeFieldPath(name, editorFields, conflict?.changes))
  ].join(', ');
  const conflictDraftJson = conflict && conflictHasChanges
    ? JSON.stringify(nativeCollection ? conflict.changes : { ...(conflict.slug != null ? { slug: conflict.slug } : {}), data: conflict.changes }, null, 2)
    : '';

  // Edits that only the conflict panel holds are gone once it closes, so ask first.
  const confirmDiscardConflictChanges = (outcome: string) =>
    !conflictHoldsChanges || window.confirm(`Your changes to ${conflictChangeLabels} have not been put back into the form. ${outcome}`);

  const dismissConflict = () => {
    if (!confirmDiscardConflictChanges('Dismiss them? They will be lost.')) return;
    setConflict(null);
  };

  const copyConflictDraft = async () => {
    try {
      await navigator.clipboard.writeText(conflictDraftJson);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const loadLatestAfterConflict = async () => {
    if (!conflict || !currentEntry?.id) return;
    // The form still holds the user's edits, including any made after the 409: the panel keeps them
    // once the latest version replaces the form.
    let held: Pick<EditConflict, 'changes' | 'slug'>;
    try {
      held = collectUserChanges(supportsRawView && viewMode === 'raw' ? parseEditorValues() : form.state.values as Record<string, any>);
    } catch (error) {
      setGlobalError(describeRequestError(error));
      return;
    }
    setGlobalError('');
    setIsWorking(true);

    try {
      await refreshEntryState(currentEntry.id);
      setConflict({ ...conflict, ...held, latestLoaded: true });
    } catch (error) {
      setGlobalError(describeRequestError(error));
    } finally {
      setIsWorking(false);
    }
  };

  // Puts only the fields the user changed back on top of the latest version. Every other field keeps
  // its latest value, so saving neither reverts someone else's edits nor writes back stale stock.
  const reapplyConflictDraft = () => {
    if (!conflict) return;
    let latestValues: Record<string, any>;
    try {
      latestValues = supportsRawView && viewMode === 'raw' ? parseEditorValues() : form.state.values as Record<string, any>;
    } catch (error) {
      setGlobalError(describeRequestError(error));
      return;
    }

    const nextValues = { ...latestValues };
    for (const [name, value] of Object.entries(conflict.changes)) {
      if (value === undefined) delete nextValues[name];
      else nextValues[name] = value;
    }
    form.reset(nextValues, { keepDefaultValues: true });
    if (conflict.slug != null) setEntrySlug(conflict.slug);
    setRawJsonStr(JSON.stringify(nextValues, null, 2));
    if (presetCollection) {
      setSelectedPresetLibraryId(nextValues.libraryId || '');
      setSelectedPresetComponentSlug(nextValues.componentSlug || '');
    }
    setConflict(null);
    setNotice(`Your changes are back in the form on top of the latest version; other fields keep their latest values. Save to apply them.`);
  };

  const toggleViewMode = () => {
    if (viewMode === 'form') {
       // Sync form values to raw view
       const nextRawJson = JSON.stringify(form.state.values, null, 2);
       rawSnapshotRef.current = nextRawJson;
       setRawJsonStr(nextRawJson);
       setViewMode('raw');
    } else {
       // Try syncing raw view back to form
       try {
         const parsed = JSON.parse(rawJsonStr);
         // Overwrite entire form state
         form.reset(parsed, { keepDefaultValues: true });
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

  // Variant, value and stock rows are separate records: reload just those tables, without resetting
  // the product form or reloading the entry and every other related collection. The configurator
  // rebuilds its drafts from the result, so a refused read throws instead of reading as empty.
  const refreshCommerceData = async () => {
    const collections = await fetchCollectionConfigs(basePath);
    const latest = await fetchEntriesBySlug(basePath, PRODUCT_CONFIGURATOR_SLUGS, collections, { strict: true });
    setRelationSupportEntries((current) => ({ ...current, ...latest }));
  };

  const entryData = parseEntryData(currentEntry, editorFields);
  const displayLabel = showProductConfigurator && typeof entryData.name === 'string' && entryData.name
    ? entryData.name
    : initialEntry?.slug || initialEntry?.id?.substring(0, 8) || slug;

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
                  {!showProductConfigurator && <form.Subscribe
                    selector={(state: any) => state.values}
                    children={(values: Record<string, any>) => (
                      <CommerceModelGuide
                        collectionSlug={collection.slug}
                        values={values}
                        relationSupportEntries={relationSupportEntries}
                      />
                    )}
                  />}

                  {!nativeCollection && (
                    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-5">
                      <label htmlFor={slugInputId} className="text-sm font-medium mb-2 block text-zinc-300">Slug (Optional)</label>
                      <input 
                         id={slugInputId}
                         type="text" 
                         value={entrySlug}
                         onChange={(e) => { setEntrySlug(e.target.value); setSlugError(''); }}
                         placeholder="e.g. my-awesome-post"
                         aria-invalid={slugError ? true : undefined}
                         aria-describedby={[`${slugInputId}-help`, pendingSlugRename ? `${slugInputId}-live` : '', slugError ? `${slugInputId}-error` : ''].filter(Boolean).join(' ')}
                         className={`w-full bg-zinc-950/50 border rounded-md px-4 py-2 text-sm focus:outline-none focus:ring-2 transition-all placeholder:text-zinc-600 shadow-inner ${slugError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50 focus:border-indigo-500/50'}`}
                      />
                      <p id={`${slugInputId}-help`} className="text-xs text-zinc-500 mt-2 flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-indigo-500/50" />Leave blank to auto-generate from ID.</p>
                      {pendingSlugRename && (
                        <p id={`${slugInputId}-live`} className="text-xs text-amber-300 mt-2">
                          Live at <code className="font-mono">{formatSlugForDisplay(pendingSlugRename.liveSlug)}</code>. The site keeps that address until this {recordLabel} is published; then <code className="font-mono">{formatSlugForDisplay(pendingSlugRename.nextSlug)}</code> goes live.
                        </p>
                      )}
                      {slugError && <p id={`${slugInputId}-error`} role="alert" className="text-xs text-red-400 mt-2">{slugError}</p>}
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
                         <h2 className="text-base font-medium block text-white flex items-center gap-2">
                           <span aria-hidden="true" className="p-1 rounded bg-indigo-500/10 text-indigo-400">
                             <Database size={14} />
                           </span>
                           {showProductConfigurator ? 'Product fields' : nativeCollection ? 'Record fields' : 'Content fields'}
                         </h2>
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
                             aria-label="Raw JSON"
                             value={rawJsonStr}
                             onChange={(e) => setRawJsonStr(e.target.value)}
                             spellCheck={false}
                             className="w-full bg-black/50 border border-white/10 rounded-lg p-5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 min-h-[500px] shadow-inner text-indigo-100 leading-relaxed"
                         />
                    ) : (
                        <AdminBasePathContext.Provider value={basePath}>
                          <ServerFieldErrorsContext.Provider value={serverFieldErrorsContext}>
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
                                            fieldPath=""
                                            relationOptions={relationOptions}
                                            relationSupportEntries={relationSupportEntries}
                                            collapseStorageKey={collapseStorageKey}
                                        />
                                    ))
                                )}
                            </div>
                          </ServerFieldErrorsContext.Provider>
                        </AdminBasePathContext.Provider>
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
                    {!collection.readOnly && <Button onClick={handleManualSaveClick} disabled={entryActionsLocked} className="w-full gap-2 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] transition-all duration-300 border-0 h-11 text-base">
                      <Save size={18} /> {isWorking ? 'Working...' : versioningEnabled ? 'Save Draft' : 'Save Changes'}
                    </Button>}
                    {versioningEnabled && !collection.readOnly && isAdmin && (
                      <div className="grid grid-cols-2 gap-3 mt-3">
                        <Button type="button" variant="outline" disabled={entryActionsLocked} onClick={() => void runEntryAction('publish')} className="gap-2">
                          <Send size={16} /> {pendingTransition?.action === 'publish' ? 'Publishing...' : 'Publish'}
                        </Button>
                        <Button type="button" variant="outline" disabled={entryActionsLocked || isNew} onClick={() => void runEntryAction('archive')} className="gap-2">
                          <Archive size={16} /> {pendingTransition?.action === 'archive' ? 'Archiving...' : 'Archive'}
                        </Button>
                      </div>
                    )}
                    {hasUnsavedWork && !isWorking && (
                      <p className="text-xs text-amber-300 mt-3 text-center">Unsaved changes</p>
                    )}
                    {globalError && <p role="alert" className="text-red-400 text-sm mt-3 text-center">{globalError}</p>}
                    {Object.keys(serverFieldErrors).length > 0 && (
                      <form.Subscribe
                        selector={(state: any) => state.values}
                        children={(values: Record<string, any>) => (
                          <ul className="mt-3 space-y-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                            {Object.entries(serverFieldErrors).map(([fieldPath, messages]) => (
                              <li key={fieldPath || 'entry'}>
                                <span className="font-medium">{describeFieldPath(fieldPath, collection.fields || [], values)}</span>: {messages.join(', ')}
                              </li>
                            ))}
                          </ul>
                        )}
                      />
                    )}
                    {pendingTransition && (
                      <div role="status" className="mt-3 space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-center text-sm text-sky-100">
                        <p>{pendingTransition.message}</p>
                        {pendingTransition.phase === 'checking' ? (
                          <p className="text-xs text-sky-100/70">Checking for the result...</p>
                        ) : (
                          <Button type="button" size="sm" variant="outline" onClick={() => void checkPendingTransition()} disabled={isWorking}>
                            Reload {recordLabel}
                          </Button>
                        )}
                      </div>
                    )}
                    {notice && <p className="text-emerald-300 text-sm mt-3 text-center">{notice}</p>}
                    {conflict && (
                      <div role="alert" className="mt-4 space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                        <div className="font-medium text-amber-50">
                          {conflict.latestLoaded ? 'The latest saved version is now in the form' : `This ${recordLabel} changed after you opened it`}
                        </div>
                        <p className="text-amber-100/80">
                          {conflict.latestLoaded
                            ? conflictHasChanges
                              ? `Your changes to ${conflictChangeLabels} are kept below. Put them back to apply only those fields on top of the latest version, then save. Everything else keeps its latest value.`
                              : `You had no unsaved changes, so nothing was lost. Check the latest version, then retry the ${conflict.action} if it still applies.`
                            : `The ${conflict.action} was refused because ${inventoryFieldNames.length > 0 ? 'another editor or an order' : 'someone else'} changed this ${recordLabel}. ${conflictHasChanges
                              ? `Your changes to ${conflictChangeLabels} are still in the form. Load the latest version to see what changed; your changes stay available here.`
                              : `You had no unsaved changes. Load the latest version, then retry the ${conflict.action}.`}`}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {conflictHasChanges && (
                            <Button type="button" size="sm" variant="outline" onClick={() => void copyConflictDraft()}>
                              {copyState === 'copied' ? 'Copied' : 'Copy my changes'}
                            </Button>
                          )}
                          {conflict.latestLoaded ? (
                            <>
                              {conflictHasChanges && (
                                <Button type="button" size="sm" variant="outline" onClick={reapplyConflictDraft} disabled={isWorking}>
                                  Put my changes back
                                </Button>
                              )}
                              <Button type="button" size="sm" variant="ghost" onClick={dismissConflict}>
                                Dismiss
                              </Button>
                            </>
                          ) : (
                            <Button type="button" size="sm" variant="outline" onClick={() => void loadLatestAfterConflict()} disabled={isWorking}>
                              Load latest version
                            </Button>
                          )}
                        </div>
                        {conflictHasChanges && (
                          <>
                            {copyState === 'failed' && <p className="text-xs">This browser blocked copying. Select the text below and copy it.</p>}
                            <details open={copyState === 'failed' || conflict.latestLoaded}>
                              <summary className="cursor-pointer text-xs text-amber-100/80">My changes as JSON</summary>
                              <textarea
                                readOnly
                                value={conflictDraftJson}
                                spellCheck={false}
                                className="mt-2 h-40 w-full rounded-md border border-white/10 bg-black/40 p-2 font-mono text-xs text-zinc-200"
                              />
                            </details>
                          </>
                        )}
                      </div>
                    )}
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
                     {revisions.length >= REVISION_LIST_LIMIT && (
                       <p className="text-xs text-zinc-500">Showing the {REVISION_LIST_LIMIT} most recent revisions.</p>
                     )}
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
                               {isAdmin && !collection.readOnly && <Button type="button" variant="ghost" size="sm" disabled={entryActionsLocked} onClick={() => void handleRestoreRevision(revision.id)}>
                                 Restore
                               </Button>}
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
          <form.Subscribe
            selector={(state: any) => state.values}
            children={(values: Record<string, any>) => (
              <ProductVariantConfigurator
                productId={currentEntry?.id || null}
                relationSupportEntries={relationSupportEntries}
                basePath={basePath}
                onRefresh={refreshCommerceData}
                productValues={values}
              />
            )}
          />
        </div>}
      </div>
    </div>
  );
}
