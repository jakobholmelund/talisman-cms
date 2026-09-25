import { collections as configuredCollections } from 'virtual:talisman-cms/config';
// @ts-ignore Virtual module is provided by the CMS integration.
import { adminLinks } from 'virtual:talisman-cms/config';

export type AdminSection = 'collections' | 'commerce';

type CollectionLike = {
  slug: string;
  adminSection?: AdminSection;
  access?: Partial<Record<'read' | 'create' | 'update' | 'delete', 'admin' | 'editor'>>;
  nativeSchemaMapping?: {
    schemaPath?: string;
  };
};

type AdminUserLike = { role?: string } | null | undefined;

type AdminExtensionLike = {
  path: string;
  section?: AdminSection | null;
  access?: 'admin' | 'editor';
};

export function getAdminSection(collection: CollectionLike): AdminSection {
  if (collection.adminSection) {
    return collection.adminSection;
  }

  if (
    collection.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema' ||
    collection.slug.startsWith('_ecommerce_')
  ) {
    return 'commerce';
  }

  return 'collections';
}

export function filterCollectionsBySection<T extends CollectionLike>(collections: T[], section: AdminSection) {
  return collections.filter((collection) => getAdminSection(collection) === section);
}

export function hasSection(section: AdminSection) {
  return configuredCollections.some((collection: any) => getAdminSection(collection) === section);
}

/** Mirrors the server's collection read check, so the admin only links to collections the user can open. */
export function canReadCollection(collection: Pick<CollectionLike, 'access'>, user: AdminUserLike) {
  return collection.access?.read !== 'admin' || user?.role === 'admin';
}

export function getReadableSectionCollections(section: AdminSection, user: AdminUserLike) {
  return configuredCollections.filter((collection: any) =>
    getAdminSection(collection) === section && canReadCollection(collection, user)
  ) as Array<CollectionLike & { name: string }>;
}

/**
 * Commerce tools call admin-only endpoints: an extension is admin-only when it declares so, sits in the
 * commerce section, or is linked from the commerce section's tools.
 */
export function isAdminOnlyExtension(extension: AdminExtensionLike) {
  if (extension.access === 'admin' || extension.section === 'commerce') return true;
  return (adminLinks as Array<{ section?: string; href?: string }>).some((link) =>
    link.section === 'commerce' &&
    /^\/(?:[^/?#]+\/)*extensions\/([^/?#]+)$/.exec(link.href || '')?.[1] === extension.path
  );
}

export function canOpenAdminExtension(extension: AdminExtensionLike, user: AdminUserLike) {
  return user?.role === 'admin' || !isAdminOnlyExtension(extension);
}

export function hasMediaCollection() {
  return configuredCollections.some((collection: any) => collection.slug === 'media');
}

export function isPagesCollection(collection: Pick<CollectionLike, 'slug'>) {
  return collection.slug === 'pages';
}

export function hasPagesCollection() {
  return configuredCollections.some((collection: any) => isPagesCollection(collection));
}

export function getSectionBasePath(section: AdminSection): '/commerce' | '/collections' {
  return section === 'commerce' ? '/commerce' : '/collections';
}

export function getSectionCollectionRoute(section: AdminSection): '/commerce/$slug' | '/collections/$slug' {
  return section === 'commerce' ? '/commerce/$slug' : '/collections/$slug';
}

export function getSectionEntryRoute(section: AdminSection): '/commerce/$slug/$entryId' | '/collections/$slug/$entryId' {
  return section === 'commerce' ? '/commerce/$slug/$entryId' : '/collections/$slug/$entryId';
}

export function getSectionTitle(section: AdminSection) {
  return section === 'commerce' ? 'Commerce' : 'Data Collections';
}

export function getSectionDescription(section: AdminSection) {
  return section === 'commerce'
    ? 'Manage products, catalog structure, inventory, and orders.'
    : 'Manage your defined schemas, tables, and documents.';
}

export function getEmptyStateCopy(section: AdminSection) {
  return section === 'commerce'
    ? {
        title: 'No commerce models registered',
        body: 'Enable the ecommerce plugin or tag a collection with `adminSection: "commerce"`.'
      }
    : {
        title: 'No collections defined yet',
        body: 'Create a new schema to get started.'
      };
}
