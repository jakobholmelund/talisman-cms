import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, useBlocker } from '@tanstack/react-router';
import { buildVariantPreview } from './variant-preview';
import { reconcileVariantDrafts, variantDraftsChanged, type SavedVariantDraft } from './variant-drafts';
import './commerce-admin.css';
import ProductChoiceSetup from './ProductChoiceSetup';
import ProductVariantList from './ProductVariantList';
import ProductPriceInput from './ProductPriceInput';
import StockMovements from './StockMovements';
import type {StockTarget} from './stock-target';
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
  if (!value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function formatPreviewPrice(amount: number | null | undefined, currency: string) {
  return typeof amount === 'number' && amount > 0 ? formatMoney(amount, currency) ?? 'Price unavailable' : 'Price unavailable';
}

/** Keep a row open across saves and refreshes; validation can reveal it without later closing it. */
function ProductDisclosure({reveal,children,...props}:{reveal:boolean;children:React.ReactNode;className:string;hidden?:boolean}) {
  const [open,setOpen]=useState(reveal);
  useEffect(()=>{if(reveal)setOpen(true);},[reveal]);
  return <details {...props} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>{children}</details>;
}

function ProductStorefrontPreview({ productValues, draftGroups, rows }: { productValues: Record<string, any>; draftGroups: ProductVariantGroupDraft[]; rows: ProductRows }) {
  const preview = buildVariantPreview(productValues, draftGroups, rows);
  const [choiceId, setChoiceId] = useState('');
  const selected = preview.choices.find(choice => choice.id === choiceId) ?? preview.selected;
  const image = selected.imageUrl || (Array.isArray(productValues.images) ? productValues.images.map((image: any) => typeof image === 'string' ? image : image?.url).find(Boolean) : null);
  return <section aria-label="Product preview" className="ecom-product-preview">
    <div className="ecom-product-preview__image">{image ? <img src={image} alt={productValues.name || 'Product'} loading="lazy" /> : <span>No product image</span>}</div>
    <div><h3 className="text-xs uppercase tracking-wider text-zinc-400">Storefront Preview</h3><h4 className="mt-3 text-2xl font-semibold text-white">{productValues.name || 'Untitled product'}</h4>
      <p className="my-3 text-xl text-white">{formatPreviewPrice(selected.priceCents, storeCurrency())}</p>
      <p className="text-sm leading-relaxed text-zinc-400">{productValues.description || 'Add a description to help shoppers choose.'}</p>
      {preview.groups.map(group => <div key={group.id} className="mt-4"><p className="mb-2 text-xs text-zinc-400">{group.label}</p><div className="flex flex-wrap gap-2">{group.values.map(value => <button key={value.id} type="button" onClick={() => setChoiceId(value.id)} aria-pressed={selected.id === value.id} className="ecom-product-preview__choice">{value.label}</button>)}</div></div>)}
      <p className="mt-4 text-sm text-zinc-300" role="status">{preview.available(selected) ? selected.quantity === null ? 'Available · no stock tracking' : `${selected.quantity} available · ${selected.stockSource.toLowerCase()}` : 'Currently unavailable'}</p>
      <p className="mt-2 text-xs text-zinc-500">{productValues.status === 'active' ? 'Active product.' : 'This product is not visible in the store.'} This preview includes your unsaved edits. Checkout verifies stock again.</p>
    </div>
  </section>;
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
  const [setupDirty,setSetupDirty] = useState(false);
  const [showSetup,setShowSetup] = useState(!(rows._ecommerce_product_variants || []).length);
  const [liveProductStock,setLiveProductStock] = useState<number|null>(null);
  const [stockDirty,setStockDirty] = useState(false);
  const [stockTarget,setStockTarget] = useState<StockTarget|null>(null);
  const [managementDirty,setManagementDirty] = useState(false);
  const [savedValueId,setSavedValueId] = useState<string|null>(null);
  const openStock = (target:StockTarget) => { if(stockDirty){setLocalError('Save or discard the current stock change before choosing another variant.');return;} setStockTarget(target); };
  const [draftGroups, setDraftGroups] = useState<ProductVariantGroupDraft[]>([]);
  const [newDefinitionName, setNewDefinitionName] = useState('');
  const [localError, setLocalError] = useState('');
  const [localStatus, setLocalStatus] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [hasStaleRows, setHasStaleRows] = useState(false);
  const baseline = useRef<ProductVariantGroupDraft[]>([]);
  const committed = useRef<SavedVariantDraft>(null);
  const writing = useRef(false);
  const dirty = setupDirty || stockDirty || managementDirty || variantDraftsChanged(baseline.current, draftGroups) || Boolean(newDefinitionName.trim());
  useBlocker({ shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname && (dirty || writing.current)
    && !window.confirm('You have unsaved changes in this section. Leave this product and discard them?'), enableBeforeUnload: () => dirty || writing.current });
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

    const fresh = buildProductVariantDrafts(rows);
    const previous = baseline.current;
    const saved = committed.current;
    committed.current = null;
    baseline.current = fresh;
    setDraftGroups(current => reconcileVariantDrafts(previous, current, fresh, saved));
  }, [productId, rows]);

  const variantDefinitions = rows._ecommerce_variants || [];
  const currentProduct = liveProductStock === null ? productValues : {...productValues,inventoryQuantity:liveProductStock};
  const preview = buildVariantPreview(currentProduct, draftGroups, rows);

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
  const reloadRows = async (saved: SavedVariantDraft = null): Promise<Error | null> => {
    committed.current = saved;
    try {
      await onRefresh();
      setHasStaleRows(false);
      return null;
    } catch (error) {
      committed.current = null;
      setHasStaleRows(true);
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  // A required-field message: the field reports it and takes focus.
  const showFieldError = (fieldId: string, message: string) => {
    setLocalError(message);
    setErrorField(fieldId);
    requestAnimationFrame(()=>{const control=document.getElementById(fieldId);let parent=control?.parentElement;while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}control?.focus();});
  };

  const loadLatestRows = async () => {
    if (writing.current || stockDirty) return;
    if (dirty && !window.confirm('Replace your unsaved option edits with the latest saved options and stock?')) return;
    writing.current = true;
    setBusyKey('refresh');
    setLocalError('');
    setErrorField(null);
    const loadError = await reloadRows('all');
    if (loadError) setLocalError(`${describeRequestError(loadError).replace(/\.?$/, '.')} Your edits are still here.`);
    else setLocalStatus('Loaded the latest options and stock.');
    writing.current = false; setBusyKey(null);
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
    if (writing.current) return false;
    writing.current = true;
    setBusyKey(key);
    setLocalError('');
    setErrorField(null);
    setLocalStatus('');
    try {
      const response = await requestEditorApi(`${basePath}/api/ecommerce/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      }, messages.failed);
      if(change.action==='saveValue'&&typeof response?.result?.value?.id==='string')setSavedValueId(response.result.value.id);
    } catch (error) {
      const failure = error instanceof EditorRequestError ? error : new EditorRequestError(describeRequestError(error), 0);
      if (getVariantChangeRecovery(failure) === 'keep') {
        // Includes an expired session: the edits wait until the admin has signed in again.
        showRequestError(failure);
      } else {
        const loadError = await reloadRows({ kind: change.action === 'deleteGroup' ? 'group' : 'value', localId: key.slice(key.indexOf(':') + 1) });
        setLocalError(describeVariantChangeFailure(failure, messages.failed, !loadError));
      }
      writing.current = false; setBusyKey(null);
      return false;
    }
    if (await reloadRows({ kind: change.action === 'deleteGroup' ? 'group' : 'value', localId: key.slice(key.indexOf(':') + 1) })) {
      setLocalError('The change is saved, but the saved options and stock could not be loaded again. Load them before creating another value.');
    }
    setLocalStatus(messages.done);
    writing.current = false; setBusyKey(null);
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
    const localId = createDraftId('group');
    setDraftGroups((current) => [
      ...current,
      {
        localId,
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
    setFocusTarget({ id: controlId(localId, 'name') });
  };

  const addValueDraft = (groupLocalId: string) => {
    const localId = createDraftId('value');
    setDraftGroups((current) =>
      current.map((group) =>
        group.localId === groupLocalId
          ? {
              ...group,
              values: [
                ...group.values,
                {
                  localId,
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
    setFocusTarget({ id: controlId(localId, 'label') });
  };

  const saveDefinition = async () => {
    if (writing.current || stockDirty) return;
    const trimmedName = newDefinitionName.trim();
    if (!trimmedName) {
      showFieldError(controlId('new-definition'), 'Option definition name is required.');
      return;
    }

    writing.current = true;
    setBusyKey('definition');
    setLocalError('');
    setErrorField(null);
    setLocalStatus('');

    try {
      await requestCollection('_ecommerce_variants', 'POST', { data: { name: trimmedName } });
      setNewDefinitionName('');
      if (await reloadRows()) setLocalError('The definition was created, but options could not refresh. Load the latest options before continuing.');
      setLocalStatus(`Created option definition "${trimmedName}".`);
    } catch (error) {
      showRequestError(error);
    } finally {
      writing.current = false; setBusyKey(null);
    }
  };

  const saveGroup = async (group: ProductVariantGroupDraft) => {
    if (writing.current || stockDirty) return;
    if (!productId) {
      setLocalError('Save the product first so variant groups can attach to it.');
      return;
    }

    if (!group.id && hasStaleRows) { setLocalError('Load the latest options before creating another group.'); return; }

    if (!group.name.trim()) {
      showFieldError(controlId(group.localId, 'name'), 'Variant group name is required.');
      return;
    }

    if (group.priceOverride && (!Number.isSafeInteger(Number(group.priceOverride)) || Number(group.priceOverride)<=0)) { showFieldError(controlId(group.localId, 'price'), 'Enter a positive price with the correct currency decimals, or leave it blank to use the product price.'); return; }
    writing.current = true;
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
      if (await reloadRows({ kind: 'group', localId: group.localId })) setLocalError('The group was saved, but options could not refresh. Load the latest options before continuing.');
      setLocalStatus(`Saved variant group "${group.name.trim()}".`);
    } catch (error) {
      showRequestError(error);
    } finally {
      writing.current = false; setBusyKey(null);
    }
  };

  const saveValue = async (group: ProductVariantGroupDraft, value: ProductVariantValueDraft) => {
    if (writing.current || stockDirty) return;
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

    if (value.priceOverride && (!Number.isSafeInteger(Number(value.priceOverride)) || Number(value.priceOverride)<=0)) { showFieldError(controlId(value.localId, 'price'), 'Enter a positive price with the correct currency decimals, or leave it blank to use the default.'); return; }
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
    if (writing.current || stockDirty) return;
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
    if (writing.current || stockDirty) return;
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
      <div id="commerce-product-options" className="rounded-xl border border-white/10 p-5 scroll-mt-24">
        <div className="text-sm font-semibold text-amber-100">Next: sizes, colours and stock</div>
        <p className="mt-2 text-sm leading-relaxed text-amber-50/80">
          Create your product above to continue. Then choose its sizes and colours, assign photos and enter starting stock together.
        </p>
      </div>
    );
  }

  return (
    <fieldset id="commerce-product-options" disabled={Boolean(busyKey)} aria-busy={Boolean(busyKey)} className="ecom-product-options min-w-0 space-y-6 rounded-2xl border border-white/10 bg-zinc-950/40 p-5 scroll-mt-24">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Variants &amp; inventory</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-300">
            Set up the choices shoppers can make and the stock available for each one.
          </p>
        </div>

      </div>

      <p className="text-xs text-zinc-400">{dirty ? <strong className="text-amber-200">You have unsaved changes in this section.</strong> : 'Your variant changes are saved.'} <Link to="/extensions/commerce-stock" className="text-indigo-300 underline">Receive or adjust inventory →</Link></p>
      <details className="ecom-product-setup-disclosure" open={showSetup} onToggle={event=>setShowSetup(event.currentTarget.open)}><summary>{draftGroups.length ? "Add a separate option set" : "Add choices or combinations"}</summary><ProductChoiceSetup productId={productId} basePath={basePath} refresh={onRefresh} changed={setSetupDirty} productStatus={productValues.status} onNoVariants={!draftGroups.length?()=>{setShowSetup(false);setSetupDirty(false);openStock({type:'product',id:productId});}:undefined} productPrice={productValues.basePrice} productImages={(productValues.images||[]).map((image:any)=>typeof image==='string'?image:image?.url).filter(Boolean)} onContinue={()=>{setShowSetup(false);requestAnimationFrame(()=>{const list=document.getElementById('commerce-product-variant-list');list?.focus();list?.scrollIntoView({block:'start'});});}}/></details>
      {(!showSetup||!!draftGroups.length)&&<div className="ecom-product-overview"><div><small>Sellable choices</small><strong>{preview.choices.length}</strong></div><div><small>Available choices</small><strong>{preview.choices.filter(preview.available).length}</strong></div><div><small>Product price</small><strong>{formatPreviewPrice(productValues.basePrice,storeCurrency())}</strong></div></div>}
      {!showSetup&&!draftGroups.length && <div className="ecom-product-single-stock"><p>This product sells without options. Its inventory belongs to the product.</p><Button type="button" variant="outline" onClick={()=>openStock({type:'product',id:productId})}>Manage product inventory</Button></div>}
      {stockTarget && <section className="ecom-admin ecom-product-inline-stock" aria-label="Product inventory"><header><h3>Inventory for this choice</h3><Button type="button" variant="outline" disabled={stockDirty} onClick={()=>setStockTarget(null)}>Close inventory</Button></header><StockMovements target={stockTarget} scoped stockLoaded={location=>{if(location.type==='product')setLiveProductStock(location.quantity);}} refreshOverview={onRefresh} draftChanged={setStockDirty}/></section>}


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



      {draftGroups.length === 0 ? (showSetup?null:
        <div className="rounded-xl border border-dashed border-white/10 bg-black/10 p-6 text-sm text-zinc-400">
          No options needed? You’re all set. Add choices above only when shoppers need to choose a variant.
        </div>
      ) : (
        <div id="commerce-product-variant-list" tabIndex={-1} className="space-y-5 scroll-mt-24">
          {draftGroups.map((group, index) => (
            <div key={group.localId} className="ecom-product-group rounded-xl border border-white/10 bg-black/20 p-5 space-y-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <h3>
                  <span className="block text-xs uppercase tracking-[0.2em] text-emerald-100/60">Option set {index + 1}</span>
                  <span className="mt-1 block text-base font-medium text-white">{group.name || 'Name your option'}</span>
                </h3>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => void saveGroup(group)} aria-disabled={busyKey === `group:${group.localId}` || undefined} aria-busy={busyKey === `group:${group.localId}` || undefined}>
                    {busyKey === `group:${group.localId}` ? 'Saving...' : group.id ? 'Save option set' : 'Create option set'}
                  </Button>
                  <Button type="button" variant="ghost" className="text-red-300" aria-label={`Delete variant group ${group.name || index + 1}`} onClick={() => void deleteGroup(group)} aria-disabled={busyKey === `delete-group:${group.localId}` || undefined} aria-busy={busyKey === `delete-group:${group.localId}` || undefined}>
                    Delete
                  </Button>
                </div>
              </div>

              <ProductDisclosure className="ecom-option-settings" reveal={!group.id||!!errorField?.startsWith(controlId(group.localId))}><summary>Option name & defaults</summary><div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor={controlId(group.localId, 'definition')} className="text-sm font-medium text-zinc-300">Reusable label (optional)</label>
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
                  <label htmlFor={controlId(group.localId, 'name')} className="text-sm font-medium text-zinc-300">Option name</label>
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
                  <label htmlFor={controlId(group.localId, 'sku')} className="text-sm font-medium text-zinc-300">Default SKU (optional)</label>
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
                  <label htmlFor={controlId(group.localId, 'price')} className="text-sm font-medium text-zinc-300">Default price ({storeCurrency().toUpperCase()})</label>
                  <ProductPriceInput id={controlId(group.localId, 'price')} value={group.priceOverride} onChange={next=>updateGroupDraft(group.localId, {priceOverride:next})} placeholder={formatPreviewPrice(productValues.basePrice,storeCurrency())} {...fieldErrorProps(controlId(group.localId,'price'))}/>
                </div>
                {group.values.length===0 && <p className="text-xs text-zinc-400">This option currently sells as one choice. Available: {group.inventoryQuantity}. <button type="button" onClick={()=>group.id&&openStock({type:'variant',id:group.id})}>Manage inventory</button></p>}
              </div></ProductDisclosure>

              <div className="ecom-product-variants space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h4 className="text-sm font-medium text-zinc-100">Your sellable variants</h4>
                    <p className="mt-1 text-xs text-zinc-400">Each row is one choice shoppers can buy. Open a row to change its details.</p>
                  </div>
                  <Button id={controlId(group.localId, 'add-value')} type="button" variant="outline" onClick={() => addValueDraft(group.localId)} disabled={!group.id}>
                    Add a choice
                  </Button>
                </div>

                {!group.id && (
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-100">
                    Create this option set first, then add its choices. Use the quick setup above to create everything together.
                  </div>
                )}

                {group.values.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/10 bg-black/10 p-4 text-sm text-zinc-500">
                    No values configured yet.
                  </div>
                ) : (
                  <ProductVariantList values={group.values.map(value=>({...value,quantity:preview.choices.find(choice=>choice.id===value.localId)?.quantity??null,stockSource:preview.choices.find(choice=>choice.id===value.localId)?.stockSource||''}))} group={group.id && group.updatedAt ? {id:group.id,name:group.name,updatedAt:group.updatedAt,values:group.values}:undefined} productId={productId} productImages={(productValues.images||[]).map((image:any)=>typeof image==='string'?image:image?.url).filter(Boolean)} productPrice={Number(group.priceOverride)||productValues.basePrice} productStatus={productValues.status} basePath={basePath} refresh={onRefresh} changed={setManagementDirty} blocked={setupDirty||stockDirty||managementDirty||!!busyKey||variantDraftsChanged(baseline.current,draftGroups)}>
                    {(value) => {
                      const choice = preview.choices.find(choice => choice.id === value.localId)!;
                      return (
                      <ProductDisclosure key={value.localId} reveal={!value.id||value.id===savedValueId||!!errorField?.startsWith(controlId(value.localId))} className="ecom-product-option ecom-variant-row rounded-lg border border-white/10 bg-black/20 p-4 space-y-4">
                        <summary className="ecom-variant-row__summary">{(value.image||(typeof productValues.images?.[0]==='string'?productValues.images[0]:productValues.images?.[0]?.url))?<img src={value.image||(typeof productValues.images?.[0]==='string'?productValues.images[0]:productValues.images[0].url)} alt=""/>:<span className="ecom-variant-row__image" aria-hidden="true">↳</span>}<span className="ecom-variant-row__identity"><strong>{value.value||'New choice'}</strong><small>{value.image?'Own image':'Uses product image'} · {value.sku||group.sku||productValues.sku||'No SKU'}</small></span><span className="ecom-variant-row__price"><strong>{formatPreviewPrice(choice.priceCents,storeCurrency())}</strong><small>{value.priceOverride?'Custom price':'Default price'}</small></span><span className="ecom-variant-row__stock"><strong>{choice.quantity===null?'Not tracked':`${choice.quantity} available`}</strong><small>{choice.stockSource==='Shared components'?'From shared parts':'Inventory'}</small></span><span aria-hidden="true">⌄</span></summary>
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div>
                            <div className="text-sm font-medium text-white">{value.value || 'Untitled value'}</div>
                            <p className="mt-1 text-xs text-zinc-400">{value.sku || 'No SKU'} · {formatPreviewPrice(toRequiredNumber(value.priceOverride, toOptionalNumber(group.priceOverride) ?? productValues.basePrice ?? 0), storeCurrency())}{value.priceOverride.trim() ? ' override' : ' inherited price'}</p>
                          </div>
                          <div className="flex gap-2">
                            <Button type="button" variant="outline" onClick={() => void saveValue(group, value)} disabled={!group.id} aria-disabled={busyKey === `value:${value.localId}` || undefined} aria-busy={busyKey === `value:${value.localId}` || undefined}>
                              {busyKey === `value:${value.localId}` ? 'Saving...' : value.id ? 'Save variant' : 'Create variant'}
                            </Button>
                            <Button type="button" variant="ghost" className="text-red-300" aria-label={`Delete variant value ${value.value || 'Untitled value'}`} onClick={() => void deleteValue(group.localId, value)} aria-disabled={busyKey === `delete-value:${value.localId}` || undefined} aria-busy={busyKey === `delete-value:${value.localId}` || undefined}>
                              Delete
                            </Button>
                          </div>
                        </div>

                        <div className="ecom-product-option-fields grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'label')} className="text-sm font-medium text-zinc-300">Choice name</label>
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
                            <label htmlFor={controlId(value.localId, 'sku')} className="text-sm font-medium text-zinc-300">SKU (optional)</label>
                            <input
                              id={controlId(value.localId, 'sku')}
                              type="text"
                              value={value.sku}
                              onChange={(event) => updateValueDraft(group.localId, value.localId, { sku: event.target.value })}
                              placeholder="Optional"
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                          </div>
                          <details className="ecom-product-option-image space-y-2"><summary className="cursor-pointer text-sm font-medium text-zinc-300">Variant image {value.image ? '· custom image' : '· uses product image'}</summary><p className="text-xs text-zinc-400">Choose an image only when this variant looks different. Leave it empty to use the product’s main image.</p>
                            {value.image && <Button type="button" variant="outline" onClick={()=>updateValueDraft(group.localId,value.localId,{image:''})}>Use product image</Button>}
                            <MediaFieldInput pickerOnly
                              label={`Variant Image of ${value.value || 'Untitled value'}`}
                              adminBasePath={basePath}
                              value={value.image}
                              onChange={(nextValue) => updateValueDraft(group.localId, value.localId, { image: nextValue })}
                              placeholder="Uses the product image"
                            />
                          </details>
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'price')} className="text-sm font-medium text-zinc-300">Price ({storeCurrency().toUpperCase()})</label>
                            <ProductPriceInput id={controlId(value.localId, 'price')} value={value.priceOverride} onChange={next=>updateValueDraft(group.localId, value.localId, {priceOverride:next})} placeholder={formatPreviewPrice(toOptionalNumber(group.priceOverride) ?? productValues.basePrice,storeCurrency())} {...fieldErrorProps(controlId(value.localId,'price'))}/>
                          </div>
                          <div className="space-y-2">
                            <label htmlFor={controlId(value.localId, 'stock')} className="text-sm font-medium text-zinc-300">Stock Quantity</label>
                            <input
                              id={controlId(value.localId, 'stock')}
                              type="text"
                              value={choice.quantity ?? 'Not tracked'}
                              disabled readOnly
                              className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
                            />
                            {choice.quantity !== null && <p className="text-xs text-zinc-400">{choice.stockSource}</p>}
                            {value.id && choice.quantity !== null && (choice.stockSource === 'Shared components' ? <Link to="/extensions/commerce-stock" className="block text-xs text-indigo-300 underline">Manage shared components →</Link> : <Button type="button" variant="outline" onClick={()=>openStock({type:value.stockId?'stock':'variant',id:value.stockId||group.id!})}>Manage inventory</Button>)}
                          </div>
                        </div>
                      </ProductDisclosure>
                    ); }}
                  </ProductVariantList>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <details className="rounded-xl border border-white/10 bg-black/20 p-4">
        <summary className="cursor-pointer text-sm font-medium text-zinc-100">Advanced option setup</summary>
        <Button id={controlId('add-group')} type="button" variant="outline" onClick={addGroupDraft}>
          Add option set manually
        </Button>
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
      </details>
      <details id="commerce-product-preview" className="scroll-mt-24 rounded-xl border border-white/10 p-4"><summary className="cursor-pointer text-sm font-semibold text-zinc-200">Storefront Preview</summary><div className="mt-4">      <ProductStorefrontPreview
        productValues={currentProduct}
        draftGroups={draftGroups}
        rows={rows}
      /></div></details>
    </fieldset>
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
  const [retry, setRetry] = useState(0);
  const anchoredProduct = useRef<string | null>(null);

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
  }, [basePath, productId, retry]);

  // After a change: the rows are read again and replace the shown ones, as long as the panel still
  // shows this product. A refused read rejects, and the configurator reports it and keeps its rows.
  const refreshRows = async () => {
    const rows = await loadProductRows(basePath, productId);
    setLoaded((current) => (current?.productId === productId ? { productId, rows } : current));
  };

  const rows = loaded && loaded.productId === productId ? loaded.rows : null;
  useEffect(() => {
    if (!rows || anchoredProduct.current === productId) return;
    const frame = requestAnimationFrame(() => {
      anchoredProduct.current = productId;
      const anchor = window.location.hash.slice(1);
      if (anchor !== 'commerce-product-options' && anchor !== 'commerce-product-preview') return;
      const target = document.getElementById(anchor);
      if (target instanceof HTMLDetailsElement) target.open = true;
      target?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, productId]);
  if (!rows) {
    return loadError
      ? <div role="alert" className="space-y-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-200"><p>{loadError}</p><Button type="button" variant="outline" onClick={() => setRetry(value => value + 1)}>Retry loading options</Button></div>
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
