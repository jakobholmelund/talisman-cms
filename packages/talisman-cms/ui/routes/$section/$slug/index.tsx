import React from 'react';
import { validateCollectionListSearch } from '../../../lib/collection-list';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { getAdminSection } from '../../../lib/admin-sections';
import { CollectionEntriesPage } from '../../../components/collections/CollectionEntriesPage';
import { loadCollectionEntriesData } from '../../../lib/collection-list-data';

export const Route = createFileRoute('/$section/$slug/')({
  component: SectionEntriesRoute,
  validateSearch: validateCollectionListSearch,
  loaderDeps: ({ search }) => search,
  gcTime: 0,
  loader: async ({ params, context, deps, abortController }) => {
    const data = await loadCollectionEntriesData(context.adminBasePath || '/admin', params.slug, deps, abortController.signal);

    // The section layout shows this as a collection the section does not have.
    if (!data.collection || getAdminSection(data.collection) !== params.section) {
      throw notFound({ data: { collection: params.slug } });
    }

    return data;
  },
});

function SectionEntriesRoute() {
  const { collection, entries, hasNextPage, listSearch, listError } = Route.useLoaderData();
  const { section, slug } = Route.useParams();

  return <CollectionEntriesPage collection={collection} entries={entries} hasNextPage={hasNextPage} listSearch={listSearch} listError={listError} slug={slug} section={section} />;
}
