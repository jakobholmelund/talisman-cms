import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CollectionEntryEditor } from '../../../components/editor/CollectionEntryEditor';
import { loadEntryEditorData } from '../../../lib/entry-editor-data';

export const Route = createFileRoute('/collections/$slug/$entryId')({
  component: CollectionsEntryEditorRoute,
  loader: async ({ params, context }) => loadEntryEditorData(context.adminBasePath || '/admin', params.slug, params.entryId),
  // The editor keeps its own copy of the entry after saving, so a cached load would be stale when the
  // user comes back; always load the entry afresh instead.
  gcTime: 0,
});

function CollectionsEntryEditorRoute() {
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
      section="collections"
    />
  );
}
