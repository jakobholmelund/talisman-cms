// How the admin names a record: a describer module a plugin registered (Plugin.adminEntryDescribers)
// answers first, else a generic description from the record's own fields. This module has no
// imports, so it can be tested alone; entry-describers.ts wires in the registered modules.

export type EntryLike = {
  id: string;
  slug?: string;
  data?: Record<string, any> | string | null;
};

/** Loaded records by collection slug. */
export type EntriesBySlug = Record<string, EntryLike[]>;

export type EntryDescription = {
  title: string;
  subtitle: string;
  details: string[];
};

/** What a describer may ask the admin for. */
export type EntryDescriberContext = {
  /** The value of a setting the plugin exposed with `adminSettings`, by its name without `TALISMAN_`; null when unset. */
  readSetting: (name: string) => string | null;
};

/** The shape of a module named by `Plugin.adminEntryDescribers`. Both exports are optional. */
export type EntryDescriberModule = {
  /** A description of a record it knows, or null for any other record. */
  describeEntry?: (
    collectionSlug: string,
    entry: EntryLike,
    entriesBySlug: EntriesBySlug,
    context: EntryDescriberContext
  ) => EntryDescription | null | undefined;
  /** Extra collections the editor of `collectionSlug` loads, so descriptions can name related records. */
  supportCollections?: (collectionSlug: string, relationTargets: string[]) => string[] | null | undefined;
};

export function getEntryData(entry: EntryLike | null | undefined): Record<string, any> {
  if (!entry?.data) return {};
  return typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? null;
}

/**
 * The setting value the admin page renders as `<meta name="talisman-setting-<name in kebab case>">`
 * for a plugin's `adminSettings`; null outside a browser, without the tag, or when it is empty.
 */
export function readAdminSetting(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const metaName = `talisman-setting-${name.toLowerCase().replace(/_/g, '-')}`;
  const content = document.querySelector(`meta[name="${metaName}"]`)?.getAttribute('content')?.trim();
  return content ? content : null;
}

/** The description of a record from its own fields, when no describer knows it. */
export function describeEntryGeneric(entry: EntryLike | null | undefined): EntryDescription {
  if (!entry) return { title: 'Unknown record', subtitle: '', details: [] };
  const data = getEntryData(entry);
  const title = firstText(data.name, data.title, data.value, data.label, data.slug, entry.slug, entry.id) ?? String(entry.id);
  const subtitle = [
    firstText(data.slug) ? `/${data.slug}` : null,
    firstText(data.sku) ? `SKU ${data.sku}` : null,
  ].filter((part): part is string => Boolean(part)).join(' • ');
  return { title, subtitle, details: [] };
}

/** The first describer that answers, else the generic description. */
export function describeEntryWith(
  describers: EntryDescriberModule[],
  collectionSlug: string,
  entry: EntryLike | null | undefined,
  entriesBySlug: EntriesBySlug,
  context: EntryDescriberContext = { readSetting: readAdminSetting }
): EntryDescription {
  if (entry) {
    for (const describer of describers) {
      const description = describer.describeEntry?.(collectionSlug, entry, entriesBySlug, context);
      if (description) {
        return {
          title: description.title || String(entry.id),
          subtitle: description.subtitle || '',
          details: Array.isArray(description.details) ? description.details : [],
        };
      }
    }
  }
  return describeEntryGeneric(entry);
}

/** The relation targets plus every collection the describers want loaded next to a `collectionSlug` entry. */
export function getSupportCollectionSlugsWith(describers: EntryDescriberModule[], collectionSlug: string, relationTargets: string[] = []) {
  const slugs = new Set<string>(relationTargets);
  for (const describer of describers) {
    for (const slug of describer.supportCollections?.(collectionSlug, [...relationTargets]) || []) {
      if (typeof slug === 'string' && slug) slugs.add(slug);
    }
  }
  return Array.from(slugs);
}

/** One line for an option list: the title, then the subtitle when there is one. */
export function getEntryOptionLabel(description: EntryDescription) {
  return [description.title, description.subtitle].filter((part) => part && part.trim()).join(' - ');
}
