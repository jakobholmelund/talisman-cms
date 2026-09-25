import React, { useEffect, useId, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { globals as configuredGlobals } from 'virtual:talisman-cms/config';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, GripVertical, Plus, Save } from 'lucide-react';
import { BlockLibraryPicker } from '../../components/BlockLibraryPicker';
import { ComponentSlotPicker } from '../../components/ComponentSlotPicker';
import { formatFieldErrors as formatErrorMessages, PageBuilderComposer } from '../../components/PageBuilderComposer';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { RichTextEditor } from '../../components/RichTextEditor';
import { fetchCollectionConfigs, fetchEntriesBySlug } from '../../lib/admin-api';
import { prepareFieldValuesForSave } from '../../lib/entry-save';
import {
  getRelationOptionKey,
  getRelationTargets,
  isPolymorphicRelationField,
  isRelationReference,
  type RelationReference,
} from '../../lib/page-builder';
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

type RelationOptionRecord = {
  collectionSlug: string;
  entry: any;
};

type RelationSupportEntries = Record<string, any[]>;

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


function getRecordLabel(entry: any) {
  return entry?.title || entry?.name || entry?.slug || entry?.id || 'Untitled';
}

function getRecordSubtitle(entry: any) {
  const parts = [entry?.slug, entry?.id].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);
  return parts.join(' • ');
}

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
    if (typeof item === 'string') return [{ relationTo, value: item }];
    if (isRelationReference(item)) return [{ relationTo, value: item.value }];
    if (item && typeof item === 'object' && typeof item.id === 'string') return [{ relationTo, value: item.id }];
    return [];
  });
}

