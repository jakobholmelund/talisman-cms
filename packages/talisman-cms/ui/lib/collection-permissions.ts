import type { CollectionConfig } from '../../src/types';
import { canAccessCollection } from '../../src/auth/collection-access';
import { isMediaCollection } from '../../src/db/media-policy';

type CollectionPolicy = Pick<CollectionConfig, 'access' | 'readOnly' | 'nativeSchemaMapping'>;
type CmsUser = { role?: string } | null | undefined;

/** Mirror the user-actor rules, including upload-only media creation and native records' workflow. */
export function getCollectionPermissions(collection: CollectionPolicy | null | undefined, user: CmsUser) {
  const admin = user?.role === 'admin';
  const staff = admin || user?.role === 'editor';
  const allowed = (operation: 'read' | 'create' | 'update' | 'delete') =>
    Boolean(collection && staff && canAccessCollection(collection, { role: admin ? 'admin' : 'editor' }, operation));
  const canRead = allowed('read');
  const writable = canRead && !collection?.readOnly;
  const canUpdate = writable && allowed('update');
  const canUpload = writable && allowed('create');
  const media = Boolean(collection && isMediaCollection(collection));
  const canTransition = canUpdate && admin && !collection?.nativeSchemaMapping;
  return {
    canRead,
    canCreate: canUpload && !media,
    canUpdate,
    canDelete: writable && admin && allowed('delete'),
    canPublish: canTransition,
    canArchive: canTransition,
    canRestore: canTransition,
    canUpload: canUpload && media,
  };
}

/** Explain why a list or editor has no write controls, without obscuring the readable content. */
export function getCollectionWriteNotice(collection: CollectionPolicy | null | undefined, user: CmsUser, operation: 'create' | 'update') {
  if (!collection) return null;
  const permissions = getCollectionPermissions(collection, user);
  if (collection.readOnly) return 'This collection is managed by server code and is read-only in the CMS.';
  if (operation === 'create' && isMediaCollection(collection)) {
    return 'Media records are created by uploading a file to the media library.';
  }
  if (operation === 'create' ? permissions.canCreate : permissions.canUpdate) return null;
  return operation === 'create'
    ? 'Only administrators can create entries in this collection.'
    : 'You can view this entry. Only administrators can save changes in this collection.';
}
