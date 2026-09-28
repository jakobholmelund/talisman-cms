import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import { normalizeEntryDataForRead } from '../versioning';
import { getRelationTargets, isInlineComponentValue, isPolymorphicRelationField, isRelationReference } from '../types';
import { canRead } from './actor';
import { resolveCollection, type ResolvedCollection } from './collections';
import type { ServiceContext } from './context';
import { NotFoundError } from './errors';

export type VersionMode = 'draft' | 'published';

function isRelationshipFieldType(type: string | undefined) {
  return type === 'relationship' || type === 'relation';
}

function getNormalizedSlotItems(slot: any, value: any) {
  if (slot?.hasMany) {
    return Array.isArray(value) ? value : [];
  }

  return value ? [value] : [];
}

function collectComponentSlotRelationshipIds(
  blockValue: any,
  slots: any[] | undefined,
  idsByRelation: Map<string, Set<string>>
) {
  for (const slot of slots || []) {
    const slotValue = blockValue?.[slot.name];
    const items = getNormalizedSlotItems(slot, slotValue);

    for (const item of items) {
      if (!isInlineComponentValue(item)) continue;
      const componentDef = (slot.components || []).find((component: any) => component.slug === item.componentType);
      if (componentDef?.fields) {
        collectRelationshipIds(item, componentDef.fields, idsByRelation);
      }
    }
  }
}

function applyResolvedRelationshipsToComponentSlots(
  blockValue: any,
  slots: any[] | undefined,
  docsByRelation: Map<string, Map<string, any>>
) {
  for (const slot of slots || []) {
    const slotValue = blockValue?.[slot.name];
    const items = getNormalizedSlotItems(slot, slotValue);

    for (const item of items) {
      if (!isInlineComponentValue(item)) continue;
      const componentDef = (slot.components || []).find((component: any) => component.slug === item.componentType);
      if (componentDef?.fields) {
        applyResolvedRelationships(item, componentDef.fields, docsByRelation);
      }
    }
  }
}

function collectRelationshipIds(
  value: any,
  fields: any[] | undefined,
  idsByRelation: Map<string, Set<string>>
) {
  if (!value || !fields) return;

  for (const field of fields) {
    const fieldValue = value?.[field.name];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') continue;

    if (isRelationshipFieldType(field.type) && field.relationTo) {
      if (isPolymorphicRelationField(field)) {
        const refs = Array.isArray(fieldValue) ? fieldValue : [fieldValue];

        for (const ref of refs) {
          if (!isRelationReference(ref)) continue;
          const ids = idsByRelation.get(ref.relationTo) || new Set<string>();
          ids.add(ref.value);
          idsByRelation.set(ref.relationTo, ids);
        }
      } else {
        const relationSlug = getRelationTargets(field)[0];
        if (!relationSlug) continue;

        const ids = idsByRelation.get(relationSlug) || new Set<string>();

        if (Array.isArray(fieldValue)) {
          for (const id of fieldValue) {
            if (typeof id === 'string') ids.add(id);
          }
        } else if (typeof fieldValue === 'string') {
          ids.add(fieldValue);
        } else if (isRelationReference(fieldValue)) {
          ids.add(fieldValue.value);
        }

        idsByRelation.set(relationSlug, ids);
      }
      continue;
    }

    if (field.type === 'array' && field.fields && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (item && typeof item === 'object') {
          collectRelationshipIds(item, field.fields, idsByRelation);
        }
      }
      continue;
    }

    if (field.type === 'group' && field.fields && fieldValue && typeof fieldValue === 'object') {
      collectRelationshipIds(fieldValue, field.fields, idsByRelation);
      continue;
    }

    if (field.type === 'blocks' && field.blocks && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (!item || typeof item !== 'object') continue;

        const blockDef = field.blocks.find((block: any) => block.slug === item.blockType);
        if (blockDef?.fields) {
          collectRelationshipIds(item, blockDef.fields, idsByRelation);
        }
        if (blockDef?.componentSlots) {
          collectComponentSlotRelationshipIds(item, blockDef.componentSlots, idsByRelation);
        }
      }
    }
  }
}

