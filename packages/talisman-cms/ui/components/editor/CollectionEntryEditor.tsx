import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useRouter } from '@tanstack/react-router';
import { useForm, useStore } from '@tanstack/react-form';
import { uiLibraries as configuredUiLibraries } from 'virtual:talisman-cms/ui-libraries';
import { adminEditorPanels } from 'virtual:talisman-cms/admin-extensions';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { ArrowLeft, Archive, Clock3, Database, History, Save, Send } from 'lucide-react';
import { AdminBasePathContext, FieldRenderer, focusFieldControl, ServerFieldErrorsContext, type RelationOptionRecord, type RelationSupportEntries, type ServerFieldErrors } from '../fields';
import { getAdminSection, getSectionCollectionLink, getSectionEntryLink, type AdminSection } from '../../lib/admin-sections';
import { fetchCollectionConfigs, fetchEntriesBySlug } from '../../lib/admin-api';
import { panelMatchesCollection, type AdminEditorPanelPlacement, type AdminEditorPanelProps } from './panels';
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
  getPagePath,
  getPendingSlugRename,
  hasEntryMovedOn,
  prepareFieldValuesForSave,
  readPendingTransition,
  waitForPendingTransition,
  type PendingTransition,
} from '../../lib/entry-save';
import { getEntryData } from '../../lib/entry-labels';
import {
  buildDefaultValues,
  getPresetClientSchema,
  getZodClientSchemaForFields,
  normalizeStoredFieldData,
} from '../../lib/page-builder';
import { validatePresetPayload } from '../../../src/presets';

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

// A message that must survive the remount when a newly created entry opens at its own URL: an error,
// or with kind 'status' the notice of a successful save.
type EditorNotice = { kind: 'error' | 'status'; message: string };

function getEditorNoticeKey(slug: string, entryId: string) {
  return `talisman-cms:editor-notice:${slug}:${entryId}`;
}

function stashEditorNotice(slug: string, entryId: string, message: string, kind: EditorNotice['kind'] = 'error') {
  try {
    window.sessionStorage.setItem(getEditorNoticeKey(slug, entryId), JSON.stringify({ kind, message }));
  } catch {
    // Storage can be unavailable; the entry still opens.
  }
}

