import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { getAdminSection } from '../../../lib/admin-sections';
import { CollectionEntriesPage, loadCollectionEntriesData } from '../../collections/$slug/index';

export const Route = createFileRoute('/commerce/$slug/')({
  component: CommerceEntriesRoute,
  loader: async ({ params, context }) => {
    const data = await loadCollectionEntriesData(context.adminBasePath || '/admin', params.slug);

    if (!data.collection || getAdminSection(data.collection) !== 'commerce') {
      throw new Error('Commerce collection not found');
    }

    return data;
  },
});

function CommerceEntriesRoute() {
  const { collection, entries } = Route.useLoaderData();
  const { slug } = Route.useParams();

  return <CollectionEntriesPage collection={collection} entries={entries} slug={slug} section="commerce" />;
}
