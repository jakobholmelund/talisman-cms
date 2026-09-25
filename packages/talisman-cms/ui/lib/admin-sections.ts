import { collections as configuredCollections } from 'virtual:talisman-cms/config';

export type AdminSection = 'collections' | 'commerce';

type CollectionLike = {
  slug: string;
  adminSection?: AdminSection;
  nativeSchemaMapping?: {
    schemaPath?: string;
  };
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
