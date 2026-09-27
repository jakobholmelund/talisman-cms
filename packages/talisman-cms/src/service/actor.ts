import { canAccessCollection, type CollectionOperation } from '../auth/collection-access';
import type { TalismanUser } from '../auth/types';
import { isMediaCollection } from '../db/media-policy';
import type { CollectionConfig } from '../types';
import { AccessDeniedError } from './errors';

/**
 * Who is calling the service. A `user` is the admin API's signed-in editor or administrator, and
 * the authorization rules apply to it. `system` is server code that already holds the bindings
 * (the SDK's default), which the rules cannot lock out. `plugin` is reserved for Plugin API v2 and
 * is treated like `system` until then.
 */
export type Actor =
  | { kind: 'user'; user: TalismanUser; request: Request }
  | { kind: 'system'; label?: string; request?: Request }
  | { kind: 'plugin'; plugin: string; user?: TalismanUser; request?: Request };

export const systemActor = (label?: string): Actor => ({ kind: 'system', label });
export const userActor = (user: TalismanUser, request: Request): Actor => ({ kind: 'user', user, request });

/** The role an actor acts with: a user's own; trusted server code acts as an administrator. */
export function actorRole(actor: Actor): TalismanUser['role'] {
  return actor.kind === 'user' ? actor.user.role : 'admin';
}

export type ActorOperation = CollectionOperation | 'publish' | 'archive' | 'restore';

/**
 * The authorization rules, checked once per operation and before any row is read. They apply to
 * `user` actors: a collection's `access` per operation, `readOnly`, the operations kept to
 * administrators (delete, publish, archive, restore) and the media collection's records, which
 * only uploads create. The messages are the admin API's.
 */
export function assertAllowed(actor: Actor, collection: CollectionConfig, operation: ActorOperation): void {
  if (actor.kind !== 'user') return;
  const { user } = actor;
  const transition = operation === 'publish' || operation === 'archive' || operation === 'restore';
  if ((operation === 'delete' || transition) && user.role !== 'admin') {
    throw new AccessDeniedError('Admin access required');
  }
  if (!canAccessCollection(collection, user, transition ? 'update' : operation)) {
    throw new AccessDeniedError('Collection access denied');
  }
  if (operation !== 'read' && collection.readOnly) {
    throw new AccessDeniedError(transition ? 'Collection access denied' : 'This collection is read-only');
  }
  if (operation === 'create' && isMediaCollection(collection)) {
    throw new AccessDeniedError('Media records are created by uploading a file to the media library.');
  }
}

/**
 * Whether the actor's reads may embed entries of this collection as relation targets. Site reads
 * run as `system` and embed what an editor may read, so a collection only administrators may read
 * stays ids on the public site.
 */
export function canRead(actor: Actor, collection: Pick<CollectionConfig, 'access'>): boolean {
  return canAccessCollection(collection, actor.kind === 'user' ? actor.user : { role: 'editor' }, 'read');
}
