import { a as TalismanUser } from '../types-C5a-hx5D.js';
import { C as CollectionConfig } from '../types-BdxRwCLu.js';
import 'astro';
import '../actor-Daa_hmny.js';
import '../types-CqOBvOgc.js';

type CollectionOperation = 'read' | 'create' | 'update' | 'delete';
/** A collection may require an administrator for each generic CMS operation. */
declare function canAccessCollection(collection: Pick<CollectionConfig, 'access'>, user: Pick<TalismanUser, 'role'>, operation: CollectionOperation): boolean;

export { type CollectionOperation, canAccessCollection };
