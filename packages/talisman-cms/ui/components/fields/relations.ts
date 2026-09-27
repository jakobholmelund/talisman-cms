import {
  collectRelationshipFields,
  getRelationOptionKey,
  getRelationTargets,
  isPolymorphicRelationField,
  isRelationReference,
  type RelationReference,
} from '../../lib/page-builder';

/** A record a relation field can point at, with the collection it belongs to. */
export type RelationOptionRecord = {
  collectionSlug: string;
  entry: any;
};

/** The selectable records of each relation field, keyed by getRelationOptionKey(field). */
export type RelationOptions = Record<string, RelationOptionRecord[]>;

/** Loaded records by collection slug: relation targets, commerce options and stock, component presets. */
export type RelationSupportEntries = Record<string, any[]>;

/** Whether a blocks field has a component slot that accepts saved presets, which the editor then loads. */
export function fieldsNeedPresetEntries(fields: any[] | undefined) {
  return (fields || []).some((field: any) =>
    field.type === 'blocks' &&
    (field.blocks || []).some((block: any) =>
      (block.componentSlots || []).some((slot: any) => slot.allowReferences)
    )
  );
}

/** The selectable records of every relation field in `fields`, taken from the loaded collections. */
export function buildRelationOptions(fields: any[] | undefined, entriesBySlug: RelationSupportEntries): RelationOptions {
  const relationOptions: RelationOptions = {};
  for (const field of collectRelationshipFields(fields)) {
    relationOptions[getRelationOptionKey(field)] = getRelationTargets(field).flatMap((relationTo) =>
      (entriesBySlug[relationTo] || []).map((entry) => ({
        collectionSlug: relationTo,
        entry,
      }))
    );
  }
  return relationOptions;
}

/** The stored value of a relation field as references, whichever shape it was saved in. */
export function normalizeRelationSelections(field: any, value: any): RelationReference[] {
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

/** The value to store: ids, or references for a polymorphic field; a list when the field hasMany. */
export function serializeRelationSelections(field: any, selections: RelationReference[]) {
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

export function getRelationSelectionKey(selection: RelationReference) {
  return `${selection.relationTo}:${selection.value}`;
}

export function getRelationOptionsForField(field: any, relationOptions: RelationOptions) {
  return relationOptions[getRelationOptionKey(field)] || [];
}
