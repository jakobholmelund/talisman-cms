import React, { Suspense } from 'react';
import { createFileRoute, notFound } from '@tanstack/react-router';
import {
  canReadCollection,
  filterCollectionsBySection,
  getRegisteredSection,
  getSectionAdminLinks,
  type AdminSectionCollection,
} from '../../lib/admin-sections';
import { fetchCollectionConfigs } from '../../lib/admin-api';
import { CollectionSectionPage } from '../collections/index';

export const Route = createFileRoute('/$section/')({
  component: SectionIndexRoute,
  loader: async ({ params, context }) => {
    const section = getRegisteredSection(params.section);
    if (!section) throw notFound();
    // Item counts change, so this screen always asks the server (which also refreshes the shared copy).
    const collections = await fetchCollectionConfigs(context.adminBasePath || '/admin', { fresh: true })
      .catch(() => { throw new Error(`Could not load the ${section.label} collections`); });
    return filterCollectionsBySection(collections as AdminSectionCollection[], section.id)
      .filter((collection) => canReadCollection(collection, context.user));
  },
});

function SectionIndexRoute() {
  const collections = Route.useLoaderData();
  const { section: sectionId } = Route.useParams();
  const context = Route.useRouteContext();
  const section = getRegisteredSection(sectionId);
  if (!section) return null;

  const Workspace = section.workspace;
  if (!Workspace) return <CollectionSectionPage collections={collections} section={section.id} />;

  // The workspace is the plugin's own chunk; it loads when the section is first opened.
  return (
    <Suspense fallback={<p className="text-sm text-zinc-400">Loading {section.label}...</p>}>
      <Workspace
        section={section}
        collections={collections}
        adminLinks={getSectionAdminLinks(section.id)}
        adminBasePath={context.adminBasePath || '/admin'}
        user={context.user}
      />
    </Suspense>
  );
}
