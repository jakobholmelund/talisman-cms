import React, { useEffect, useId, useState } from 'react';
import { Button } from 'talisman-cms/ui/components/ui/button';
import { MediaFieldInput } from 'talisman-cms/ui/components/MediaFieldInput';
import type { AdminEditorPanelProps } from 'talisman-cms/ui/components/editor/panels';
import {
  describeRequestError,
  EditorRequestError,
  isStaleEditError,
  requestEditorApi,
} from 'talisman-cms/ui/lib/entry-editor-data';
import { describeCommerceEntry, formatMoney, getEntryData } from './commerce-models';
import { storeCurrency } from './currency';
import { loadProductRows, type ProductRows } from './product-rows';
import { describeVariantChangeFailure, getVariantChangeRecovery } from './variant-recovery';

// The product editor's Options & stock panel (Plugin.adminEditorPanels, after the form): the variant
// groups, their values with stock, the option definitions and a storefront preview of the result.
// The panel reads its own rows, scoped to the product (product-rows.ts), and reads them again after
// each change it saves. Groups and definitions are written through the generic collections API;
// values with their stock rows, and deletes, go to the plugin's variants endpoint, which applies
// each change in one batch.

/** The native row's updatedAt as loaded, sent back so the server can refuse stale writes. */
function getLoadedUpdatedAt(entry: any) {
  const updatedAt = getEntryData(entry)?.updatedAt;
  return typeof updatedAt === 'string' || typeof updatedAt === 'number' ? updatedAt : null;
}