function serializeRelationSelections(field: any, selections: RelationReference[]) {
  if (field.hasMany) {
    return isPolymorphicRelationField(field) ? selections : selections.map((selection) => selection.value);
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

function globalNeedsPresetEntries(globalConfig: any) {
  return (globalConfig?.fields || []).some((field: any) =>
    field.type === 'blocks' &&
    (field.blocks || []).some((block: any) =>
      (block.componentSlots || []).some((slot: any) => slot.allowReferences)
    )
  );
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

function RelationshipPicker({
  field,
  value,
  onChange,
  onBlur,
  relationOptions,
  relationSupportEntries,
  labelId,
  describedBy,
}: {
  field: any;
  value: any;
  onChange: (value: any) => void;
  onBlur: () => void;
  relationOptions: Record<string, RelationOptionRecord[]>;
  relationSupportEntries: RelationSupportEntries;
  /** The id of the field's visible label, which names the picker. */
  labelId?: string;
  describedBy?: string;
}) {
  const [query, setQuery] = useState('');
  const options = getRelationOptionsForField(field, relationOptions);
  const selections = normalizeRelationSelections(field, value);
  const selectedKeys = new Set(selections.map(getRelationSelectionKey));
  const filteredOptions = options.filter((option) => {
    const search = query.trim().toLowerCase();
    if (!search) return true;

    const label = getRecordLabel(option.entry).toLowerCase();
    const subtitle = getRecordSubtitle(option.entry).toLowerCase();
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

  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${field.label.toLowerCase()}...`}
        aria-label={`Search ${field.label}`}
        className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm text-zinc-100 shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
      />

      {selections.length > 0 ? (
        <div className="space-y-2">
          {selections.map((selection) => {
            const entry = (relationSupportEntries[selection.relationTo] || []).find((candidate: any) => candidate.id === selection.value) || null;
            return (
              <div key={getRelationSelectionKey(selection)} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">{entry ? getRecordLabel(entry) : selection.value}</div>
                    <div className="mt-1 text-xs text-zinc-400">
                      {selection.relationTo}
                      {entry ? ` • ${getRecordSubtitle(entry)}` : ''}
                    </div>
                  </div>
                  <Button type="button" size="sm" variant="destructive" aria-label={`Remove ${entry ? getRecordLabel(entry) : selection.value}`} onClick={() => removeSelection(selection)}>
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div role="group" aria-label={`${field.label} options`} className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950/30">
        {filteredOptions.length === 0 ? (
          <div className="px-3 py-4 text-sm text-zinc-500">No entries matched this search.</div>
        ) : (
          filteredOptions.map((option) => {
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
                  <div className="text-sm font-medium text-zinc-100">{getRecordLabel(option.entry)}</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {option.collectionSlug}
                    {getRecordSubtitle(option.entry) ? ` • ${getRecordSubtitle(option.entry)}` : ''}
                  </div>
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

function FieldRenderer({
  field,
  form,
  basePath,
  relationOptions,
  relationSupportEntries,
  collapseStorageKey,
}: {
  field: any;
  form: any;
  basePath: string;
  relationOptions: Record<string, RelationOptionRecord[]>;
  relationSupportEntries: RelationSupportEntries;
  collapseStorageKey?: string;
}) {
  const fieldName = basePath ? `${basePath}.${field.name}` : field.name;
  // Links each label to its control, and each control to its error message.
  const controlId = useId();
  const labelId = `${controlId}-label`;
  const errorId = `${controlId}-error`;
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
            <div role="group" aria-labelledby={labelId} className="space-y-4 rounded-lg border border-white/10 bg-zinc-950/40 p-5 shadow-inner">
              <div className="flex items-center justify-between border-b border-white/5 pb-3">
                <div id={labelId} className="text-sm font-medium text-zinc-300">{field.label}</div>
                <Button size="sm" variant="outline" type="button" onClick={() => fieldApi.pushValue(buildDefaultValues(field.fields))}>
                  Add Row
                </Button>
              </div>

              {value.map((_: any, index: number) => (
                <div key={index} role="group" aria-label={`${field.label} row ${index + 1}`} className="relative rounded-lg border border-white/5 bg-white/[0.02] p-5">
                  <Button
                    size="sm"
                    variant="destructive"
                    type="button"
                    className="absolute right-3 top-3"
                    aria-label={`Remove ${field.label} row ${index + 1}`}
                    onClick={() => fieldApi.removeValue(index)}
                  >
                    Remove
                  </Button>
                  <div className="space-y-4 pr-20">
                    {field.fields?.map((subField: any) => (
                      <FieldRenderer
                        key={subField.name}
                        field={subField}
                        form={form}
                        basePath={`${fieldName}[${index}]`}
                        relationOptions={relationOptions}
                        relationSupportEntries={relationSupportEntries}
                        collapseStorageKey={collapseStorageKey}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
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

    return (
      <form.Field
        name={fieldName}
        mode="array"
        children={(fieldApi: any) => {
          const value = fieldApi.state.value || [];
          const insertBlockAtIndex = (index: number | null, block: any) => {
            const nextBlockValue = buildBlockValue(block);
            if (index === null) {
              fieldApi.pushValue(nextBlockValue);
            } else {
              insertFieldArrayValue(fieldApi, index, nextBlockValue);
            }
            setPendingBlockInsertIndex(null);
            setBlockLibraryOpen(false);
          };

          return (
            <div className="space-y-4 rounded-lg border border-white/10 bg-zinc-950/40 p-5 shadow-inner">
              <div className="flex items-center justify-between border-b border-white/5 pb-3">
                <label className="text-sm font-medium text-zinc-300">{field.label}</label>
                <div className="flex items-center gap-2">
                  {value.length > 0 ? (
                    <>
                      <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(fieldName, value.length, true)}>
                        Collapse All
                      </Button>
                      <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(fieldName, value.length, false)}>
                        Expand All
                      </Button>
                    </>
                  ) : null}
                  <div className="text-xs text-zinc-500">{value.length} added</div>
                </div>
              </div>

              <BlockLibraryPicker
                blocks={field.blocks}
                open={blockLibraryOpen}
                onOpenChange={(nextOpen) => {
                  setBlockLibraryOpen(nextOpen);
                  if (!nextOpen) {
                    setPendingBlockInsertIndex(null);
                  }
                }}
                buttonLabel={pendingBlockInsertIndex === null ? 'Add Block' : 'Insert Block'}
                contextMessage={pendingBlockInsertIndex === null ? undefined : `Choose a block to insert at position ${pendingBlockInsertIndex + 1}.`}
                onSelect={(block) => insertBlockAtIndex(pendingBlockInsertIndex, block)}
              />

              {value.map((blockValue: any, index: number) => {
                const blockDef = field.blocks?.find((block: any) => block.slug === blockValue?.blockType);
                if (!blockDef) return null;
                const blockCollapsed = isCardCollapsed(fieldName, index);
                const blockSummary = getBlockPreviewSummary(blockDef, blockValue, relationSupportEntries);

                return (
                  <div
                    key={index}
                    draggable
                    onDragStart={() => setDragState({ listId: fieldName, index })}
                    onDragEnd={() => setDragState(null)}
                    onDragOver={(event) => {
                      if (dragState && dragState.listId === fieldName && dragState.index !== index) {
                        event.preventDefault();
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragState && dragState.listId === fieldName && dragState.index !== index) {
                        reorderFieldArrayValue(fieldApi, dragState.index, index);
                      }
                      setDragState(null);
                    }}
                    className={`rounded-lg border border-white/5 border-l-4 border-l-indigo-500 bg-white/[0.02] p-5 ${
                      dragState && dragState.listId === fieldName && dragState.index === index ? 'opacity-70 ring-1 ring-indigo-400/30' : ''
                    }`}
                  >
                    <div className="mb-5 flex items-center justify-between border-b border-white/5 pb-3">
                      <div className="flex items-center gap-3">
                        <div
                          draggable
                          onDragStart={() => setDragState({ listId: fieldName, index })}
                          onDragEnd={() => setDragState(null)}
                          className="flex h-8 w-8 cursor-grab items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-zinc-500 active:cursor-grabbing"
                          title="Drag to reorder block"
                        >
                          <GripVertical size={14} />
                        </div>
                        <div>
                          <button
                            type="button"
                            onClick={() => toggleCardCollapsed(fieldName, index)}
                            className="flex items-center gap-2 text-left"
                          >
                            {blockCollapsed ? <ChevronRight size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
                            <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">{blockDef.name} Block</span>
                          </button>
                          {blockSummary.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {blockSummary.map((summary: string, summaryIndex: number) => (
                                <span key={`${fieldName}-${index}-summary-${summaryIndex}`} className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-400">
                                  {summary}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          onClick={() => {
                            setPendingBlockInsertIndex(index);
                            setBlockLibraryOpen(true);
                          }}
                        >
                          Add Above
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          onClick={() => {
                            setPendingBlockInsertIndex(index + 1);
                            setBlockLibraryOpen(true);
                          }}
                        >
                          Add Below
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          className="h-8 w-8 p-0"
                          onClick={() => reorderFieldArrayValue(fieldApi, index, index - 1)}
                          disabled={index === 0}
                          title="Move block up"
                        >
                          <ArrowUp size={14} />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          className="h-8 w-8 p-0"
                          onClick={() => reorderFieldArrayValue(fieldApi, index, index + 1)}
                          disabled={index === value.length - 1}
                          title="Move block down"
                        >
                          <ArrowDown size={14} />
                        </Button>
                        <Button size="sm" variant="destructive" type="button" onClick={() => fieldApi.removeValue(index)}>
                          Remove
                        </Button>
                      </div>
                    </div>
                    {!blockCollapsed ? (
                    <div className="space-y-4">
                      {blockDef.fields?.map((subField: any) => (
                        <FieldRenderer
                          key={subField.name}
                          field={subField}
                          form={form}
                          basePath={`${fieldName}[${index}]`}
                          relationOptions={relationOptions}
                          relationSupportEntries={relationSupportEntries}
                          collapseStorageKey={collapseStorageKey}
                        />
                      ))}
                      {(blockDef.componentSlots || []).map((slot: any) => {
                                      const slotFieldName = `${fieldName}[${index}].${slot.name}`;
                                      const presetEntries = getAllowedPresetEntries(slot, relationSupportEntries._ui_component_presets || []);
                                      return (
                                        <form.Field
                                          key={slot.name}
                                          name={slotFieldName}
                                          {...(slot.hasMany ? { mode: 'array' as const } : {})}
                                          children={(slotApi: any) => {
                                            const slotItems = getComponentSlotItems(slot, slotApi.state.value);
                                            const slotPickerConfig = getSlotPickerConfig(slotFieldName);
                                            return (
                                              <div className="rounded-lg border border-white/10 bg-zinc-950/30 p-4 shadow-inner">
                                                <div className="flex items-center justify-between gap-3 border-b border-white/5 pb-3">
                                                  <div>
                                                    <div className="text-sm font-medium text-zinc-200">{slot.label}</div>
                                                    {slot.description ? <div className="mt-1 text-xs text-zinc-400">{slot.description}</div> : null}
                                                  </div>
                                                  <div className="flex items-center gap-2">
                                                    {slot.hasMany && slotItems.length > 0 ? (
                                                      <>
                                                        <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(slotFieldName, slotItems.length, true)}>
                                                          Collapse All
                                                        </Button>
                                                        <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(slotFieldName, slotItems.length, false)}>
                                                          Expand All
                                                        </Button>
                                                      </>
                                                    ) : null}
                                                    <div className="text-xs text-zinc-500">{slotItems.length} added</div>
                                                  </div>
                                                </div>
                                                <ComponentSlotPicker
                                                  components={slot.components}
                                                  presetEntries={slot.allowReferences ? presetEntries : []}
                                                  open={slotPickerConfig.open}
                                                  onOpenChange={(nextOpen) => {
                                                    if (nextOpen) {
                                                      openSlotPicker(slotFieldName, slotPickerConfig.insertIndex);
                                                    } else {
                                                      closeSlotPicker(slotFieldName);
                                                    }
                                                  }}
                                                  buttonLabel={slotPickerConfig.insertIndex === null ? 'Add to Slot' : 'Insert Item'}
                                                  contextMessage={slotPickerConfig.insertIndex === null ? undefined : `Choose an item to insert at position ${slotPickerConfig.insertIndex + 1}.`}
                                                  onSelectComponent={(component) => {
                                                    insertSlotValue(slot, slotApi, slotPickerConfig.insertIndex, buildInlineComponentValue(component));
                                                    closeSlotPicker(slotFieldName);
                                                  }}
                                                  onSelectPreset={(preset) => {
                                                    insertSlotValue(slot, slotApi, slotPickerConfig.insertIndex, buildPresetReferenceValue(preset.id));
                                                    closeSlotPicker(slotFieldName);
                                                  }}
                                                />

                                  <div className="mt-4 space-y-4">
                                    {slotItems.length === 0 ? (
                                      <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-sm text-zinc-500">
                                        No components added yet.
                                      </div>
                                    ) : slotItems.map((slotItem: any, slotIndex: number) => {
                                      if (isPresetReferenceValue(slotItem)) {
                                        const presetEntry = (relationSupportEntries._ui_component_presets || []).find((preset: any) => preset.id === slotItem.presetId);
                                        return (
                                          <div
                                            key={`${slot.name}-preset-${slotIndex}`}
                                            draggable={slot.hasMany}
                                            onDragStart={() => {
                                              if (slot.hasMany) {
                                                setDragState({ listId: slotFieldName, index: slotIndex });
                                              }
                                            }}
                                            onDragEnd={() => setDragState(null)}
                                            onDragOver={(event) => {
                                              if (slot.hasMany && dragState?.listId === slotFieldName && dragState.index !== slotIndex) {
                                                event.preventDefault();
                                              }
                                            }}
                                            onDrop={(event) => {
                                              event.preventDefault();
                                              if (slot.hasMany && dragState?.listId === slotFieldName && dragState.index !== slotIndex) {
                                                reorderFieldArrayValue(slotApi, dragState.index, slotIndex);
                                              }
                                              setDragState(null);
                                            }}
                                            className={`rounded-lg border border-white/5 bg-white/[0.02] p-4 ${
                                              dragState?.listId === slotFieldName && dragState.index === slotIndex ? 'opacity-70 ring-1 ring-indigo-400/30' : ''
                                            }`}
                                          >
                                            <div className="flex items-center justify-between gap-3">
                                              <div className="flex items-center gap-3">
                                                {slot.hasMany ? (
                                                  <div
                                                    draggable
                                                    onDragStart={() => setDragState({ listId: slotFieldName, index: slotIndex })}
                                                    onDragEnd={() => setDragState(null)}
                                                    className="flex h-8 w-8 cursor-grab items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-zinc-500 active:cursor-grabbing"
                                                    title="Drag to reorder slot item"
                                                  >
                                                    <GripVertical size={14} />
                                                  </div>
                                                ) : null}
                                                <div>
                                                <div className="text-sm font-medium text-zinc-100">{presetEntry ? getPresetRecordLabel(presetEntry) : slotItem.presetId}</div>
                                                <div className="mt-1 text-xs text-zinc-400">{presetEntry ? getPresetComponentSlug(presetEntry) : 'Preset reference'}</div>
                                              </div>
                                              </div>
                                              <div className="flex items-center gap-2">
                                                {slot.hasMany ? (
                                                  <>
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      type="button"
                                                      onClick={() => openSlotPicker(slotFieldName, slotIndex)}
                                                    >
                                                      Add Above
                                                    </Button>
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      type="button"
                                                      onClick={() => openSlotPicker(slotFieldName, slotIndex + 1)}
                                                    >
                                                      Add Below
                                                    </Button>
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      type="button"
                                                      className="h-8 w-8 p-0"
                                                      onClick={() => reorderFieldArrayValue(slotApi, slotIndex, slotIndex - 1)}
                                                      disabled={slotIndex === 0}
                                                      title="Move slot item up"
                                                    >
                                                      <ArrowUp size={14} />
                                                    </Button>
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      type="button"
                                                      className="h-8 w-8 p-0"
                                                      onClick={() => reorderFieldArrayValue(slotApi, slotIndex, slotIndex + 1)}
                                                      disabled={slotIndex === slotItems.length - 1}
                                                      title="Move slot item down"
                                                    >
                                                      <ArrowDown size={14} />
                                                    </Button>
                                                  </>
                                                ) : null}
                                                <Button size="sm" variant="destructive" type="button" onClick={() => removeSlotValue(slot, slotApi, slotIndex)}>
                                                  Remove
                                                </Button>
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      }

                                      const componentDef = (slot.components || []).find((component: any) => component.slug === slotItem?.componentType);
                                      if (!componentDef) {
                                        return (
                                          <div key={`${slot.name}-unknown-${slotIndex}`} className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                                            Unknown component type: {slotItem?.componentType}
                                          </div>
                                        );
                                      }

                                      const componentBasePath = slot.hasMany ? `${slotFieldName}[${slotIndex}]` : slotFieldName;
                                      const slotCardCollapsed = isCardCollapsed(slotFieldName, slotIndex);
                                      const componentSummary = getComponentPreviewSummary(componentDef, slotItem, relationSupportEntries);
                                      return (
                                        <div
                                          key={`${slot.name}-${componentDef.slug}-${slotIndex}`}
                                          draggable={slot.hasMany}
                                          onDragStart={() => {
                                            if (slot.hasMany) {
                                              setDragState({ listId: slotFieldName, index: slotIndex });
                                            }
                                          }}
                                          onDragEnd={() => setDragState(null)}
                                          onDragOver={(event) => {
                                            if (slot.hasMany && dragState?.listId === slotFieldName && dragState.index !== slotIndex) {
                                              event.preventDefault();
                                            }
                                          }}
                                          onDrop={(event) => {
                                            event.preventDefault();
                                            if (slot.hasMany && dragState?.listId === slotFieldName && dragState.index !== slotIndex) {
                                              reorderFieldArrayValue(slotApi, dragState.index, slotIndex);
                                            }
                                            setDragState(null);
                                          }}
                                          className={`rounded-lg border border-white/5 bg-white/[0.02] p-4 ${
                                            dragState?.listId === slotFieldName && dragState.index === slotIndex ? 'opacity-70 ring-1 ring-indigo-400/30' : ''
                                          }`}
                                        >
                                          <div className="mb-4 flex items-center justify-between gap-3 border-b border-white/5 pb-3">
                                            <div className="flex items-center gap-3">
                                              {slot.hasMany ? (
                                                <div
                                                  draggable
                                                  onDragStart={() => setDragState({ listId: slotFieldName, index: slotIndex })}
                                                  onDragEnd={() => setDragState(null)}
                                                  className="flex h-8 w-8 cursor-grab items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-zinc-500 active:cursor-grabbing"
                                                  title="Drag to reorder slot item"
                                                >
                                                  <GripVertical size={14} />
                                                </div>
                                              ) : null}
                                              <div>
                                                <button
                                                  type="button"
                                                  onClick={() => toggleCardCollapsed(slotFieldName, slotIndex)}
                                                  className="flex items-center gap-2 text-left"
                                                >
                                                  {slotCardCollapsed ? <ChevronRight size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
                                                  <div className="text-xs font-bold uppercase tracking-widest text-zinc-400">{componentDef.name}</div>
                                                </button>
                                                <div className="mt-1 flex flex-wrap gap-2">
                                                  {componentDef.source?.library ? <span className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-500">{componentDef.source.library}</span> : null}
                                                  {componentSummary.map((summary: string, summaryIndex: number) => (
                                                    <span key={`${slotFieldName}-${slotIndex}-summary-${summaryIndex}`} className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-400">
                                                      {summary}
                                                    </span>
                                                  ))}
                                                </div>
                                              </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                              {slot.hasMany ? (
                                                <>
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    type="button"
                                                    onClick={() => openSlotPicker(slotFieldName, slotIndex)}
                                                  >
                                                    Add Above
                                                  </Button>
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    type="button"
                                                    onClick={() => openSlotPicker(slotFieldName, slotIndex + 1)}
                                                  >
                                                    Add Below
                                                  </Button>
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    type="button"
                                                    className="h-8 w-8 p-0"
                                                    onClick={() => reorderFieldArrayValue(slotApi, slotIndex, slotIndex - 1)}
                                                    disabled={slotIndex === 0}
                                                    title="Move slot item up"
                                                  >
                                                    <ArrowUp size={14} />
                                                  </Button>
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    type="button"
                                                    className="h-8 w-8 p-0"
                                                    onClick={() => reorderFieldArrayValue(slotApi, slotIndex, slotIndex + 1)}
                                                    disabled={slotIndex === slotItems.length - 1}
                                                    title="Move slot item down"
                                                  >
                                                    <ArrowDown size={14} />
                                                  </Button>
                                                </>
                                              ) : null}
                                              <Button size="sm" variant="destructive" type="button" onClick={() => removeSlotValue(slot, slotApi, slotIndex)}>
                                                Remove
                                              </Button>
                                            </div>
                                          </div>
                                          {!slotCardCollapsed ? (
                                          <div className="space-y-4">
                                            {componentDef.fields?.map((componentField: any) => (
                                              <FieldRenderer
                                                key={`${componentDef.slug}-${componentField.name}`}
                                                field={componentField}
                                                form={form}
                                                basePath={componentBasePath}
                                                relationOptions={relationOptions}
                                                relationSupportEntries={relationSupportEntries}
                                                collapseStorageKey={collapseStorageKey}
                                              />
                                            ))}
                                          </div>
                                          ) : null}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            }}
                          />
                        );
                      })}
                    </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        }}
      />
    );
  }

  if (field.type === 'group') {
    return (
      <div role="group" aria-labelledby={labelId} className="space-y-4 rounded-lg border border-white/10 bg-zinc-950/40 p-5 shadow-inner">
        <div className="border-b border-white/5 pb-3">
          <div id={labelId} className="text-sm font-medium text-zinc-300">{field.label}</div>
        </div>
        <div className="space-y-4">
          {field.fields?.map((subField: any) => (
            <FieldRenderer
              key={subField.name}
              field={subField}
              form={form}
              basePath={fieldName}
              relationOptions={relationOptions}
              relationSupportEntries={relationSupportEntries}
              collapseStorageKey={collapseStorageKey}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <form.Field
      name={fieldName}
      children={(fieldApi: any) => {
        const errorMessages = formatErrorMessages(fieldApi.state.meta.errors);
        const hasError = errorMessages.length > 0;
        const value = fieldApi.state.value;
        const describedBy = hasError ? errorId : undefined;
        // Shared by the native controls: the label names them, the error describes them.
        const controlProps = {
          id: controlId,
          'aria-invalid': hasError || undefined,
          'aria-describedby': describedBy,
          'aria-required': field.required || undefined,
        };
        // Relation pickers and rich text are not single form controls, so they take the label by id.
        const labelNamesGroup = isRelationshipFieldType(field.type) || field.type === 'richtext';

        return (
          <div className="space-y-2">
            {field.type !== 'boolean' ? (labelNamesGroup ? (
              <div id={labelId} className="block text-sm font-medium text-zinc-300">
                {field.label} {field.required ? <span aria-hidden="true" className="text-red-400">*</span> : null}
              </div>
            ) : (
              <label id={labelId} htmlFor={controlId} className="block text-sm font-medium text-zinc-300">
                {field.label} {field.required ? <span aria-hidden="true" className="text-red-400">*</span> : null}
              </label>
            )) : null}

            {field.type === 'textarea' ? (
              <textarea
                {...controlProps}
                value={(value as string) || ''}
                onChange={(event) => fieldApi.handleChange(event.target.value)}
                onBlur={fieldApi.handleBlur}
                className={`w-full rounded-md border bg-zinc-950/50 p-3 text-sm shadow-inner transition-all focus:outline-none focus:ring-2 ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:border-indigo-500/50 focus:ring-indigo-500/50'}`}
              />
            ) : field.type === 'select' ? (
              <select
                {...controlProps}
                value={(value as string) || ''}
                onChange={(event) => fieldApi.handleChange(event.target.value)}
                onBlur={fieldApi.handleBlur}
                className={`w-full rounded-md border bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:outline-none focus:ring-2 ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:border-indigo-500/50 focus:ring-indigo-500/50'}`}
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
                value={value}
                onChange={fieldApi.handleChange}
                onBlur={fieldApi.handleBlur}
                relationOptions={relationOptions}
                relationSupportEntries={relationSupportEntries}
                labelId={labelId}
                describedBy={describedBy}
              />
            ) : field.type === 'richtext' ? (
              <RichTextEditor
                value={value}
                onChange={(nextValue: any) => fieldApi.handleChange(nextValue)}
                hasError={hasError}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
              />
            ) : field.type === 'boolean' ? (
              <div className="flex items-center gap-2">
                <input
                  {...controlProps}
                  type="checkbox"
                  checked={!!value}
                  onChange={(event) => fieldApi.handleChange(event.target.checked)}
                  onBlur={fieldApi.handleBlur}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-indigo-500 focus:ring-indigo-500"
                />
                <label id={labelId} htmlFor={controlId} className="text-sm font-medium">
                  {field.label} {field.required ? <span aria-hidden="true" className="text-red-500">*</span> : null}
                </label>
              </div>
            ) : (
              <input
                {...controlProps}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                value={value !== undefined && value !== null ? (field.type === 'date' && typeof value === 'string' ? value.slice(0, 10) : (value as any)) : ''}
                // A cleared optional number is null, so saving clears it; a required one stays empty and shows "Required".
                onChange={(event) => fieldApi.handleChange(field.type === 'number' ? (event.target.value ? Number(event.target.value) : field.required ? undefined : null) : event.target.value)}
                onBlur={fieldApi.handleBlur}
                className={`w-full rounded-md border bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:outline-none focus:ring-2 ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:border-indigo-500/50 focus:ring-indigo-500/50'}`}
              />
            )}

            {hasError ? <p id={errorId} role="alert" className="text-xs text-red-500">{errorMessages.join(', ')}</p> : null}
          </div>
        );
      }}
    />
  );
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
    const relationOptions: Record<string, RelationOptionRecord[]> = {};
    const relationSupportEntries: RelationSupportEntries = {};

    if (globalConfig?.fields?.length) {
      const relationFields = collectRelationshipFields(globalConfig.fields);
      const relationTargets = [...new Set(relationFields.flatMap((field: any) => getRelationTargets(field)))];
      if (globalNeedsPresetEntries(globalConfig)) {
        relationTargets.push('_ui_component_presets');
      }

      // The related collections load in parallel, each one bounded page at a time.
      if (relationTargets.length > 0) {
        const collections = await fetchCollectionConfigs(adminBasePath).catch(() => [] as any[]);
        Object.assign(relationSupportEntries, await fetchEntriesBySlug(adminBasePath, relationTargets, collections));
      }

      for (const field of relationFields) {
        relationOptions[getRelationOptionKey(field)] = getRelationTargets(field).flatMap((relationTo) =>
          (relationSupportEntries[relationTo] || []).map((entry) => ({
            collectionSlug: relationTo,
            entry,
          }))
        );
      }
    }

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
              <div className="space-y-6">
                {schemaFields.map((field: any) => (
                  <FieldRenderer
                    key={field.name}
                    field={field}
                    form={form}
                    basePath=""
                    relationOptions={relationOptions}
                    relationSupportEntries={relationSupportEntries}
                    collapseStorageKey={collapseStorageKey}
                  />
                ))}
              </div>
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
