import React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Button } from '../../components/ui/button';
import { ChevronRight, Plus, Database } from 'lucide-react';
import { filterCollectionsBySection, getEmptyStateCopy, getSectionCollectionLink, getSectionDescription, getSectionTitle, isPagesCollection, type AdminSection } from '../../lib/admin-sections';
import { fetchCollectionConfigs } from '../../lib/admin-api';

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

export function CollectionSectionPage({
  collections,
  section
}: {
  collections: any[];
  section: AdminSection;
}) {
  const navigate = useNavigate();
  const emptyState = getEmptyStateCopy(section);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white shadow-sm">{getSectionTitle(section)}</h1>
          <p className="text-zinc-400 mt-2 text-sm leading-relaxed max-w-2xl">{getSectionDescription(section)}</p>
        </div>
        <Button className="gap-2 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] transition-all duration-300 border-0" disabled>
          <Plus size={16} strokeWidth={2.5} /> New Collection
        </Button>
      </div>

      <Card className="overflow-hidden border-white/10 bg-zinc-950/50 backdrop-blur-2xl shadow-xl">
        <Table>
          <TableHeader className="bg-white/[0.02] hover:bg-white/[0.02] border-b border-white/5">
            <TableRow className="border-none hover:bg-transparent">
              <TableHead className="w-[300px] text-zinc-400 font-medium">Name</TableHead>
              <TableHead className="text-zinc-400 font-medium">Slug</TableHead>
              <TableHead className="text-zinc-400 font-medium">Items</TableHead>
              <TableHead className="text-right text-zinc-400 font-medium">Created</TableHead>
              <TableHead className="w-[50px]"><span className="sr-only">Open</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collections.length === 0 ? (
              <TableRow className="border-b border-white/5 hover:bg-white/[0.01]">
                <TableCell colSpan={5} className="text-center text-zinc-500 py-12">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <Database size={24} className="text-zinc-600 mb-2" />
                    <span className="text-sm font-medium text-zinc-400">{emptyState.title}</span>
                    <span className="text-xs text-zinc-500">{emptyState.body}</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              collections.map((col: any) => (
                <TableRow 
                  key={col.id} 
                  className="cursor-pointer border-b border-white/5 hover:bg-white/[0.04] transition-colors duration-200 group"
                  onClick={() => {
                    navigate(getSectionCollectionLink(section, col.slug));
                  }}
                >
                  <TableCell className="font-medium text-zinc-100 group-hover:text-indigo-400 transition-colors">
                    {/* The name is a real link, so the row can be reached and opened from the keyboard. */}
                    <Link
                      {...getSectionCollectionLink(section, col.slug)}
                      onClick={(event) => event.stopPropagation()}
                      className="flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                    >
                      <span aria-hidden="true" className="p-1.5 rounded-md bg-white/5 group-hover:bg-indigo-500/10 transition-colors">
                        <Database size={14} className="text-zinc-400 group-hover:text-indigo-400" />
                      </span>
                      {col.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono bg-zinc-900 border border-white/10 text-zinc-400 shadow-sm">
                      {col.slug}
                    </span>
                  </TableCell>
                  <TableCell className="text-zinc-400">
                    <span className="inline-flex items-center justify-center min-w-[2rem] h-6 rounded-full bg-white/5 text-xs font-medium text-zinc-300">
                      {col.itemCount ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-zinc-400 text-sm">
                    {new Date(col.createdAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric'
                    })}
                  </TableCell>
                  <TableCell>
                    <ChevronRight aria-hidden="true" size={14} className="text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function CollectionsIndexRoute() {
  return <CollectionSectionPage collections={Route.useLoaderData()} section="collections" />;
}
