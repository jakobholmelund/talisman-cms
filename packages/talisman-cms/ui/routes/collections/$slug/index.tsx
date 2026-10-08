import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { validateCollectionListSearch } from '../../../lib/collection-list';
import { loadCollectionEntriesData } from '../../../lib/collection-list-data';
import { CollectionEntriesPage } from '../../../components/collections/CollectionEntriesPage';

export const Route = createFileRoute('/collections/$slug/')({
  component: CollectionsEntriesRoute,
  validateSearch: validateCollectionListSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ params, context, deps, abortController }) => loadCollectionEntriesData(context.adminBasePath || '/admin', params.slug, deps, abortController.signal),
  gcTime: 0,
});

function CollectionsEntriesRoute() {
  const { collection, entries, hasNextPage, listSearch, listError } = Route.useLoaderData();
  const { slug } = Route.useParams();

  return <CollectionEntriesPage collection={collection} entries={entries} hasNextPage={hasNextPage} listSearch={listSearch} listError={listError} slug={slug} section="collections" />;
}
