import React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card } from '../../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { Button } from '../../../components/ui/button';
import { Plus, MoreHorizontal, ArrowLeft } from 'lucide-react';
import { getSectionBasePath, getSectionEntryRoute, type AdminSection } from '../../../lib/admin-sections';

export const Route = createFileRoute('/collections/$slug/')({
  component: CollectionsEntriesRoute,
  loader: async ({ params, context }) => loadCollectionEntriesData(context.adminBasePath || '/admin', params.slug),
});

export async function loadCollectionEntriesData(basePath: string, slug: string) {
  const [collectionRes, entriesRes] = await Promise.all([
    fetch(`${basePath}/api/collections`),
    fetch(`${basePath}/api/collections/${slug}/entries`)
  ]);

  if (!collectionRes.ok || !entriesRes.ok) {
    throw new Error('Failed to fetch data');
  }

  const collections = await collectionRes.json() as any[];
  const collection = collections.find((item: any) => item.slug === slug);
  const entries = await entriesRes.json() as any[];

  return { collection, entries };
}

function parseEntryData(entry: any) {
  if (!entry?.data) return {};
  return typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
}

function getPageUrl(slug: string) {
  if (!slug || slug === 'index') return '/';
  return `/${slug}`;
}

function formatEntryStatus(status: string | undefined) {
  if (!status) return 'Draft';
  return status.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
}

function getStatusBadgeClass(status: string | undefined) {
  if (['published', 'active', 'paid', 'fulfilled', 'confirmed'].includes(status || '')) {
    return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  }

  if (['archived', 'suspended', 'pending', 'partially_refunded'].includes(status || '')) {
    return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
  }

  if (['cancelled', 'void', 'refunded', 'failed'].includes(status || '')) {
    return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
  }

  return 'bg-zinc-800/80 text-zinc-300 border-zinc-700 shadow-none';
}