function takeEditorNotice(slug: string, entryId: string): EditorNotice | null {
  try {
    const key = getEditorNoticeKey(slug, entryId);
    const stored = window.sessionStorage.getItem(key);
    if (!stored) return null;
    window.sessionStorage.removeItem(key);
    const parsed = JSON.parse(stored);
    return typeof parsed?.message === 'string' && parsed.message
      ? { kind: parsed.kind === 'status' ? 'status' : 'error', message: parsed.message }
      : null;
  } catch {
    return null;
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

/** The plugin panels (Plugin.adminEditorPanels) this collection gets at one placement. */
function getEditorPanels(collection: any, placement: AdminEditorPanelPlacement) {
  const collectionSection = getAdminSection(collection);
  return adminEditorPanels.filter((panel) => panel.placement === placement && panelMatchesCollection(panel, collection.slug, collectionSection));
}

/** The name of a native record for the heading, when it has one. */
function getRecordName(entryData: Record<string, any>) {
  return typeof entryData.name === 'string' && entryData.name.trim() ? entryData.name : null;
}

/**
 * Renders the matching plugin panels at one placement. Each panel is its own chunk, loaded when the
 * editor first shows it; the form values come from a subscription so the panels follow typing.
 */
function EditorPanels({
  panels,
  form,
  ...props
}: Omit<AdminEditorPanelProps, 'values'> & { panels: ReturnType<typeof getEditorPanels>; form: any }) {
  if (panels.length === 0) return null;
  return (
    <form.Subscribe
      selector={(state: any) => state.values}
      children={(values: Record<string, any>) => panels.map((panel) => {
        const Panel = panel.component;
        return (
          <Suspense key={panel.id} fallback={<p className="text-sm text-zinc-400">Loading...</p>}>
            <Panel {...props} values={values} />
          </Suspense>
        );
      })}
    />
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
  relationSupportEntries: RelationSupportEntries;
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
                // Stays in the tab order; the hint says why nothing can be chosen yet.
                aria-disabled={!selectedLibrary || undefined}
                aria-describedby={!selectedLibrary ? `${idPrefix}-component-hint` : undefined}
                className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 aria-disabled:opacity-50"
              >
                <option value="">Select a component...</option>
                {(selectedLibrary?.components || []).map((componentAdapter: any) => (
                  <option key={componentAdapter.component.slug} value={componentAdapter.component.slug}>
                    {componentAdapter.component.name}
                  </option>
                ))}
              </select>
              {!selectedLibrary && <p id={`${idPrefix}-component-hint`} className="sr-only">Choose a library first.</p>}
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
  relationSupportEntries: RelationSupportEntries;
  slug: string;
  entryId: string;
  basePath: string;
  section: AdminSection;
}) {
  const initialEntry = rawEntry as any;
  const navigate = useNavigate();
  const router = useRouter();
  const user = router.options.context.user;
  const isAdmin = user?.role === 'admin';
  const nativeCollection = isNativeCollection(collection);
  const presetCollection = isComponentPresetCollection(collection);
  const versioningEnabled = !nativeCollection;
  const supportsRawView = !nativeCollection && !presetCollection;
  const editorFields = getEditorFields(collection, isNew);
  const nativeIdColumn = getNativeIdColumn(collection);
  const recordLabel = nativeCollection ? 'record' : 'entry';

  const [currentEntry, setCurrentEntry] = useState<any>(initialEntry);
  const [revisions, setRevisions] = useState<any[]>(initialRevisions || []);
  const [entrySlug, setEntrySlug] = useState(initialEntry?.slug || '');
  const [slugError, setSlugError] = useState('');
  const slugInputId = useId();
  // Records next to the entry (relation targets and what plugin describers asked for). A plugin panel
  // reloads its own tables into this, rather than reloading the whole page.
  const [relationSupportEntries, setRelationSupportEntries] = useState<RelationSupportEntries>(loadedSupportEntries);
  useEffect(() => setRelationSupportEntries(loadedSupportEntries), [loadedSupportEntries]);
  const [viewMode, setViewMode] = useState<'form' | 'raw'>('form');
  // The entry action that is running, for its button's busy state and the status line; null when idle.
  const [working, setWorking] = useState<{ action: EditorAction | 'reload' | 'load-latest'; message: string } | null>(null);
  const isWorking = working !== null;

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
    // Same-page hash links are not a navigation away.
    if (leavingEditorRef.current || !hasUnsavedWorkRef.current || current.pathname === next.pathname) return false;
    return !window.confirm('You have unsaved changes. Leave this page and discard them?');
  }, []);
  const warnBeforeUnload = useCallback(() => !leavingEditorRef.current && hasUnsavedWorkRef.current, []);
  useBlocker({ shouldBlockFn: shouldBlockNavigation, enableBeforeUnload: warnBeforeUnload });

  useEffect(() => {
    const carriedNotice = takeEditorNotice(slug, entryId);
    if (carriedNotice?.kind === 'status') setNotice(carriedNotice.message);
    else if (carriedNotice) setGlobalError(carriedNotice.message);
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

  // Where focus goes when the control that had it is gone: the conflict panel when it appears or
  // changes what it offers, and the Save button when the panel or the pending box closes.
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const conflictPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (conflict) conflictPanelRef.current?.focus();
  }, [conflict]);

  if (!collection) return <div>Collection not found.</div>;

  const currentStatus = getEntryStatus(currentEntry, collection);
  const entryActionsLocked = isWorking || pendingTransition !== null;
  const pendingSlugRename = versioningEnabled ? getPendingSlugRename(currentEntry, entrySlug) : null;
  const formatSlugForDisplay = (value: string) => (slug === 'pages' ? getPagePath(value) : value);
  const panelsBeforeFields = getEditorPanels(collection, 'before-fields');
  const panelsAfterForm = getEditorPanels(collection, 'after-form');
  // Fields that server code changes in place (Plugin: saveOnlyIfChanged), so a refused save may be
  // another process's doing, not another editor's.
  const hasInPlaceFields = editorFields.some((field: any) => field.saveOnlyIfChanged);

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
    if (!pendingTransition || isWorking) return;
    const pending = pendingTransition;
    setGlobalError('');
    setWorking({ action: 'reload', message: `Reloading the ${recordLabel}...` });
    try {
      const latest = await fetchEntry(pending.entryId);
      if (hasEntryMovedOn(latest, pending)) {
        await settlePendingTransition(pending, latest);
        saveButtonRef.current?.focus();
        return;
      }
      setPendingTransition(null);
      setNotice(`The ${pending.action} has not finished yet. It can still finish in the background: reload the page in a minute and check the status before you try again.`);
      saveButtonRef.current?.focus();
    } catch (error) {
      setGlobalError(describeRequestError(error));
    } finally {
      setWorking(null);
    }
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
    // Optional fields left blank are sent as null (or left out of a new native row), not as ''. A
    // native update leaves out an unchanged field with saveOnlyIfChanged (the server validates
    // native updates partially and keeps the stored value).
    const data = prepareFieldValuesForSave(editorFields, value, nativeCollection
      ? { native: true, mode: isNew ? 'create' : 'update', baseline: JSON.parse(savedSnapshotRef.current.values) }
      : {});
    const body = nativeCollection
      ? isNew
        ? { data }
        : { data, ...(loadedUpdatedAt !== null ? { expectedUpdatedAt: loadedUpdatedAt } : {}) }
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
    void navigate({ ...getSectionEntryLink(section, slug, createdEntryId), replace: true });
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
    if (entryActionsLocked) return;
    if (!confirmDiscardConflictChanges(`The ${action} will not include them and they will be lost. Continue?`)) return;
    resetFeedback();
    setWorking({ action, message: action === 'save' ? 'Saving...' : action === 'publish' ? 'Publishing...' : 'Archiving...' });
    let createdEntryId: string | null = null;
    const savedNotice = versioningEnabled ? 'Draft saved.' : 'Changes saved.';

    try {
      let targetEntry = currentEntry;
      // Publish and archive act on the stored draft, so only save first when there is something to save.
      if (action === 'save' || isNew || hasUnsavedChangesRef.current) {
        const savedEntry = await persistDraft();
        if (isNew) {
          createdEntryId = savedEntry.id;
          if (action === 'save') {
            stashEditorNotice(slug, savedEntry.id, savedNotice, 'status');
            openCreatedEntry(savedEntry.id);
            return;
          }
          targetEntry = await fetchEntry(savedEntry.id);
        } else {
          targetEntry = await refreshEntryState(savedEntry.id);
        }
      }

      if (action === 'save') {
        setNotice(savedNotice);
        return;
      }
      const doneNotice = `The ${recordLabel} is ${action === 'publish' ? 'published' : 'archived'}.`;

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
        else stashEditorNotice(slug, createdEntryId, doneNotice, 'status');
        openCreatedEntry(createdEntryId);
        return;
      }

      if (!pending) {
        await refreshEntryState(nextEntry.id);
        setNotice(doneNotice);
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
      // Stay busy while the created entry opens, so a second click cannot create a duplicate.
      if (!leavingEditorRef.current) setWorking(null);
    }
  };

  const handleRestoreRevision = async (revision: any) => {
    if (!currentEntry?.id || entryActionsLocked) return;
    if (hasUnsavedWorkRef.current && !window.confirm('Restoring this revision replaces your unsaved changes. Continue?')) return;

    resetFeedback();
    setWorking({ action: 'restore', message: `Restoring revision ${revision.revisionNumber}...` });

    try {
      const restored = await requestEditorApi(`${basePath}/api/collections/${slug}/entries/${currentEntry.id}/revisions/${revision.id}/restore`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevisionId: currentEntry.latestRevisionId ?? null })
      }, 'Failed to restore this revision');

      broadcastChange(restored.id);
      await refreshEntryState(restored.id);
      setNotice(`Revision ${revision.revisionNumber} restored.`);
    } catch (error) {
      handleRequestError(error, 'restore');
    } finally {
      setWorking(null);
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
    saveButtonRef.current?.focus();
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
    if (!conflict || !currentEntry?.id || isWorking) return;
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
    setWorking({ action: 'load-latest', message: 'Loading the latest version...' });

    try {
      await refreshEntryState(currentEntry.id);
      setConflict({ ...conflict, ...held, latestLoaded: true });
    } catch (error) {
      setGlobalError(describeRequestError(error));
    } finally {
      setWorking(null);
    }
  };

  // Puts only the fields the user changed back on top of the latest version. Every other field keeps
  // its latest value, so saving neither reverts someone else's edits nor writes back stale stock.
  const reapplyConflictDraft = () => {
    if (!conflict || isWorking) return;
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
    // The panel closes under the button; the next step is to save.
    saveButtonRef.current?.focus();
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

  // A plugin panel's related records are separate rows: reload just those collections, without
  // resetting the form or reloading the entry and every other related collection. The panel rebuilds
  // from the result, so a refused read throws instead of reading as empty.
  const refreshSupportEntries = async (slugs: string[]) => {
    const collections = await fetchCollectionConfigs(basePath);
    const latest = await fetchEntriesBySlug(basePath, slugs, collections, { strict: true });
    setRelationSupportEntries((current) => ({ ...current, ...latest }));
  };

  const entryData = parseEntryData(currentEntry, editorFields);
  const displayLabel = (nativeCollection && getRecordName(entryData))
    || initialEntry?.slug || initialEntry?.id?.substring(0, 8) || slug;
  const panelProps = {
    collection,
    entry: currentEntry ?? null,
    isNew,
    relationSupportEntries,
    refreshSupportEntries,
    basePath,
    section,
    user: user ?? null,
  };

  return (
    <div className="space-y-6 w-full pb-24">
      <div className="flex items-center justify-between pointer-events-none mb-2">
        <Link {...getSectionCollectionLink(section, slug)} className="hover:text-white transition-colors flex items-center gap-1 text-sm bg-white/5 px-2.5 py-1 rounded-md backdrop-blur-sm border border-white/5 hover:bg-white/10 hover:border-white/10 text-zinc-400 pointer-events-auto">
          <ArrowLeft size={14} /> Back to {collection.name}
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-white shadow-sm">
          {isNew ? `New ${nativeCollection ? 'Record' : 'Entry'}` : <span className="text-zinc-400 font-medium text-2xl mr-2">Edit:</span>}
          {!isNew && <span className="bg-gradient-to-r from-indigo-400 to-indigo-300 bg-clip-text text-transparent">{displayLabel}</span>}
        </h1>
        <p className="text-zinc-400 mt-2 text-sm max-w-xl">
          {collection.description || `Edit this ${nativeCollection ? 'record' : 'content entry'} in ${collection.name}.`}
        </p>
        {collection.readOnly && <p id={`${slugInputId}-readonly`} className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">This record is managed by server code and is read-only in the CMS.</p>}
      </div>

      <div className="space-y-8 w-full">
        {/* A fieldset, so a read-only record disables its controls for the keyboard too, not only for the mouse. */}
        <fieldset disabled={collection.readOnly || undefined} aria-describedby={collection.readOnly ? `${slugInputId}-readonly` : undefined} className={`min-w-0 space-y-6 scroll-mt-24 ${collection.readOnly ? 'pointer-events-none opacity-80' : ''}`}>
          <Card>
             <CardContent className="pt-6">
                <div className="space-y-8">
                  <EditorPanels panels={panelsBeforeFields} form={form} {...panelProps} />

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
                      <div className="text-sm font-medium text-zinc-300">Record fields</div>
                      <p className="text-sm text-zinc-400 mt-2">Changes to this record are saved directly.</p>
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
                           {nativeCollection ? 'Record fields' : 'Content fields'}
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
        </fieldset>

        <div className="space-y-8">
           <Card>
              <CardContent className="pt-6 space-y-6">
                 <div>
                   {/* An output is labelable and a live region, so the label names it and status changes are read out. */}
                   <label htmlFor={`${slugInputId}-status`} className="text-sm font-medium mb-2 block text-zinc-300">{nativeCollection ? 'State' : 'Status'}</label>
                   <output id={`${slugInputId}-status`} className={`inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium ${getStatusBadgeClass(currentStatus)}`}>
                     {currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1)}
                   </output>
                   {!versioningEnabled && (
                     <p className="text-xs text-zinc-500 mt-2">Native collections bypass the draft/publish workflow and revision history.</p>
                   )}
                 </div>

                 <div className="pt-2">
                    {/* The buttons stay focusable while an action runs (aria-disabled); the status line says what is happening. */}
                    {!collection.readOnly && <Button ref={saveButtonRef} onClick={handleManualSaveClick} aria-disabled={entryActionsLocked || undefined} aria-busy={working?.action === 'save' || undefined} className="w-full gap-2 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] transition-all duration-300 border-0 h-11 text-base">
                      <Save size={18} /> {isWorking ? 'Working...' : versioningEnabled ? 'Save Draft' : 'Save Changes'}
                    </Button>}
                    {versioningEnabled && !collection.readOnly && isAdmin && (
                      <div className="grid grid-cols-2 gap-3 mt-3">
                        <Button type="button" variant="outline" aria-disabled={entryActionsLocked || undefined} aria-busy={working?.action === 'publish' || pendingTransition?.action === 'publish' || undefined} onClick={() => void runEntryAction('publish')} className="gap-2">
                          <Send size={16} /> {pendingTransition?.action === 'publish' ? 'Publishing...' : 'Publish'}
                        </Button>
                        <Button type="button" variant="outline" disabled={isNew} aria-disabled={entryActionsLocked || undefined} aria-busy={working?.action === 'archive' || pendingTransition?.action === 'archive' || undefined} onClick={() => void runEntryAction('archive')} className="gap-2">
                          <Archive size={16} /> {pendingTransition?.action === 'archive' ? 'Archiving...' : 'Archive'}
                        </Button>
                      </div>
                    )}
                    <p role="status" className="sr-only">{working?.message ?? ''}</p>
                    {hasUnsavedWork && !isWorking && (
                      <p className="text-xs text-amber-300 mt-3 text-center">Unsaved changes</p>
                    )}
                    {globalError && <p role="alert" className="text-red-400 text-sm mt-3 text-center">{globalError}</p>}
                    {Object.keys(serverFieldErrors).length > 0 && (
                      <form.Subscribe
                        selector={(state: any) => state.values}
                        children={(values: Record<string, any>) => (
                          <ul role="alert" className="mt-3 space-y-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                            {Object.entries(serverFieldErrors).map(([fieldPath, messages]) => (
                              <li key={fieldPath || 'entry'}>
                                {/* The field's name leads to the field itself, when it is on the page. */}
                                <button type="button" onClick={() => focusFieldControl(fieldPath)} className="font-medium rounded-sm hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60">{describeFieldPath(fieldPath, collection.fields || [], values)}</button>: {messages.join(', ')}
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
                          <Button type="button" size="sm" variant="outline" onClick={() => void checkPendingTransition()} aria-disabled={isWorking || undefined} aria-busy={working?.action === 'reload' || undefined}>
                            Reload {recordLabel}
                          </Button>
                        )}
                      </div>
                    )}
                    {/* Kept mounted so screen readers hear each outcome; empty, it takes no space. */}
                    <p role="status" className={notice ? 'text-emerald-300 text-sm mt-3 text-center' : 'sr-only'}>{notice}</p>
                    {/* Announces a refused save; the panel itself is a region that takes focus, as it holds controls. */}
                    <p role="alert" className="sr-only">{conflict && !conflict.latestLoaded ? `This ${recordLabel} changed after you opened it.` : ''}</p>
                    {conflict && (
                      <div ref={conflictPanelRef} role="region" aria-labelledby={`${slugInputId}-conflict-title`} tabIndex={-1} className="mt-4 space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60">
                        <div id={`${slugInputId}-conflict-title`} className="font-medium text-amber-50">
                          {conflict.latestLoaded ? 'The latest saved version is now in the form' : `This ${recordLabel} changed after you opened it`}
                        </div>
                        <p className="text-amber-100/80">
                          {conflict.latestLoaded
                            ? conflictHasChanges
                              ? `Your changes to ${conflictChangeLabels} are kept below. Put them back to apply only those fields on top of the latest version, then save. Everything else keeps its latest value.`
                              : `You had no unsaved changes, so nothing was lost. Check the latest version, then retry the ${conflict.action} if it still applies.`
                            : `The ${conflict.action} was refused because ${hasInPlaceFields ? 'another editor or a background update' : 'someone else'} changed this ${recordLabel}. ${conflictHasChanges
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
                                <Button type="button" size="sm" variant="outline" onClick={reapplyConflictDraft} aria-disabled={isWorking || undefined}>
                                  Put my changes back
                                </Button>
                              )}
                              <Button type="button" size="sm" variant="ghost" onClick={dismissConflict}>
                                Dismiss
                              </Button>
                            </>
                          ) : (
                            <Button type="button" size="sm" variant="outline" onClick={() => void loadLatestAfterConflict()} aria-disabled={isWorking || undefined} aria-busy={working?.action === 'load-latest' || undefined}>
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
                                aria-label="My changes as JSON"
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
                       <div className="text-sm font-mono text-zinc-300 break-all">{currentEntry.id}</div>
                     </div>
                     {nativeCollection && entryData[nativeIdColumn] && entryData[nativeIdColumn] !== currentEntry.id && (
                       <div className="bg-white/[0.02] rounded-md p-3 border border-white/5">
                         <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Primary Key</div>
                         <div className="text-sm font-mono text-zinc-300 break-all">{entryData[nativeIdColumn]}</div>
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
                     <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                       <History size={14} />
                       Revision History
                     </h2>
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
                                 <h3 className="text-sm text-zinc-200">Revision #{revision.revisionNumber}</h3>
                                 <div className="text-[11px] uppercase tracking-widest text-zinc-500">{revision.type.replace('_', ' ')}</div>
                               </div>
                               {isAdmin && !collection.readOnly && <Button type="button" variant="ghost" size="sm" aria-disabled={entryActionsLocked || undefined} onClick={() => void handleRestoreRevision(revision)}>
                                 Restore<span className="sr-only"> revision {revision.revisionNumber}</span>
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
        {panelsAfterForm.length > 0 && <fieldset disabled={collection.readOnly || undefined} aria-describedby={collection.readOnly ? `${slugInputId}-readonly` : undefined} className={`min-w-0 space-y-8 scroll-mt-24 ${collection.readOnly ? 'pointer-events-none opacity-80' : ''}`}>
          <EditorPanels panels={panelsAfterForm} form={form} {...panelProps} />
        </fieldset>}
      </div>
    </div>
  );
}