function applyResolvedRelationships(
  value: any,
  fields: any[] | undefined,
  docsByRelation: Map<string, Map<string, any>>
) {
  if (!value || !fields) return;

  for (const field of fields) {
    const fieldValue = value?.[field.name];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') continue;

    if (isRelationshipFieldType(field.type) && field.relationTo) {
      if (isPolymorphicRelationField(field)) {
        const refs = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
        const resolvedRefs = refs.map((ref: any) => {
          if (!isRelationReference(ref)) return ref;
          const docsById = docsByRelation.get(ref.relationTo);
          return docsById?.get(ref.value) || ref;
        });

        value[field.name] = Array.isArray(fieldValue) ? resolvedRefs : resolvedRefs[0];
      } else {
        const relationSlug = getRelationTargets(field)[0];
        const docsById = relationSlug ? docsByRelation.get(relationSlug) : null;
        if (!docsById) continue;

        if (Array.isArray(fieldValue)) {
          value[field.name] = fieldValue.map((id: any) => {
            if (typeof id === 'string') return docsById.get(id) || id;
            if (isRelationReference(id)) return docsById.get(id.value) || id;
            return id;
          });
        } else if (typeof fieldValue === 'string') {
          value[field.name] = docsById.get(fieldValue) || fieldValue;
        } else if (isRelationReference(fieldValue)) {
          value[field.name] = docsById.get(fieldValue.value) || fieldValue;
        }
      }
      continue;
    }

    if (field.type === 'array' && field.fields && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (item && typeof item === 'object') {
          applyResolvedRelationships(item, field.fields, docsByRelation);
        }
      }
      continue;
    }

    if (field.type === 'group' && field.fields && fieldValue && typeof fieldValue === 'object') {
      applyResolvedRelationships(fieldValue, field.fields, docsByRelation);
      continue;
    }

    if (field.type === 'blocks' && field.blocks && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (!item || typeof item !== 'object') continue;

        const blockDef = field.blocks.find((block: any) => block.slug === item.blockType);
        if (blockDef?.fields) {
          applyResolvedRelationships(item, blockDef.fields, docsByRelation);
        }
        if (blockDef?.componentSlots) {
          applyResolvedRelationshipsToComponentSlots(item, blockDef.componentSlots, docsByRelation);
        }
      }
    }
  }
}

// D1 binds at most 100 parameters per statement; the collection and status filters take two.
const RELATION_ID_CHUNK_SIZE = 90;

/** The fields relations are read from: the deployed configuration first, then the stored copy. */
function relationFields(collection: ResolvedCollection): any[] | null {
  if (collection.activeFields.length > 0) return collection.activeFields;
  const stored = collection.record.fields;
  return typeof stored === 'string' ? JSON.parse(stored) : (stored as any[] | null);
}

async function findRelatedEntries(ctx: ServiceContext, targetCollectionId: string, ids: string[], versionMode: VersionMode) {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += RELATION_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + RELATION_ID_CHUNK_SIZE));
  }

  const results = await Promise.all(chunks.map((chunk) => ctx.db.select().from(schema.entries).where(and(
    eq(schema.entries.collectionId, targetCollectionId), inArray(schema.entries.id, chunk),
    ...(versionMode === 'published' ? [eq(schema.entries.status, 'published')] : [])))));
  return results.flat();
}

/**
 * Embeds the entries that relation fields point at, `depth` levels down, in chunks D1 accepts.
 * A target the actor may not read (a collection only administrators may read, on a site read)
 * stays as ids, and so does a target collection that does not exist.
 */
export async function resolveRelationships(
  ctx: ServiceContext,
  entriesToResolve: any[],
  collection: ResolvedCollection,
  depth = 1,
  versionMode: VersionMode = 'published'
): Promise<any[]> {
  if (depth <= 0 || !entriesToResolve || entriesToResolve.length === 0) return entriesToResolve;

  const fieldsConfig = relationFields(collection);
  if (!fieldsConfig) return entriesToResolve;
  const resolvedEntries = entriesToResolve.map((entry) => {
    const normalized = normalizeEntryDataForRead(entry, versionMode);
    return { ...normalized, data: typeof normalized.data === 'string' ? JSON.parse(normalized.data) : normalized.data };
  });

  const idsByRelation = new Map<string, Set<string>>();
  for (const entry of resolvedEntries) {
    collectRelationshipIds(entry.data, fieldsConfig || [], idsByRelation);
  }

  if (idsByRelation.size === 0) return resolvedEntries;

  const docsByRelation = new Map<string, Map<string, any>>();

  for (const [relationSlug, idsToFetch] of idsByRelation.entries()) {
    const targetConfig = ctx.config.collections.find((candidate) => candidate.slug === relationSlug);
    if (targetConfig && !canRead(ctx.actor, targetConfig)) continue;

    let targetCollection: ResolvedCollection;
    try {
      targetCollection = await resolveCollection(ctx, relationSlug);
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      throw error;
    }
    if (idsToFetch.size === 0) continue;

    let relatedDocs = await findRelatedEntries(ctx, targetCollection.record.id, Array.from(idsToFetch), versionMode);

    relatedDocs = relatedDocs.map((doc: any) => normalizeEntryDataForRead(doc, versionMode));

    if (depth > 1) {
      relatedDocs = await resolveRelationships(ctx, relatedDocs, targetCollection, depth - 1, versionMode);
    } else {
      relatedDocs = relatedDocs.map((r: any) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
    }

    docsByRelation.set(relationSlug, new Map(relatedDocs.map((r: any) => [r.id, r])));
  }

  for (const entry of resolvedEntries) {
    applyResolvedRelationships(entry.data, fieldsConfig || [], docsByRelation);
  }
  
  return resolvedEntries;
}
