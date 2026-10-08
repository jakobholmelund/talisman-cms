import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { filterCollectionsBySection, isPagesCollection } from '../../lib/admin-sections';
import { fetchCollectionConfigs } from '../../lib/admin-api';
import { CollectionSectionPage } from '../../components/collections/CollectionSectionPage';

export const Route = createFileRoute('/collections/')({
  component: CollectionsIndexRoute,
  loader: async ({ context }) => {
    // We already have `adminBasePath` injected into the router context
    const adminBasePath = context.adminBasePath || '/admin';
    // Item counts change, so this screen always asks the server (which also refreshes the shared copy).
    const collections = await fetchCollectionConfigs(adminBasePath, { fresh: true }) as Array<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      createdAt: string;
      itemCount: number | null;
    }>;

    return filterCollectionsBySection(collections, 'collections').filter(
      (collection) => collection.slug !== 'media' && !isPagesCollection(collection)
    );
  }
});

function CollectionsIndexRoute() {
  return <CollectionSectionPage collections={Route.useLoaderData()} section="collections" />;
}
