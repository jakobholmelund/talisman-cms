import React, { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { globals as configuredGlobals } from 'virtual:talisman-cms/config';
import { ArrowLeft, Save } from 'lucide-react';
import { AdminBasePathContext, FieldRenderer } from '../../components/fields';
// The loader's helpers come from their own module: importing them through the index would keep the
// field renderer in the eager admin bundle, while the editor below loads with this route's chunk.
import { buildRelationOptions, fieldsNeedPresetEntries, type RelationSupportEntries } from '../../components/fields/relations';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { fetchCollectionConfigs, fetchEntriesBySlug } from '../../lib/admin-api';
import { prepareFieldValuesForSave } from '../../lib/entry-save';
import {
  buildDefaultValues,
  collectRelationshipFields,
  getRelationTargets,
  getZodClientSchemaForFields,
  normalizeStoredFieldData,
} from '../../lib/page-builder';

type GlobalRecord = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  data: string | Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
};

type FieldErrors = Record<string, string[]>;

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

    const global = await res.json() as GlobalRecord;
    const globalConfig = configuredGlobals.find((candidate) => candidate.slug === params.slug) || null;
    const relationSupportEntries: RelationSupportEntries = {};

    if (globalConfig?.fields?.length) {
      const relationFields = collectRelationshipFields(globalConfig.fields);
      const relationTargets = [...new Set(relationFields.flatMap((field: any) => getRelationTargets(field)))];
      if (fieldsNeedPresetEntries(globalConfig.fields)) {
        relationTargets.push('_ui_component_presets');
      }

      // The related collections load in parallel, each one bounded page at a time.
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
  const computedDefaults = mergeStoredValues(buildDefaultValues(schemaFields), parseGlobalData(storedGlobal.data, schemaFields));
  const [rawJsonValue, setRawJsonValue] = useState(() => JSON.stringify(parseGlobalData(global.data, schemaFields), null, 2));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const collapseStorageKey = `talisman-cms:collapsed:global:${global.slug}`;

  const form = useForm({
    defaultValues: computedDefaults,
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

  // Reset only when a different global or a newer stored version is loaded; loader reruns return new
  // objects for unchanged data, which must not discard what the user is typing.
  useEffect(() => {
    const nextValues = mergeStoredValues(buildDefaultValues(schemaFields), parseGlobalData(global.data, schemaFields));
    setStoredGlobal(global);
    form.reset(nextValues);
    setRawJsonValue(JSON.stringify(parseGlobalData(global.data, schemaFields), null, 2));
    setSaveError('');
    setSaveMessage('');
    setFieldErrors({});
  }, [form, global.slug, global.updatedAt, schemaFields]);

  function showFieldErrors(nextFieldErrors: FieldErrors) {
    setFieldErrors(nextFieldErrors);
    for (const [name, messages] of Object.entries(nextFieldErrors)) {
      if (schemaFields.some((field: any) => field.name === name)) setServerFieldError(form, name, formatFieldErrors(messages));
    }
  }

  async function handleSave() {
    setIsSaving(true);
    setSaveError('');
    setSaveMessage('');
    setFieldErrors({});
    for (const field of schemaFields) {
      if (form.getFieldMeta(field.name)?.errorMap?.onServer) setServerFieldError(form, field.name, undefined);
    }

    try {
      // Optional fields left blank are sent as null, not as '' (which a number or select refuses).
      const payload = hasConfiguredFields
        ? prepareFieldValuesForSave(schemaFields, form.state.values)
        : (rawJsonValue.trim() ? JSON.parse(rawJsonValue) : {});
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('The JSON document must be an object, for example {"title": "Hello"}.');
      }

      const res = await fetch(`${adminBasePath}/api/globals/${global.slug}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
      });

      const result = await res.json().catch(() => ({})) as Partial<GlobalRecord> & {
        error?: string;
        message?: string;
        fieldErrors?: FieldErrors;
        details?: { fieldErrors?: FieldErrors };
      };
      if (!res.ok) {
        const nextFieldErrors = result.fieldErrors || result.details?.fieldErrors;
        if (nextFieldErrors && typeof nextFieldErrors === 'object') showFieldErrors(nextFieldErrors);
        throw new Error(result.error || result.message || 'Failed to save global');
      }

      const nextValues = mergeStoredValues(buildDefaultValues(schemaFields), parseGlobalData(result.data, schemaFields));
      setStoredGlobal((current) => ({ ...current, ...result }));
      form.reset(nextValues);
      setRawJsonValue(JSON.stringify(parseGlobalData(result.data, schemaFields), null, 2));
      setSaveMessage('Saved');
    } catch (error) {
      if (error instanceof SyntaxError) {
        setSaveError('Invalid JSON. Fix the document before saving.');
      } else {
        setSaveError(error instanceof Error ? error.message : 'Failed to save global');
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-3">
          <a
            href={`${adminBasePath}/globals`}
            className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
          >
            <ArrowLeft size={14} />
            Back to Globals
          </a>
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

        <div className="flex items-center gap-3">
          {saveMessage ? <p role="status" className="text-sm text-emerald-400">{saveMessage}</p> : null}
          <Button className="gap-2" onClick={handleSave} disabled={isSaving}>
            <Save size={16} />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-6 p-6">
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

          {saveError ? <p role="alert" className="text-sm text-red-400">{saveError}</p> : null}
          {Object.keys(fieldErrors).length > 0 ? (
            <ul className="space-y-1 text-sm text-red-400">
              {Object.entries(fieldErrors).map(([name, messages]) => (
                <li key={name}>
                  <span className="font-medium">{getFieldErrorLabel(schemaFields, name)}</span>: {formatFieldErrors(messages)}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="grid gap-3 text-xs text-zinc-500 sm:grid-cols-2">
            <p>Created: {new Date(storedGlobal.createdAt).toLocaleString()}</p>
            <p>Updated: {new Date(storedGlobal.updatedAt).toLocaleString()}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
