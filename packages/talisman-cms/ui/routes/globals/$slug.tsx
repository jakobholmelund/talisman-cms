import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createFileRoute, Link, useBlocker } from '@tanstack/react-router';
import { useForm, useStore } from '@tanstack/react-form';

import { ArrowLeft, Save } from 'lucide-react';
import { AdminBasePathContext, ReadOnlyFieldContext, FieldRenderer, focusFieldControl } from '../../components/fields';
// The loader's helpers come from their own module: importing them through the index would keep the
// field renderer in the eager admin bundle, while the editor below loads with this route's chunk.
import { buildRelationOptions, fieldsNeedPresetEntries, type RelationSupportEntries } from '../../components/fields/relations';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { fetchCollectionConfigs, fetchEntriesBySlug } from '../../lib/admin-api';
import { prepareFieldValuesForSave } from '../../lib/entry-save';
import { compareConflictFields, conflictFieldChanges, conflictSnapshotData, withFieldChanges, type ConflictSnapshot } from '../../lib/revision-comparison';

import {
  buildDefaultValues,
  getZodClientSchemaForFields,
  normalizeStoredFieldData,
} from '../../lib/page-builder';

const ConflictReviewDialog = React.lazy(() => import('../../components/editor/ConflictReviewDialog'));
type GlobalConflict = { original: ConflictSnapshot; mine: ConflictSnapshot; latestLoaded: boolean };
type GlobalReview = { original: ConflictSnapshot; mine: ConflictSnapshot; latest: ConflictSnapshot; editedFields: string[] };


type GlobalRecord = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  data: string | Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
  /** Grows with every save; it goes back as `If-Match` so a save over someone else's is refused. */
  version?: number | null;
};

type FieldErrors = Record<string, string[]>;

const STALE_SAVE_CODE = 'stale_record';
const LATEST_LOADED_MESSAGE = 'The latest saved version is now in the form.';

// A stable empty schema: a fresh [] per render would re-run the reset effect below on every keystroke.
const EMPTY_FIELDS: any[] = [];

function mergeStoredValues(defaults: any, stored: any): any {
  if (Array.isArray(stored)) return stored;
  if (!stored || typeof stored !== 'object') return stored ?? defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return stored;

  const merged: Record<string, any> = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    merged[key] = key in defaults ? mergeStoredValues(defaults[key], value) : value;
  }

  return merged;
}

