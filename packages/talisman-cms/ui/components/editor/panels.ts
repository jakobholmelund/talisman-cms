// The contract between the entry editor and the panels plugins add to it (Plugin.adminEditorPanels).
// Types only, plus the pure matching rule, so a plugin can import this without the editor.
import type { RelationSupportEntries } from '../fields/relations';

/** What an editor panel's default export receives. */
export type AdminEditorPanelProps = {
  /** The collection's client config, with its fields. */
  collection: any;
  /** The saved record as last loaded or saved; null while a new record has not been saved. */
  entry: any | null;
  isNew: boolean;
  /** The form's current values, updated as the user types. */
  values: Record<string, any>;
  /** The loaded records of related collections, by collection slug. */
  relationSupportEntries: RelationSupportEntries;
  /**
   * Loads these collections again and replaces them in `relationSupportEntries`; the panel renders
   * again with the result. Rejects when a read is refused, so a panel never mistakes that for empty.
   */
  refreshSupportEntries: (slugs: string[]) => Promise<void>;
  /** The admin API base path, such as `/admin`. */
  basePath: string;
  /** The section the editor was opened under: `collections` or a registered section id. */
  section: string;
  user: { role?: string; email?: string } | null;
};

export type AdminEditorPanelPlacement = 'before-fields' | 'after-form';

export type AdminEditorPanelLike = {
  id: string;
  placement: AdminEditorPanelPlacement;
  sections?: string[] | null;
  slugs?: string[] | null;
};

/**
 * A panel matches a collection by the section the collection belongs to or by its slug; a panel with
 * neither list matches every collection.
 */
export function panelMatchesCollection(panel: AdminEditorPanelLike, collectionSlug: string, collectionSection: string) {
  const sections = panel.sections || [];
  const slugs = panel.slugs || [];
  if (sections.length === 0 && slugs.length === 0) return true;
  return sections.includes(collectionSection) || slugs.includes(collectionSlug);
}
