import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { getAdminSection } from '../../../lib/admin-sections';
import { CollectionEntryEditor, loadEntryEditorData } from '../../collections/$slug/$entryId';

export const Route = createFileRoute('/commerce/$slug/$entryId')({
  component: CommerceEntryEditorRoute,
  loader: async ({ params, context }) => {
    const data = await loadEntryEditorData(context.adminBasePath || '/admin', params.slug, params.entryId);

    if (!data.collection || getAdminSection(data.collection) !== 'commerce') {
      throw new Error('Commerce collection not found');
    }

    return data;
  },
});

function CommerceEntryEditorRoute() {
  const { collection, entry, revisions, isNew, relationOptions, relationSupportEntries } = Route.useLoaderData();
  const { slug, entryId } = Route.useParams();
  const routerContext = Route.useRouteContext();

  return (
    <CollectionEntryEditor
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
