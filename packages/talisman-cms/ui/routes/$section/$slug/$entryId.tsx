import React from 'react';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { getAdminSection } from '../../../lib/admin-sections';
import { CollectionEntryEditor } from '../../../components/editor/CollectionEntryEditor';
import { loadEntryEditorData } from '../../../lib/entry-editor-data';

export const Route = createFileRoute('/$section/$slug/$entryId')({
  component: SectionEntryEditorRoute,
  loader: async ({ params, context }) => {
    const data = await loadEntryEditorData(context.adminBasePath || '/admin', params.slug, params.entryId);

    // The section layout shows this as a collection the section does not have.
    if (!data.collection || getAdminSection(data.collection) !== params.section) {
      throw notFound({ data: { collection: params.slug } });
    }

    return data;
  },
  // Same as /collections/$slug/$entryId: the editor keeps its own copy after saving, so never reuse a cached load.
  gcTime: 0,
});

function SectionEntryEditorRoute() {
  const { collection, entry, revisions, isNew, relationOptions, relationSupportEntries } = Route.useLoaderData();
  const { section, slug, entryId } = Route.useParams();
  const routerContext = Route.useRouteContext();

  // Keyed by entry so a different entry (including a new entry after its first save) starts from fresh state.
  return (
    <CollectionEntryEditor
      key={`${slug}:${entryId}`}
      collection={collection}
      entry={entry}
      revisions={revisions}
      isNew={isNew}
      relationOptions={relationOptions}
      relationSupportEntries={relationSupportEntries}
      slug={slug}
      entryId={entryId}
      basePath={routerContext.adminBasePath || '/admin'}
      section={section}
    />
  );
}
