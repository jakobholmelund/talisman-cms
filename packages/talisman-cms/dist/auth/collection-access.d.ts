import { a as TalismanUser } from '../types-B9Ys5hZL.js';
import { C as CollectionConfig } from '../types-ENgZDEOO.js';
import 'astro';

type CollectionOperation = 'read' | 'create' | 'update' | 'delete';
/** A collection may require an administrator for each generic CMS operation. */
declare function canAccessCollection(collection: Pick<CollectionConfig, 'access'>, user: Pick<TalismanUser, 'role'>, operation: CollectionOperation): boolean;

export { type CollectionOperation, canAccessCollection };
