import { z } from 'zod';
import {
  getRelationOptionKey,
  getRelationTargets,
  isPolymorphicRelationField,
  normalizeComponentSlotValue,
  normalizeDataForFields,
  isRelationReference,
  type RelationReference,
  type ComponentPresetReference,
} from '../../src/types';

export const relationReferenceClientSchema = z.object({
  relationTo: z.string(),
  value: z.string(),
});

const componentPresetReferenceClientSchema = z.object({
  mode: z.literal('preset'),
  presetId: z.string(),
});

export function isRelationshipFieldType(type: string | undefined) {
  return type === 'relationship' || type === 'relation';
}

export function collectRelationshipFields(fields: any[] | undefined, collected = new Map<string, any>()) {
  if (!fields) return Array.from(collected.values());

  for (const field of fields) {
    if (isRelationshipFieldType(field.type) && field.relationTo) {
      collected.set(getRelationOptionKey(field), field);
    }

    if ((field.type === 'array' || field.type === 'group') && field.fields) {
      collectRelationshipFields(field.fields, collected);
    }

    if (field.type === 'blocks' && field.blocks) {
      for (const block of field.blocks) {
        collectRelationshipFields(block.fields, collected);
        for (const slot of block.componentSlots || []) {
          for (const component of slot.components || []) {
            collectRelationshipFields(component.fields, collected);
          }
        }
      }
    }
  }

  return Array.from(collected.values());
}

function getZodClientSchemaForComponentSlots(slots: any[] | undefined) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const slot of slots || []) {
    const inlineSchemas =
      slot.allowInline !== false && slot.components?.length
        ? slot.components.map((component: any) =>
            getZodClientSchemaForFields(component.fields).extend({
              mode: z.literal('inline'),
              componentType: z.literal(component.slug),
            })
          )
        : [];

    let itemSchema: z.ZodTypeAny;
    if (inlineSchemas.length === 0 && !slot.allowReferences) {
      itemSchema = z.any();
    } else if (inlineSchemas.length === 0) {
      itemSchema = componentPresetReferenceClientSchema;
    } else if (!slot.allowReferences) {
      itemSchema = inlineSchemas.length > 1
        ? z.discriminatedUnion('componentType', inlineSchemas as any)
        : inlineSchemas[0];
    } else if (inlineSchemas.length === 1) {
      itemSchema = z.discriminatedUnion('mode', [inlineSchemas[0], componentPresetReferenceClientSchema] as any);
    } else {
      itemSchema = z.union(([
        ...inlineSchemas,
        componentPresetReferenceClientSchema,
      ] as unknown) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }

    shape[slot.name] = slot.hasMany
      ? z.preprocess((value) => normalizeComponentSlotValue(slot, value), z.array(itemSchema))
      : z.preprocess((value) => normalizeComponentSlotValue(slot, value), itemSchema.nullable().optional());
  }

  return shape;
}

export function getZodClientSchemaForFields(fields: any[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!fields) return z.object({}).passthrough();

  for (const field of fields) {
    let schema: z.ZodTypeAny;

    switch (field.type) {
      case 'number':
        schema = z.number();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'date':
        schema = z.union([z.string().datetime(), z.date(), z.string(), z.string().length(0)]).optional();
        break;
      case 'richtext':
        schema = z.any();
        break;
      case 'select':
        schema = field.options?.length ? z.enum(field.options as [string, ...string[]]) : z.string();
        break;
      case 'relationship':
      case 'relation':
        if (isPolymorphicRelationField(field)) {
          schema = field.hasMany ? z.array(relationReferenceClientSchema) : relationReferenceClientSchema;
        } else {
          schema = field.hasMany ? z.array(z.string()) : z.string();
        }
        break;
      case 'group':
        schema = field.fields ? getZodClientSchemaForFields(field.fields) : z.object({}).passthrough();
        break;
      case 'array':
        schema = field.fields ? z.array(getZodClientSchemaForFields(field.fields)) : z.array(z.any());
        break;
      case 'blocks':
        if (field.blocks && field.blocks.length > 0) {
          const blockSchemas = field.blocks.map((block: any) =>
            getZodClientSchemaForFields(block.fields)
              .extend(getZodClientSchemaForComponentSlots(block.componentSlots))
              .extend({
                blockType: z.literal(block.slug),
              })
          );
          schema = blockSchemas.length > 1
            ? z.array(z.discriminatedUnion('blockType', blockSchemas as any))
            : z.array(blockSchemas[0]);
        } else {
          schema = z.array(z.any());
        }
        break;
      default:
        schema = z.string();
        break;
    }

    if (!field.required && field.type !== 'array' && field.type !== 'blocks') {
      schema = schema.optional().nullable().or(z.literal(''));
    } else if (field.type === 'text' || field.type === 'textarea') {
      schema = (schema as z.ZodString).min(1, 'Required');
    } else if (field.type === 'select' || field.type === 'richtext') {
      schema = schema.refine((value: any) => !!value, { message: 'Required' });
    }

    shape[field.name] = schema;
  }

  return z.object(shape).passthrough();
}

