// The admin's sections: Collections is built in, and plugins register others (Plugin.adminSections),
// each with its own sidebar entry, routes and, optionally, a workspace page. Everything section
// specific is read from the registered definition, so the core knows no section by name.
import type { ComponentType, LazyExoticComponent } from 'react';
import { collections as configuredCollections, adminLinks } from 'virtual:talisman-cms/config';
import { adminSections as registeredSections } from 'virtual:talisman-cms/admin-extensions';

/** A section id: `collections`, or the id of a registered section. */
export type AdminSection = string;

export const COLLECTIONS_SECTION: AdminSection = 'collections';

export type AdminLink = { section: AdminSection; label: string; description: string; href: string };

type CollectionLike = {
  slug: string;
  name?: string;
  adminSection?: AdminSection;
  access?: Partial<Record<'read' | 'create' | 'update' | 'delete', 'admin' | 'editor'>>;
  nativeSchemaMapping?: {
    schemaPath?: string;
    exportName?: string;
  };
};

export type AdminUserLike = { role?: string; email?: string } | null | undefined;

type AdminExtensionLike = {
  path: string;
  section?: AdminSection | null;
  access?: 'admin' | 'editor';
};

/** A section as the admin renders it: the registered definition with defaults, or the built-in Collections. */
export type AdminSectionDefinition = {
  id: AdminSection;
  /** The sidebar entry and back links. */
  label: string;
  /** The heading of the section's index page. */
  title: string;
  description: string;
  icon: string | null;
  adminOnly: boolean;
  emptyState: { title: string; body: string };
  /** The registering plugin; null for the built-in section. */
  plugin: string | null;
  /** The section's index page, or null for the generic collection table. */
  workspace: LazyExoticComponent<ComponentType<AdminSectionWorkspaceProps>> | null;
};

/** A collection as the section index lists it: the client config with the server's item count. */
export type AdminSectionCollection = CollectionLike & {
  id?: string;
  name: string;
  description?: string | null;
  itemCount: number | null;
  readOnly?: boolean;
};

/** What a section's workspace component (AdminSectionDefinition.componentPath) receives. */
export type AdminSectionWorkspaceProps = {
  section: AdminSectionDefinition;
  /** The section's collections the signed-in user may open, with their item counts. */
  collections: AdminSectionCollection[];
  /** The plugin links (Plugin.adminLinks) registered for this section. */
  adminLinks: AdminLink[];
  adminBasePath: string;
  user: AdminUserLike;
};

const collectionsSection: AdminSectionDefinition = {
  id: COLLECTIONS_SECTION,
  label: 'Collections',
  title: 'Data Collections',
  description: 'Manage your defined schemas, tables, and documents.',
  icon: null,
  adminOnly: false,
  emptyState: { title: 'No collections defined yet', body: 'Create a new schema to get started.' },
  plugin: null,
  workspace: null,
};

const sections: AdminSectionDefinition[] = registeredSections.map((section) => ({
  id: section.id,
  label: section.label,
  title: section.label,
  description: section.description || '',
  icon: section.icon,
  adminOnly: section.adminOnly,
  emptyState: section.emptyState || {
    title: `No ${section.label} collections registered`,
    body: `Tag a collection with adminSection: "${section.id}" to list it here.`,
  },
  plugin: section.plugin,
  workspace: section.workspace as AdminSectionDefinition['workspace'],
}));

/** The sections plugins registered, in registration order. */
export function getRegisteredSections() {
  return sections;
}

export function getRegisteredSection(id: AdminSection | null | undefined) {
  return id ? sections.find((section) => section.id === id) || null : null;
}

export function isRegisteredSection(id: AdminSection | null | undefined) {
  return getRegisteredSection(id) !== null;
}

/** The built-in Collections section or a registered one; null for an unknown id. */
export function getAdminSectionDefinition(id: AdminSection): AdminSectionDefinition | null {
  return id === COLLECTIONS_SECTION ? collectionsSection : getRegisteredSection(id);
}

/** The section a collection is listed in: its `adminSection` when a plugin registered it, else Collections. */
export function getAdminSection(collection: CollectionLike): AdminSection {
  return isRegisteredSection(collection.adminSection) ? collection.adminSection! : COLLECTIONS_SECTION;
}

export function filterCollectionsBySection<T extends CollectionLike>(collections: T[], section: AdminSection) {
  return collections.filter((collection) => getAdminSection(collection) === section);
}

/** True when a collection is in the section or the section has a workspace page of its own. */
export function hasSection(section: AdminSection) {
  return configuredCollections.some((collection: any) => getAdminSection(collection) === section) ||
    Boolean(getRegisteredSection(section)?.workspace);
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

/** An admin-only section and its tools need the admin role; every other section is open to editors too. */
export function canOpenAdminSection(section: Pick<AdminSectionDefinition, 'adminOnly'>, user: AdminUserLike) {
  return !section.adminOnly || user?.role === 'admin';
}

export function getSectionAdminLinks(section: AdminSection): AdminLink[] {
  return (adminLinks as AdminLink[]).filter((link) => link.section === section);
}

/** The extension path an admin link points at, when it links to a plugin admin page. */
export function getAdminLinkExtensionPath(href: string) {
  return /^\/(?:[^/?#]+\/)*extensions\/([^/?#]+)$/.exec(href || '')?.[1] ?? null;
}

/**
 * An extension is admin-only when it declares so, sits in an admin-only section, or is linked from
 * an admin-only section's tools, which call admin-only endpoints.
 */
export function isAdminOnlyExtension(extension: AdminExtensionLike) {
  if (extension.access === 'admin' || getRegisteredSection(extension.section)?.adminOnly) return true;
  return (adminLinks as AdminLink[]).some((link) =>
    getRegisteredSection(link.section)?.adminOnly && getAdminLinkExtensionPath(link.href) === extension.path
  );
}

export function canOpenAdminExtension(extension: AdminExtensionLike, user: AdminUserLike) {
  return user?.role === 'admin' || !isAdminOnlyExtension(extension);
}

/** True when the extension is listed by a registered section's workspace rather than the sidebar. */
export function isSectionExtension(extension: AdminExtensionLike) {
  return isRegisteredSection(extension.section);
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

// Every section, Collections included, is addressed through the `/$section` routes, so one typed link
// serves them all; the URL of the built-in section (/collections/...) matches its static routes.

export function getSectionIndexLink(section: AdminSection) {
  return { to: '/$section' as const, params: { section } };
}

export function getSectionCollectionLink(section: AdminSection, slug: string) {
  return { to: '/$section/$slug' as const, params: { section, slug } };
}

export function getSectionEntryLink(section: AdminSection, slug: string, entryId: string) {
  return { to: '/$section/$slug/$entryId' as const, params: { section, slug, entryId } };
}

export function getSectionLabel(section: AdminSection) {
  return getAdminSectionDefinition(section)?.label ?? section;
}

export function getSectionTitle(section: AdminSection) {
  return getAdminSectionDefinition(section)?.title ?? section;
}

export function getSectionDescription(section: AdminSection) {
  return getAdminSectionDefinition(section)?.description ?? '';
}

export function getEmptyStateCopy(section: AdminSection) {
  return getAdminSectionDefinition(section)?.emptyState ?? collectionsSection.emptyState;
}
