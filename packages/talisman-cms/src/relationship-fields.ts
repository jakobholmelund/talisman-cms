// Lightweight relationship helpers shared by server types and admin route loaders.
import type { FieldDefinition, RelationReference } from './types';

export function getRelationTargets(field?: Pick<FieldDefinition, 'relationTo'> | null) {
  if (!field?.relationTo) return [];
  return Array.isArray(field.relationTo) ? field.relationTo : [field.relationTo];
}

export function isPolymorphicRelationField(field?: Pick<FieldDefinition, 'relationTo'> | null) {
  return getRelationTargets(field).length > 1;
}

export function getRelationOptionKey(field?: Pick<FieldDefinition, 'name' | 'relationTo'> | null) {
  const targets = getRelationTargets(field).sort();
  return `${field?.name || 'relation'}:${targets.join('|')}`;
}

export function isRelationReference(value: unknown): value is RelationReference {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'relationTo' in value &&
      'value' in value &&
      typeof (value as RelationReference).relationTo === 'string' &&
      typeof (value as RelationReference).value === 'string'
  );
}