/** Global data is a JSON object; tolerate rows that still hold it as (doubly) encoded JSON text. */
function decodeGlobalData(data: unknown): Record<string, any> {
  let value = data;
  for (let depth = 0; typeof value === 'string' && depth < 3; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function parseGlobalData(data: GlobalRecord['data'] | undefined, fields?: any[]) {
  return normalizeStoredFieldData(fields, decodeGlobalData(data));
}

function getFieldErrorLabel(fields: any[], name: string) {
  return fields.find((field: any) => field.name === name)?.label || name;
}

function formatFieldErrors(messages: unknown) {
  return Array.isArray(messages) ? messages.join(', ') : String(messages);
}

/** Show (or clear) a server validation message on a configured field. */
function setServerFieldError(formApi: any, name: string, message: string | undefined) {
  formApi.setFieldMeta(name, (meta: any) => ({ ...meta, errorMap: { ...meta?.errorMap, onServer: message } }));
}

export const Route = createFileRoute('/globals/$slug')({
  component: GlobalEditorRoute,
  loader: async ({ params, context }) => {
    const adminBasePath = context.adminBasePath || '/admin';
    const res = await fetch(`${adminBasePath}/api/globals/${params.slug}`);
    if (!res.ok) {
      throw new Error('Failed to fetch global');
    }

    const { globals: configuredGlobals } = await import('virtual:talisman-cms/config');
    const global = await res.json() as GlobalRecord;
    const globalConfig = configuredGlobals.find((candidate) => candidate.slug === params.slug) || null;
    const relationSupportEntries: RelationSupportEntries = {};

    if (globalConfig?.fields?.length) {
      const relationTargets = fieldsNeedPresetEntries(globalConfig.fields) ? ['_ui_component_presets'] : [];

      // Presets support page-builder references; relationship pickers load their own bounded pages.
      if (relationTargets.length > 0) {
        const collections = await fetchCollectionConfigs(adminBasePath).catch(() => [] as any[]);
        Object.assign(relationSupportEntries, await fetchEntriesBySlug(adminBasePath, relationTargets, collections));
      }
    }

    const relationOptions = buildRelationOptions(globalConfig?.fields, relationSupportEntries);

    return {
      adminBasePath,
      global,
      globalConfig,
      relationOptions,
      relationSupportEntries,
    };
  }
});

function GlobalEditorRoute() {
  const {
    adminBasePath,
    global,
    globalConfig,
    relationOptions,
    relationSupportEntries,
  } = Route.useLoaderData();
  const schemaFields = globalConfig?.fields || EMPTY_FIELDS;
  const hasConfiguredFields = schemaFields.length > 0;
  // The last stored record: the loader's copy goes stale after a save, and building the form defaults
  // from it would put the old values back on the next render.
  const [storedGlobal, setStoredGlobal] = useState<GlobalRecord>(global);
  const [initialDefaults] = useState(() => mergeStoredValues(buildDefaultValues(schemaFields), parseGlobalData(global.data, schemaFields)));
  const [rawJsonValue, setRawJsonValue] = useState(() => JSON.stringify(parseGlobalData(global.data, schemaFields), null, 2));
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingLatest, setIsLoadingLatest] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [conflict, setConflict] = useState<GlobalConflict | null>(null);
  const [review, setReview] = useState<GlobalReview | null>(null);
  const activeSlugRef = useRef(global.slug);
  const operationRef = useRef(0);
  activeSlugRef.current = global.slug;
  useEffect(() => () => { operationRef.current++; }, []);
  const collapseStorageKey = `talisman-cms:collapsed:global:${global.slug}`;
  const conflictTitleId = useId();
  // A failed save moves focus to its message, a refused one to the conflict panel; a successful one
  // leaves it on the Save button.
  const saveErrorRef = useRef<HTMLParagraphElement | null>(null);
  const conflictPanelRef = useRef<HTMLDivElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (saveError) saveErrorRef.current?.focus();
  }, [saveError]);
  useEffect(() => {
    if (conflict) conflictPanelRef.current?.focus();
  }, [conflict]);

  const form = useForm({
    defaultValues: initialDefaults,
    validators: hasConfiguredFields
      ? {
          onChange: getZodClientSchemaForFields(schemaFields) as any
        }
      : undefined,
    listeners: {
      // A server error stops applying once its field, or anything inside it, is edited.
      onChange: ({ formApi, fieldApi }: any) => {
        const name = String(fieldApi.name).split(/[.[]/)[0];
        if (formApi.getFieldMeta(name)?.errorMap?.onServer) setServerFieldError(formApi, name, undefined);
        setFieldErrors((current) => {
          if (!(name in current)) return current;
          const { [name]: _fixed, ...rest } = current;
          return rest;
        });
      },
    },
  });

  const savedSnapshotRef = useRef(JSON.stringify(initialDefaults));
  const rawSnapshotRef = useRef(rawJsonValue);
  const formChanged = useStore(form.store, (state: any) => JSON.stringify(state.values) !== savedSnapshotRef.current);
  const conflictHoldsChanges = Boolean(conflict?.latestLoaded && compareConflictFields([], conflict.original, conflict.mine, conflict.original).length);
  const hasUnsavedWork = (hasConfiguredFields ? formChanged : rawJsonValue !== rawSnapshotRef.current) || conflictHoldsChanges;
  const hasUnsavedWorkRef = useRef(hasUnsavedWork);
  hasUnsavedWorkRef.current = hasUnsavedWork;
  const storedSlugRef = useRef(global.slug);
  const shouldBlockNavigation = useCallback(({ current, next }: { current: { pathname: string }; next: { pathname: string } }) => {
    if (!hasUnsavedWorkRef.current || current.pathname === next.pathname) return false;
    return !window.confirm('You have unsaved changes. Leave this page and discard them?');
  }, []);
  const warnBeforeUnload = useCallback(() => hasUnsavedWorkRef.current, []);
  useBlocker({ shouldBlockFn: shouldBlockNavigation, enableBeforeUnload: warnBeforeUnload });

  // Background loader refreshes must not replace drafts or edits held for review.
  useEffect(() => {
    if (storedSlugRef.current === global.slug && (hasUnsavedWorkRef.current || isSaving || isLoadingLatest)) return;
    operationRef.current++;
    showStoredGlobal(global);
    setSaveError('');
    setSaveMessage('');
    setFieldErrors({});
    setConflict(null);
    setReview(null);
    setIsSaving(false);
    setIsLoadingLatest(false);
  }, [global.slug, global.version, global.updatedAt, schemaFields]);

  /** Remember the loaded version and its data before resetting the form. */
  function showStoredGlobal(record: GlobalRecord) {
    const nextValues = mergeStoredValues(buildDefaultValues(schemaFields), parseGlobalData(record.data, schemaFields));
    const nextRaw = JSON.stringify(parseGlobalData(record.data, schemaFields), null, 2);
    savedSnapshotRef.current = JSON.stringify(nextValues);
    rawSnapshotRef.current = nextRaw;
    storedSlugRef.current = record.slug;
    setStoredGlobal(record);
    form.reset(nextValues, { keepDefaultValues: true });
    setRawJsonValue(nextRaw);
  }

  function readDraft(): ConflictSnapshot {
    const data: unknown = hasConfiguredFields ? form.state.values : (rawJsonValue.trim() ? JSON.parse(rawJsonValue) : {});
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The JSON document must be an object, for example {"title": "Hello"}.');
    return { data: conflictSnapshotData(data as Record<string, unknown>) };
  }

  function draftError(error: unknown) {
    return error instanceof SyntaxError ? 'Invalid JSON. Fix the document before continuing.' : error instanceof Error ? error.message : 'Unable to read your edits.';
  }

  function confirmDiscardHeld(outcome: string) {
    return !conflictHoldsChanges || window.confirm(`Your held edits have not been applied to the form. ${outcome}`);
  }

  function dismissConflict() {
    if (isSaving || isLoadingLatest || !confirmDiscardHeld('Dismiss them? They will be lost.')) return;
    setConflict(null);
    saveButtonRef.current?.focus();
  }

  function openReview() {
    if (!conflict?.latestLoaded || isSaving || isLoadingLatest) return;
    try {
      const latest = { data: JSON.parse(savedSnapshotRef.current) };
      const newer = conflictFieldChanges(latest.data, readDraft().data);
      setSaveError('');
      setReview({ original: conflict.original, mine: { data: withFieldChanges(conflict.mine.data, newer) }, latest, editedFields: Object.keys(newer) });
    } catch (error) { setSaveError(draftError(error)); }
  }

  function applyReview(resolved: ConflictSnapshot) {
    if (!conflict?.latestLoaded || isSaving || isLoadingLatest) return;
    form.reset(resolved.data, { keepDefaultValues: true });
    setRawJsonValue(JSON.stringify(resolved.data, null, 2));
    setReview(null);
    setConflict(null);
    setSaveMessage('Your choices are in the form. Save to apply them.');
    saveButtonRef.current?.focus();
  }

  function showFieldErrors(nextFieldErrors: FieldErrors) {
    setFieldErrors(nextFieldErrors);
    for (const [name, messages] of Object.entries(nextFieldErrors)) {
      if (schemaFields.some((field: any) => field.name === name)) setServerFieldError(form, name, formatFieldErrors(messages));
    }
  }

  async function loadLatestVersion() {
    if (!conflict || isSaving || isLoadingLatest) return;
    let mine: ConflictSnapshot;
    try { mine = readDraft(); } catch (error) { setSaveError(draftError(error)); return; }
    const targetSlug = global.slug;
    const operation = ++operationRef.current;
    setIsLoadingLatest(true);
    setSaveError('');
    setSaveMessage('');
    try {
      const res = await fetch(`${adminBasePath}/api/globals/${encodeURIComponent(targetSlug)}`);
      if (!res.ok) throw new Error(res.status === 401 ? 'Your session has expired. Sign in again in another tab, then try again.' : `Failed to load the latest version (HTTP ${res.status}).`);
      const latest = await res.json() as GlobalRecord;
      if (activeSlugRef.current !== targetSlug || operationRef.current !== operation) return;
      showStoredGlobal(latest);
      setFieldErrors({});
      setConflict({ original: conflict.original, mine, latestLoaded: true });
      setSaveMessage(LATEST_LOADED_MESSAGE);
    } catch (error) {
      if (activeSlugRef.current === targetSlug && operationRef.current === operation) setSaveError(error instanceof Error ? error.message : 'Failed to load the latest version.');
    } finally {
      if (activeSlugRef.current === targetSlug && operationRef.current === operation) setIsLoadingLatest(false);
    }
  }

  async function handleSave() {
    if (isSaving || isLoadingLatest || !confirmDiscardHeld('The save will omit them. Continue?')) return;
    const targetSlug = global.slug;
    const operation = ++operationRef.current;
    setIsSaving(true);
    setSaveError('');
    setSaveMessage('');
    setFieldErrors({});
    for (const field of schemaFields) {
      if (form.getFieldMeta(field.name)?.errorMap?.onServer) setServerFieldError(form, field.name, undefined);
    }

    try {
      // Optional fields left blank are sent as null, not as '' (which a number or select refuses).
      const mine = readDraft();
      const original = { data: JSON.parse(savedSnapshotRef.current) };
      const payload = hasConfiguredFields ? prepareFieldValuesForSave(schemaFields, mine.data) : mine.data;

      // The version the record was loaded with travels as If-Match; the server refuses the save
      // with HTTP 409 when someone else saved in between. Without a version the save wins, as before.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (typeof storedGlobal.version === 'number') headers['If-Match'] = `"${storedGlobal.version}"`;
      const res = await fetch(`${adminBasePath}/api/globals/${encodeURIComponent(targetSlug)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const result = await res.json().catch(() => ({})) as Partial<GlobalRecord> & {
        error?: string;
        message?: string;
        code?: string;
        fieldErrors?: FieldErrors;
        details?: { fieldErrors?: FieldErrors };
      };
      if (activeSlugRef.current !== targetSlug || operationRef.current !== operation) return;
      if (res.status === 409 && result.code === STALE_SAVE_CODE) {
        // The edits stay in the form; the panel offers the latest version.
        setConflict({ original, mine, latestLoaded: false });
        return;
      }
      if (!res.ok) {
        const nextFieldErrors = result.fieldErrors || result.details?.fieldErrors;
        if (nextFieldErrors && typeof nextFieldErrors === 'object') showFieldErrors(nextFieldErrors);
        throw new Error(result.error || result.message || 'Failed to save global');
      }

      // The answer carries the new version, which the next save names.
      showStoredGlobal({ ...storedGlobal, ...result } as GlobalRecord);
      setConflict(null);
      setSaveMessage('Saved');
    } catch (error) {
      if (activeSlugRef.current !== targetSlug || operationRef.current !== operation) return;
      if (error instanceof SyntaxError) {
        setSaveError('Invalid JSON. Fix the document before saving.');
      } else {
        setSaveError(error instanceof Error ? error.message : 'Failed to save global');
      }
    } finally {
      if (activeSlugRef.current === targetSlug && operationRef.current === operation) setIsSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-3">
          <Link
            to="/globals"
            className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
          >
            <ArrowLeft size={14} />
            Back to Globals
          </Link>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{globalConfig?.name || global.name}</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Editing <span className="font-mono text-zinc-300">{global.slug}</span>
            </p>
            {globalConfig?.description || global.description ? (
              <p className="mt-2 max-w-2xl text-sm text-zinc-500">{globalConfig?.description || global.description}</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {hasUnsavedWork && <span className="text-xs text-amber-300">Unsaved changes</span>}
          {saveMessage ? <p role="status" className="text-sm text-emerald-400">{saveMessage}</p> : null}
          <p role="status" className="sr-only">{isSaving ? 'Saving...' : isLoadingLatest ? 'Loading the latest version...' : ''}</p>
          <Button ref={saveButtonRef} className="gap-2" onClick={handleSave} aria-disabled={isSaving || isLoadingLatest || undefined} aria-busy={isSaving || undefined}>
            <Save size={16} />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-6 p-6">
          <ReadOnlyFieldContext.Provider value={isSaving || isLoadingLatest}>
            <fieldset disabled={isSaving || isLoadingLatest} className="space-y-6">
              {hasConfiguredFields ? (
                <>
                  <div className="space-y-2">
                    <h2 className="text-sm font-medium text-zinc-200">Configured Fields</h2>
                    <p className="text-sm text-zinc-400">
                      This global is schema-driven. Changes are validated against the configured field definitions before saving.
                    </p>
                  </div>
                  <AdminBasePathContext.Provider value={adminBasePath}>
                    <div className="space-y-6">
                      {schemaFields.map((field: any) => (
                        <FieldRenderer
                          key={field.name}
                          field={field}
                          form={form}
                          fieldPath=""
                          relationOptions={relationOptions}
                          relationSupportEntries={relationSupportEntries}
                          collapseStorageKey={collapseStorageKey}
                        />
                      ))}
                    </div>
                  </AdminBasePathContext.Provider>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <h2 className="text-sm font-medium text-zinc-200">JSON Document</h2>
                    <p className="text-sm text-zinc-400">
                      This global is not configured with fields yet, so it falls back to raw JSON editing.
                    </p>
                  </div>
                  <textarea
                    aria-label="Global JSON document"
                    value={rawJsonValue}
                    onChange={(event) => setRawJsonValue(event.target.value)}
                    spellCheck={false}
                    className="min-h-[420px] w-full rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 font-mono text-sm text-zinc-100 outline-none transition focus:border-indigo-500"
                  />
                </>
              )}

            </fieldset>
          </ReadOnlyFieldContext.Provider>
          {saveError ? <p role="alert" ref={saveErrorRef} tabIndex={-1} className="text-sm text-red-400 focus:outline-none">{saveError}</p> : null}
          {/* Announces a refused save; the panel itself is a region that takes focus, as it holds controls. */}
          <p role="alert" className="sr-only">{conflict && !conflict.latestLoaded ? 'This global changed after you opened it.' : ''}</p>
          {conflict ? (
            <div ref={conflictPanelRef} role="region" aria-labelledby={conflictTitleId} tabIndex={-1} className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60">
              <div id={conflictTitleId} className="font-medium text-amber-50">This global changed after you opened it</div>
              <p className="text-amber-100/80">
                {conflict.latestLoaded ? 'The latest version is in the form. Your edits are kept for review; choose which values to keep, then save.' : 'The save was refused because another editor saved this global. Your changes are still in the form. Load the latest version to review them alongside the saved values.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {conflict.latestLoaded ? <Button type="button" size="sm" variant="outline" onClick={openReview} aria-disabled={isSaving || isLoadingLatest || undefined}>Review changes</Button> : <Button type="button" size="sm" variant="outline" onClick={() => void loadLatestVersion()} aria-disabled={isSaving || isLoadingLatest || undefined} aria-busy={isLoadingLatest || undefined}>
                  Load latest version
                </Button>}
                <Button type="button" size="sm" variant="ghost" onClick={dismissConflict} aria-disabled={isSaving || isLoadingLatest || undefined}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}
          {Object.keys(fieldErrors).length > 0 ? (
            <div role="alert" aria-label="Validation errors" className="text-sm text-red-400">
              <ul className="space-y-1">
                {Object.entries(fieldErrors).map(([name, messages]) => (
                  <li key={name}>
                    {/* The field's name leads to the field itself. */}
                    <button type="button" onClick={() => focusFieldControl(name)} className="font-medium rounded-sm hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60">{getFieldErrorLabel(schemaFields, name)}</button>: {formatFieldErrors(messages)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-3 text-xs text-zinc-500 sm:grid-cols-2">
            <p>Created: {new Date(storedGlobal.createdAt).toLocaleString()}</p>
            <p>Updated: {new Date(storedGlobal.updatedAt).toLocaleString()}</p>
          </div>
        </CardContent>
      </Card>
      {review && <Suspense fallback={<p role="status" className="text-sm text-zinc-400">Loading conflict review…</p>}>
        <ConflictReviewDialog {...review} fields={schemaFields} onClose={() => setReview(null)} onApply={applyReview} getReturnFocus={() => saveButtonRef.current} />
      </Suspense>}
    </div>
  );
}