export function getPresetClientSchema(editorFields: any[], componentFields: any[] | undefined) {
  const topLevelFields = editorFields.filter((field: any) => field.name !== 'propsJson');
  return getZodClientSchemaForFields(topLevelFields).extend({
    presetProps: componentFields ? getZodClientSchemaForFields(componentFields) : z.object({}).passthrough(),
  }).passthrough();
}

export function normalizeStoredFieldData(fields: any[] | undefined, value: any) {
  return normalizeDataForFields(fields, value);
}

export function createDefaultValueForField(field: any) {
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }

  if (field.type === 'boolean') return false;
  if (field.type === 'array' || field.type === 'blocks') return [];
  if (field.type === 'group') return buildDefaultValues(field.fields);
  if (isRelationshipFieldType(field.type) && field.hasMany) return [];

  return '';
}

export function createDefaultValueForComponentSlot(slot: any) {
  return slot.hasMany ? [] : null;
}

export function buildDefaultValues(fields: any[] | undefined) {
  const defaults: Record<string, any> = {};
  if (!fields) return defaults;

  for (const field of fields) {
    defaults[field.name] = createDefaultValueForField(field);
  }

  return defaults;
}

export function buildInlineComponentValue(component: any) {
  return {
    mode: 'inline',
    componentType: component.slug,
    ...buildDefaultValues(component.fields),
  };
}

export function buildPresetReferenceValue(presetId: string): ComponentPresetReference {
  return {
    mode: 'preset',
    presetId,
  };
}

export function buildBlockValue(block: any) {
  const slotDefaults = Object.fromEntries(
    (block.componentSlots || []).map((slot: any) => [slot.name, createDefaultValueForComponentSlot(slot)])
  );

  return {
    blockType: block.slug,
    ...buildDefaultValues(block.fields),
    ...slotDefaults,
  };
}

export function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

export function insertArrayItem<T>(items: T[], index: number, item: T) {
  const nextItems = [...items];
  const insertIndex = Math.max(0, Math.min(index, nextItems.length));
  nextItems.splice(insertIndex, 0, item);
  return nextItems;
}

function parseEntryData(entry: any) {
  if (!entry?.data) return {};
  return typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
}

function getEntrySummaryLabel(entry: any) {
  const data = parseEntryData(entry);
  return data?.title || data?.name || entry?.title || entry?.name || entry?.slug || entry?.id || 'Linked record';
}

function getMediaSummaryLabel(value: any) {
  if (!value) return null;

  if (typeof value === 'object') {
    return value.filename || value.altText || value.title || value.name || value.url || 'Media selected';
  }

  if (typeof value !== 'string') {
    return 'Media selected';
  }

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:')) return 'Inline media';

  const withoutQuery = trimmed.split('?')[0];
  const segments = withoutQuery.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'Media selected';
}

function getRelationSummaryLabel(field: any, value: any, relationSupportEntries: Record<string, any[]> | undefined) {
  const relationTargets = getRelationTargets(field);
  if (relationTargets.length === 0 || value === undefined || value === null || value === '') {
    return null;
  }

  const selections = (Array.isArray(value) ? value : [value]).flatMap((item: any) => {
    if (isPolymorphicRelationField(field) && isRelationReference(item)) {
      return [{ relationTo: item.relationTo, value: item.value }];
    }

    if (typeof item === 'string') {
      return relationTargets[0] ? [{ relationTo: relationTargets[0], value: item }] : [];
    }

    if (isRelationReference(item)) {
      return [{ relationTo: relationTargets[0], value: item.value }];
    }

    if (item && typeof item === 'object' && typeof item.id === 'string') {
      return relationTargets[0] ? [{ relationTo: relationTargets[0], value: item.id }] : [];
    }

    return [];
  });

  if (selections.length === 0) {
    return null;
  }

  const labels = selections.map((selection) => {
    const entry = (relationSupportEntries?.[selection.relationTo] || []).find((candidate: any) => candidate.id === selection.value);
    return entry ? getEntrySummaryLabel(entry) : selection.value;
  });

  if (labels.length === 1) {
    return labels[0];
  }

  return `${labels[0]} +${labels.length - 1}`;
}

