// Route loaders need relationship metadata without loading the editor's validation schemas.
import { getRelationOptionKey } from '../../src/relationship-fields';
export { getRelationOptionKey, getRelationTargets, isPolymorphicRelationField, isRelationReference } from '../../src/relationship-fields';
export type { RelationReference } from '../../src/types';

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