export function CollectionEntriesPage({
  collection,
  entries,
  slug,
  section
}: {
  collection: any;
  entries: any[];
  slug: string;
  section: AdminSection;
}) {
  const navigate = useNavigate();
  const sectionBasePath = getSectionBasePath(section);
  const sectionEntryRoute = getSectionEntryRoute(section);
  const entryLabel = collection?.nativeSchemaMapping ? 'record' : 'entry';
  const isPagesCollection = slug === 'pages';
  const isProductsCollection = collection?.nativeSchemaMapping?.exportName === 'products';

  if (!collection) {
    return <div>Collection not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 text-zinc-400 mb-2">
        <Link to={sectionBasePath} className="hover:text-white transition-colors flex items-center gap-1 text-sm bg-white/5 px-2.5 py-1 rounded-md backdrop-blur-sm border border-white/5 hover:bg-white/10 hover:border-white/10">
          <ArrowLeft size={14} /> Back to {section === 'commerce' ? 'Commerce' : 'Collections'}
        </Link>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white shadow-sm">{collection.name}</h1>
          <p className="text-zinc-400 mt-2 text-sm leading-relaxed max-w-2xl">
            {collection.description || `Manage ${collection.nativeSchemaMapping ? 'records' : 'content'} for ${collection.name}.`}
          </p>
        </div>
        {!collection.readOnly && <Link to={sectionEntryRoute} params={{ slug, entryId: 'new' }}>
          <Button className="gap-2 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] transition-all duration-300 border-0">
            <Plus size={16} strokeWidth={2.5} /> {isProductsCollection ? 'Add product' : `Create ${entryLabel}`}
          </Button>
        </Link>}
      </div>

      <Card className="overflow-hidden border-white/10 bg-zinc-950/50 backdrop-blur-2xl shadow-xl">
        <Table>
          <TableHeader className="bg-white/[0.02] hover:bg-white/[0.02] border-b border-white/5">
            <TableRow className="border-none hover:bg-transparent">
              <TableHead className="w-[300px] text-zinc-400 font-medium">
                {isPagesCollection ? 'Page' : isProductsCollection ? 'Product' : collection.nativeSchemaMapping ? 'Record' : 'Entry'}
              </TableHead>
              {isPagesCollection && <TableHead className="text-zinc-400 font-medium">URL</TableHead>}
              <TableHead className="text-zinc-400 font-medium">Status</TableHead>
              {isPagesCollection && <TableHead className="text-zinc-400 font-medium">Sections</TableHead>}
              <TableHead className="text-right text-zinc-400 font-medium">Last Updated</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow className="border-b border-white/5 hover:bg-white/[0.01]">
                <TableCell colSpan={isPagesCollection ? 6 : 4} className="text-center text-zinc-500 py-16">
                  <div className="flex flex-col items-center justify-center space-y-4">
                    <div className="p-4 bg-white/5 rounded-full border border-white/5 shadow-inner">
                      <MoreHorizontal size={24} className="text-zinc-500" />
                    </div>
                    <p className="text-sm font-medium text-zinc-300">No {entryLabel}s found for {collection.name}.</p>
                    {!collection.readOnly && <Link to={sectionEntryRoute} params={{ slug, entryId: 'new' }}>
                      <Button variant="outline" size="sm" className="mt-2 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/10">
                        {isProductsCollection ? 'Add the first product' : `Create the first ${entryLabel}`}
                      </Button>
                    </Link>}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry: any) => {
                const data = parseEntryData(entry);
                const pageTitle = typeof data.title === 'string' && data.title.length > 0 ? data.title : 'Untitled page';
                const entryName = [data.name, data.customerEmail, data.email, data.code, data.value]
                  .find(value => typeof value === 'string' && value.length > 0)
                  || (slug === '_ecommerce_orders' ? `Order ${String(entry.id).slice(-8)}` : entry.slug);
                const displayStatus = collection.nativeSchemaMapping && !('status' in data) ? 'record' : entry.status;
                const pageUrl = getPageUrl(entry.slug);
                const sectionCount = Array.isArray(data.layout) ? data.layout.length : 0;

                return (
                  <TableRow 
                    key={entry.id}
                    className="cursor-pointer border-b border-white/5 hover:bg-white/[0.04] transition-colors duration-200 group"
                    onClick={() => {
                      navigate({ to: sectionEntryRoute, params: { slug, entryId: entry.id } });
                    }}
                  >
                    <TableCell>
                      {isPagesCollection ? (
                        <>
                          <div className="font-medium text-zinc-100 group-hover:text-indigo-400 transition-colors flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700 group-hover:bg-indigo-400 transition-colors" />
                            {pageTitle}
                          </div>
                          <div className="text-xs text-zinc-500 mt-1 ml-3.5 tracking-tight group-hover:text-zinc-400 transition-colors">
                            {entry.slug}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="font-medium text-zinc-100 group-hover:text-indigo-400 transition-colors flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700 group-hover:bg-indigo-400 transition-colors" />
                            {entryName}
                          </div>
                          <div className="text-xs text-zinc-500 font-mono mt-1 ml-3.5 tracking-tight group-hover:text-zinc-400 transition-colors">{entry.slug}</div>
                        </>
                      )}
                    </TableCell>
                    {isPagesCollection && (
                      <TableCell>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono bg-zinc-900 border border-white/10 text-zinc-300 shadow-sm">
                          {pageUrl}
                        </span>
                      </TableCell>
                    )}
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border shadow-sm ${getStatusBadgeClass(displayStatus)}`}>
                        {formatEntryStatus(displayStatus)}
                      </span>
                    </TableCell>
                    {isPagesCollection && (
                      <TableCell className="text-zinc-400">
                        <span className="inline-flex items-center justify-center min-w-[2rem] h-6 rounded-full bg-white/5 text-xs font-medium text-zinc-300">
                          {sectionCount}
                        </span>
                      </TableCell>
                    )}
                    <TableCell className="text-right text-zinc-400 text-sm group-hover:text-zinc-300 transition-colors">
                      {new Date(entry.updatedAt).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric'
                      })}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-500 hover:text-zinc-200 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all duration-200">
                        <MoreHorizontal size={14} />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function CollectionsEntriesRoute() {
  const { collection, entries } = Route.useLoaderData();
  const { slug } = Route.useParams();

  return <CollectionEntriesPage collection={collection} entries={entries} slug={slug} section="collections" />;
}