function summarizePrimitiveField(field: any, value: any, relationSupportEntries?: Record<string, any[]>) {
  if (value === undefined || value === null || value === '') return null;

  if (field.type === 'text' || field.type === 'textarea' || field.type === 'select') {
    const text = String(value).trim();
    if (!text) return null;
    return text.length > 48 ? `${text.slice(0, 48)}...` : text;
  }

  if (field.type === 'number') {
    return String(value);
  }

  if (field.type === 'date') {
    const text = String(value).trim();
    return text ? text.slice(0, 10) : null;
  }

  if (field.type === 'boolean') {
    return value ? field.label : null;
  }

  if (field.type === 'media') {
    return getMediaSummaryLabel(value);
  }

  if (isRelationshipFieldType(field.type)) {
    return getRelationSummaryLabel(field, value, relationSupportEntries);
  }

  return null;
}

export function summarizeConfiguredFields(fields: any[] | undefined, data: any, limit = 3, relationSupportEntries?: Record<string, any[]>) {
  const summaries: string[] = [];

  for (const field of fields || []) {
    if (summaries.length >= limit) break;
    const value = data?.[field.name];

    if (field.type === 'group' && field.fields) {
      const nested = summarizeConfiguredFields(field.fields, value, limit - summaries.length, relationSupportEntries);
      summaries.push(...nested);
      continue;
    }

    if (field.type === 'array') {
      if (Array.isArray(value) && value.length > 0) {
        summaries.push(`${value.length} ${field.label.toLowerCase()}`);
      }
      continue;
    }

    const summary = summarizePrimitiveField(field, value, relationSupportEntries);
    if (summary) {
      summaries.push(summary);
    }
  }

  return summaries.slice(0, limit);
}

export function getBlockPreviewSummary(block: any, value: any, relationSupportEntries?: Record<string, any[]>) {
  const parts = summarizeConfiguredFields(block?.fields, value, 3, relationSupportEntries);

  for (const slot of block?.componentSlots || []) {
    if (parts.length >= 3) break;
    const slotItems = getComponentSlotItems(slot, value?.[slot.name]);
    if (slotItems.length > 0) {
      parts.push(`${slot.label}: ${slotItems.length}`);
    }
  }

  return parts;
}

export function getComponentPreviewSummary(component: any, value: any, relationSupportEntries?: Record<string, any[]>) {
  return summarizeConfiguredFields(component?.fields, value, 3, relationSupportEntries);
}

export function getCollapsedCardsStorageKey(scopeKey: string | undefined, fieldName: string) {
  if (!scopeKey) return null;
  return `${scopeKey}:${fieldName}`;
}

export function readCollapsedCardsState(storageKey: string | null) {
  if (!storageKey || typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeCollapsedCardsState(storageKey: string | null, value: Record<string, boolean>) {
  if (!storageKey || typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Ignore storage failures; collapse state is best-effort.
  }
}

export function groupBlocksByCategory(blocks: any[] | undefined) {
  const groups = new Map<string, any[]>();

  for (const block of blocks || []) {
    const category = block.category || 'Custom';
    const current = groups.get(category) || [];
    current.push(block);
    groups.set(category, current);
  }

  return Array.from(groups.entries()).map(([category, groupedBlocks]) => ({
    category,
    blocks: groupedBlocks,
  }));
}

export function groupComponentsByLibraryAndCategory(components: any[] | undefined) {
  const byLibrary = new Map<string, Map<string, any[]>>();

  for (const component of components || []) {
    const library = component.source?.library || 'Custom';
    const category = component.category || 'Components';
    const libraryGroups = byLibrary.get(library) || new Map<string, any[]>();
    const categoryItems = libraryGroups.get(category) || [];
    categoryItems.push(component);
    libraryGroups.set(category, categoryItems);
    byLibrary.set(library, libraryGroups);
  }

  return Array.from(byLibrary.entries()).map(([library, categories]) => ({
    library,
    categories: Array.from(categories.entries()).map(([category, items]) => ({
      category,
      components: items,
    })),
  }));
}

export function getComponentSlotItems(slot: any, value: any) {
  if (slot?.hasMany) {
    return Array.isArray(value) ? value : [];
  }

  return value ? [value] : [];
}

export function isPresetReferenceValue(value: any): value is ComponentPresetReference {
  return value?.mode === 'preset' && typeof value?.presetId === 'string';
}

export function getPresetComponentSlug(preset: any) {
  let data = preset?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  return data?.componentSlug || '';
}

export function getPresetRecordLabel(preset: any) {
  let data = preset?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  return data?.name || preset?.title || preset?.slug || preset?.id || 'Preset';
}

export { getRelationOptionKey, getRelationTargets, isPolymorphicRelationField, isRelationReference };
export type { RelationReference };
