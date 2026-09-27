import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { getAdminSection } from '../../../lib/admin-sections';
import { CollectionEntryEditor } from '../../../components/editor/CollectionEntryEditor';
import { loadEntryEditorData } from '../../../lib/entry-editor-data';

export const Route = createFileRoute('/commerce/$slug/$entryId')({
  component: CommerceEntryEditorRoute,
  loader: async ({ params, context }) => {
    const data = await loadEntryEditorData(context.adminBasePath || '/admin', params.slug, params.entryId);

    if (!data.collection || getAdminSection(data.collection) !== 'commerce') {
      throw new Error('Commerce collection not found');
    }

    return data;
  },
  // Same as /collections/$slug/$entryId: the editor keeps its own copy after saving, so never reuse a cached load.
  gcTime: 0,
});

function CommerceEntryEditorRoute() {
  const { collection, entry, revisions, isNew, relationOptions, relationSupportEntries } = Route.useLoaderData();
  const { slug, entryId } = Route.useParams();
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
      section="commerce"
    />
  );
}
