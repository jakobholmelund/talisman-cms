import React from 'react';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { getAdminSection } from '../../../lib/admin-sections';
import { CollectionEntriesPage, loadCollectionEntriesData } from '../../collections/$slug/index';

export const Route = createFileRoute('/$section/$slug/')({
  component: SectionEntriesRoute,
  loader: async ({ params, context }) => {
    const data = await loadCollectionEntriesData(context.adminBasePath || '/admin', params.slug);

    // The section layout shows this as a collection the section does not have.
    if (!data.collection || getAdminSection(data.collection) !== params.section) {
      throw notFound({ data: { collection: params.slug } });
    }

    return data;
  },
});

function SectionEntriesRoute() {
  const { collection, entries, nextCursor } = Route.useLoaderData();
  const { section, slug } = Route.useParams();

  return <CollectionEntriesPage collection={collection} entries={entries} nextCursor={nextCursor} slug={slug} section={section} />;
}
