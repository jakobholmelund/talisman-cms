import React from 'react';
import { Outlet, createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { canOpenAdminSection, getRegisteredSection } from '../lib/admin-sections';

// The layout of a plugin section (Plugin.adminSections). The static routes (/collections, /globals,
// /media, ...) rank above this one, so only registered section ids reach it.
export const Route = createFileRoute('/$section')({
  loader: ({ params }) => {
    if (!getRegisteredSection(params.section)) throw notFound();
  },
  component: SectionLayout,
  notFoundComponent: SectionNotFound,
});

// Also shown for a collection that is not in the section (the child routes throw notFound with its slug).
function SectionNotFound({ data }: { data?: unknown }) {
  const { section } = Route.useParams();
  const collectionSlug = (data as { collection?: string } | undefined)?.collection;
  const definition = getRegisteredSection(section);
  return (
    <div className="flex flex-col items-center justify-center p-12 text-zinc-400">
      <h2 className="text-xl font-medium text-white mb-2">{collectionSlug && definition ? 'Collection Not Found' : 'Section Not Found'}</h2>
      <p>
        {collectionSlug && definition
          ? `${definition.label} has no collection called "${collectionSlug}".`
          : `No plugin registers an admin section called "${section}".`}
      </p>
    </div>
  );
}

function SectionLayout() {
  const { section: sectionId } = Route.useParams();
  const { context } = useRouter().options;
  const section = getRegisteredSection(sectionId);

  if (section && !canOpenAdminSection(section, context.user)) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-zinc-400">
        <h2 className="text-xl font-medium text-white mb-2">Admin access required</h2>
        <p>{section.label} is available to admins only.</p>
      </div>
    );
  }

  return <Outlet />;
}