function definitionTitle(definition: any, rows: ProductRows) {
  return describeCommerceEntry('_ecommerce_variants', definition, rows)?.title ?? definition.id;
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

/** The drafts of the product's saved groups, with their values and stock, from the rows loaded for the product. */
function buildProductVariantDrafts(rows: ProductRows): ProductVariantGroupDraft[] {
  const stocksByValueId = new Map<string, any>();
  for (const stockEntry of rows._ecommerce_stocks || []) {
    const stockData = getEntryData(stockEntry);
    if (stockData.productVariantValueId) {
      stocksByValueId.set(stockData.productVariantValueId, stockEntry);
    }
  }

  const valuesByGroupId = new Map<string, ProductVariantValueDraft[]>();
  for (const valueEntry of rows._ecommerce_product_variant_values || []) {
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

  // The groups were read by the product's id, so every one of them belongs to this product.
  return (rows._ecommerce_product_variants || [])
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
  rows: ProductRows
): PreviewVariantGroup[] {
  const basePrice = typeof productValues.basePrice === 'number' ? productValues.basePrice : 0;
  const definitionsById = new Map(
    (rows._ecommerce_variants || []).map((entry) => [entry.id, entry])
  );

  return draftGroups.map((group) => {
    const definition = group.variantId ? definitionsById.get(group.variantId) : null;
    const label = definition ? definitionTitle(definition, rows) : (group.name || 'Option group');

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
  rows,
}: {
  productValues: Record<string, any>;
  draftGroups: ProductVariantGroupDraft[];
  rows: ProductRows;
}) {
  const imageUrls = getProductImageUrls(productValues);
  const variantGroups = buildPreviewVariantGroups(productValues, draftGroups, rows);
  const defaultVariant = variantGroups
    .flatMap((group) => group.values.map((value) => ({ ...value, groupLabel: group.label })))
    .find((value) => value.quantity > 0) || null;
  const previewImageUrl = defaultVariant?.imageUrl ?? getProductPrimaryImageUrl(productValues);
  const inventory = typeof productValues.inventoryQuantity === 'number' ? productValues.inventoryQuantity : 0;
  const priceCents = defaultVariant?.priceCents ?? (typeof productValues.basePrice === 'number' ? productValues.basePrice : 0);
  const currency = storeCurrency();
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
                              {isDefault && <span className="sr-only"> (default)</span>}
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
  rows,
  basePath,
  onRefresh,
  productValues,
}: {
  productId: string | null;
  /** The product's rows as last loaded (product-rows.ts); the drafts are rebuilt from every new value. */
  rows: ProductRows;
  basePath: string;
  /** Reads the product's rows again and replaces `rows`; rejects when a read is refused. */
  onRefresh: () => Promise<void>;
  productValues: Record<string, any>;
}) {
  const [draftGroups, setDraftGroups] = useState<ProductVariantGroupDraft[]>([]);
  const [newDefinitionName, setNewDefinitionName] = useState('');
  const [localError, setLocalError] = useState('');
  const [localStatus, setLocalStatus] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [hasStaleRows, setHasStaleRows] = useState(false);
  // The input a required-field message is about, so it reports the error itself.
  const [errorField, setErrorField] = useState<string | null>(null);
  // Focus moves here after a card or the "Load latest" button has gone with the change it made.
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null);
  const idPrefix = useId();
  const controlId = (...parts: string[]) => [idPrefix, ...parts].join('-');
  const fieldErrorProps = (fieldId: string) => ({
    'aria-invalid': errorField === fieldId || undefined,
    'aria-describedby': errorField === fieldId ? controlId('error') : undefined,
  });

  useEffect(() => {
    if (focusTarget) document.getElementById(focusTarget.id)?.focus();
  }, [focusTarget]);

  useEffect(() => {
    if (!productId) {
      setDraftGroups([]);
      return;
    }

    setDraftGroups(buildProductVariantDrafts(rows));
  }, [productId, rows]);

  const variantDefinitions = rows._ecommerce_variants || [];

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

  // A required-field message: the field reports it and takes focus.
  const showFieldError = (fieldId: string, message: string) => {
    setLocalError(message);
    setErrorField(fieldId);
    document.getElementById(fieldId)?.focus();
  };

  const loadLatestRows = async () => {
    if (busyKey === 'refresh') return;
    setBusyKey('refresh');
    setLocalError('');
    setErrorField(null);
    const loadError = await reloadRows();
    if (loadError) setLocalError(`${describeRequestError(loadError).replace(/\.?$/, '.')} Your edits are still here.`);
    else setLocalStatus('Loaded the latest options and stock.');
    setBusyKey(null);
    // The button sat in the error box, which has changed or gone; the outcome takes focus.
    setFocusTarget({ id: controlId(loadError ? 'error' : 'status') });
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
    setErrorField(null);
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
      return false;
    }
    setLocalStatus(messages.done);
    if (await reloadRows()) {
      setLocalError('The change is saved, but the saved options and stock could not be loaded again. Load them before creating another value.');
    }
    setBusyKey(null);
    return true;
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
    if (busyKey === 'definition') return;
    const trimmedName = newDefinitionName.trim();
    if (!trimmedName) {
      showFieldError(controlId('new-definition'), 'Option definition name is required.');
      return;
    }

    setBusyKey('definition');
    setLocalError('');
    setErrorField(null);
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
    if (busyKey === `group:${group.localId}`) return;
    if (!productId) {
      setLocalError('Save the product first so variant groups can attach to it.');
      return;
    }

    if (!group.name.trim()) {
      showFieldError(controlId(group.localId, 'name'), 'Variant group name is required.');
      return;
    }

    setBusyKey(`group:${group.localId}`);
    setLocalError('');
    setErrorField(null);
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
    if (busyKey === `value:${value.localId}`) return;
    if (!group.id) {
      setLocalError('Save the variant group before adding values.');
      return;
    }

    if (!value.value.trim()) {
      showFieldError(controlId(value.localId, 'label'), 'Variant value label is required.');
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
    if (busyKey === `delete-value:${value.localId}`) return;
    if (!value.id) {
      setDraftGroups((current) =>
        current.map((group) =>
          group.localId === groupLocalId
            ? { ...group, values: group.values.filter((candidate) => candidate.localId !== value.localId) }
            : group
        )
      );
      setFocusTarget({ id: controlId(groupLocalId, 'add-value') });
      return;
    }

    if (!window.confirm(`Delete variant value "${value.value || value.id}" with its stock row and variant component rows?`)) {
      return;
    }

    const deleted = await sendVariantChange(`delete-value:${value.localId}`, { action: 'deleteValue', valueId: value.id },
      { failed: 'Failed to delete the variant value', done: `Deleted variant value "${value.value || value.id}".` });
    // The card went with the value; focus moves to the group's Add Value button.
    if (deleted) setFocusTarget({ id: controlId(groupLocalId, 'add-value') });
  };

  const deleteGroup = async (group: ProductVariantGroupDraft) => {
    if (busyKey === `delete-group:${group.localId}`) return;
    if (!group.id) {
      setDraftGroups((current) => current.filter((candidate) => candidate.localId !== group.localId));
      setFocusTarget({ id: controlId('add-group') });
      return;
    }

    if (!window.confirm(`Delete variant group "${group.name || group.id}" and all its values, with their stock rows and variant component rows?`)) {
      return;
    }

    const deleted = await sendVariantChange(`delete-group:${group.localId}`, { action: 'deleteGroup', groupId: group.id },
      { failed: 'Failed to delete the variant group', done: `Deleted variant group "${group.name || group.id}".` });
    // The card went with the group; focus moves to the Add Variant Group button.
    if (deleted) setFocusTarget({ id: controlId('add-group') });
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
        <Button id={controlId('add-group')} type="button" variant="outline" onClick={addGroupDraft}>
          Add Variant Group
        </Button>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/20 p-4">
        <h3 className="text-sm font-medium text-zinc-100">Option Definitions</h3>
        <p className="mt-1 text-xs text-zinc-400">Create reusable option families like Size, Color, or Material.</p>
        <div className="mt-4 flex flex-col gap-3 md:flex-row">
          <label htmlFor={controlId('new-definition')} className="sr-only">New option definition name</label>
          <input
            id={controlId('new-definition')}
            type="text"
            value={newDefinitionName}
            onChange={(event) => setNewDefinitionName(event.target.value)}
            placeholder="e.g. Size"
            {...fieldErrorProps(controlId('new-definition'))}
            className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
          />
          <Button type="button" onClick={() => void saveDefinition()} aria-disabled={busyKey === 'definition' || undefined} aria-busy={busyKey === 'definition' || undefined}>
            {busyKey === 'definition' ? 'Creating...' : 'Create Definition'}
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {variantDefinitions.length === 0 ? (
            <span className="text-xs text-zinc-500">No option definitions yet.</span>
          ) : (
            variantDefinitions.map((definition) => (
              <span key={definition.id} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-zinc-200">
                {definitionTitle(definition, rows)}
              </span>
            ))
          )}
        </div>
      </div>

      {localError && (
        <div id={controlId('error')} role="alert" tabIndex={-1} className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200 focus:outline-none">
          <p>{localError}</p>
          {hasStaleRows && (
            <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void loadLatestRows()} aria-disabled={busyKey === 'refresh' || undefined} aria-busy={busyKey === 'refresh' || undefined}>
              {busyKey === 'refresh' ? 'Loading...' : 'Load latest options and stock'}
            </Button>
          )}
        </div>
      )}
      {/* Kept mounted so screen readers hear each outcome; empty, it takes no space. */}
      <div id={controlId('status')} role="status" tabIndex={-1} className={localStatus ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 focus:outline-none' : 'sr-only'}>{localStatus}</div>

      <ProductStorefrontPreview
        productValues={productValues}
        draftGroups={draftGroups}
        rows={rows}
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
                <h3>
                  <span className="block text-xs uppercase tracking-[0.2em] text-emerald-100/60">Variant Group {index + 1}</span>
                  <span className="mt-1 block text-base font-medium text-white">{group.name || 'Untitled variant group'}</span>
                </h3>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => void saveGroup(group)} aria-disabled={busyKey === `group:${group.localId}` || undefined} aria-busy={busyKey === `group:${group.localId}` || undefined}>
                    {busyKey === `group:${group.localId}` ? 'Saving...' : group.id ? 'Save Group' : 'Create Group'}
                  </Button>
                  <Button type="button" variant="destructive" aria-label={`Delete variant group ${group.name || index + 1}`} onClick={() => void deleteGroup(group)} aria-disabled={busyKey === `delete-group:${group.localId}` || undefined} aria-busy={busyKey === `delete-group:${group.localId}` || undefined}>
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
                        {definitionTitle(definition, rows)}
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
                    {...fieldErrorProps(controlId(group.localId, 'name'))}
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
                    <h4 className="text-sm font-medium text-zinc-100">Variant Values</h4>
                    <p className="mt-1 text-xs text-zinc-400">These are the shopper-selectable options tied to this group.</p>
                  </div>
                  <Button id={controlId(group.localId, 'add-value')} type="button" variant="outline" onClick={() => addValueDraft(group.localId)} disabled={!group.id}>
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
                            <Button type="button" variant="outline" onClick={() => void saveValue(group, value)} disabled={!group.id} aria-disabled={busyKey === `value:${value.localId}` || undefined} aria-busy={busyKey === `value:${value.localId}` || undefined}>
                              {busyKey === `value:${value.localId}` ? 'Saving...' : value.id ? 'Save Value' : 'Create Value'}
                            </Button>
                            <Button type="button" variant="destructive" aria-label={`Delete variant value ${value.value || 'Untitled value'}`} onClick={() => void deleteValue(group.localId, value)} aria-disabled={busyKey === `delete-value:${value.localId}` || undefined} aria-busy={busyKey === `delete-value:${value.localId}` || undefined}>
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
                              {...fieldErrorProps(controlId(value.localId, 'label'))}
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
                              label={`Variant Image of ${value.value || 'Untitled value'}`}
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

/** The rows shown, with the product they were read for; a read for another product is not shown. */
type LoadedProductRows = { productId: string; rows: ProductRows };

/**
 * Products get this panel below the form. It reads the product's own rows (product-rows.ts) rather
 * than the whole variant, value and stock tables; the editor's relationSupportEntries hold the form's
 * relation targets and are not needed here. A new product, without an id yet, gets only the
 * definition tables. A refused read shows as an error, never as an empty product.
 */
export default function ProductOptionsPanel({ entry, values, basePath }: AdminEditorPanelProps) {
  const productId = entry?.id || '';
  const [loaded, setLoaded] = useState<LoadedProductRows | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    loadProductRows(basePath, productId).then(
      (rows) => { if (!cancelled) setLoaded({ productId, rows }); },
      (error) => { if (!cancelled) setLoadError(describeRequestError(error)); }
    );
    return () => {
      cancelled = true;
    };
  }, [basePath, productId]);

  // After a change: the rows are read again and replace the shown ones, as long as the panel still
  // shows this product. A refused read rejects, and the configurator reports it and keeps its rows.
  const refreshRows = async () => {
    const rows = await loadProductRows(basePath, productId);
    setLoaded((current) => (current?.productId === productId ? { productId, rows } : current));
  };

  const rows = loaded && loaded.productId === productId ? loaded.rows : null;
  if (!rows) {
    return loadError
      ? <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{loadError}</p>
      : <p className="text-sm text-zinc-400">Loading options and stock...</p>;
  }

  return (
    <ProductVariantConfigurator
      productId={productId || null}
      rows={rows}
      basePath={basePath}
      onRefresh={refreshRows}
      productValues={values}
    />
  );
}
