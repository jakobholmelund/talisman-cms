import type { TalismanUser } from './types';
import type { CollectionConfig } from '../types';

export type CollectionOperation = 'read' | 'create' | 'update' | 'delete';

/** A collection may require an administrator for each generic CMS operation. */
export function canAccessCollection(
  collection: Pick<CollectionConfig, 'access'>,
  user: Pick<TalismanUser, 'role'>,
  operation: CollectionOperation,
): boolean {
  return collection.access?.[operation] !== 'admin' || user.role === 'admin';
}
