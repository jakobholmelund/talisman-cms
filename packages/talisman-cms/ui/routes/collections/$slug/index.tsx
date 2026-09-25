import React, { useEffect, useState } from 'react';
import { createFileRoute, Link, useLoaderData, useNavigate, useRouter } from '@tanstack/react-router';
import { Card } from '../../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { Button } from '../../../components/ui/button';
import { Plus, MoreHorizontal, ArrowLeft, ChevronRight } from 'lucide-react';
import { getSectionBasePath, getSectionEntryRoute, type AdminSection } from '../../../lib/admin-sections';
import { fetchCollectionConfigs } from '../../../lib/admin-api';
import { getPagePath, getPendingSlugRename } from '../../../lib/entry-save';

export const Route = createFileRoute('/collections/$slug/')({
  component: CollectionsEntriesRoute,
  loader: async ({ params, context }) => loadCollectionEntriesData(context.adminBasePath || '/admin', params.slug),
});

const ENTRIES_PAGE_SIZE = 50;

type EntriesPage = { docs: any[]; nextCursor: string | null };

/** One page of the list, newest first; `nextCursor` asks for the page after it. */
async function fetchEntriesPage(basePath: string, slug: string, cursor?: string | null): Promise<EntriesPage> {
  const params = new URLSearchParams({ limit: String(ENTRIES_PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`${basePath}/api/collections/${slug}/entries?${params}`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || 'Failed to fetch entries');
  }
  return await res.json() as EntriesPage;
}

export async function loadCollectionEntriesData(basePath: string, slug: string) {
  const [collections, page] = await Promise.all([
    fetchCollectionConfigs(basePath),
    fetchEntriesPage(basePath, slug)
  ]);

  const collection = collections.find((item: any) => item.slug === slug);

  return { collection, entries: page.docs, nextCursor: page.nextCursor };
}

function parseEntryData(entry: any) {
  if (!entry?.data) return {};
  return typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
}

function getPageUrl(slug: string) {
  return getPagePath(slug);
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
  entries: firstPage,
  nextCursor: firstCursor,
  slug,
  section
}: {
  collection: any;
  entries: any[];
  /** Defaults to the `nextCursor` of the route's loadCollectionEntriesData result. */
  nextCursor?: string | null;
  slug: string;
  section: AdminSection;
}) {
  const navigate = useNavigate();
  const basePath = (useRouter().options.context as { adminBasePath?: string }).adminBasePath || '/admin';
  const loaderCursor = useLoaderData({ strict: false, select: (data: any) => data?.nextCursor ?? null } as any) as string | null;
  const initialCursor = firstCursor !== undefined ? firstCursor : loaderCursor;
  const [entries, setEntries] = useState(firstPage);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState('');

  // A new loader result (another collection, or a reload) starts the list again.
  useEffect(() => {
    setEntries(firstPage);
    setCursor(initialCursor);
    setLoadMoreError('');
  }, [firstPage, initialCursor]);

  const loadMore = async () => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    setLoadMoreError('');
    try {
      const page = await fetchEntriesPage(basePath, slug, cursor);
      setEntries((current) => [...current, ...page.docs]);
      setCursor(page.nextCursor);
    } catch (error: any) {
      setLoadMoreError(error.message || 'Failed to load more entries');
    } finally {
      setIsLoadingMore(false);
    }
  };

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
        {/* One link styled as a button, so the keyboard reaches it once. */}
        {!collection.readOnly && <Button asChild className="gap-2 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] transition-all duration-300 border-0">
          <Link to={sectionEntryRoute} params={{ slug, entryId: 'new' }}>
            <Plus size={16} strokeWidth={2.5} aria-hidden="true" /> {isProductsCollection ? 'Add product' : `Create ${entryLabel}`}
          </Link>
        </Button>}
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
              <TableHead className="w-[50px]"><span className="sr-only">Open</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow className="border-b border-white/5 hover:bg-white/[0.01]">
                <TableCell colSpan={isPagesCollection ? 6 : 4} className="text-center text-zinc-500 py-16">
                  <div className="flex flex-col items-center justify-center space-y-4">
                    <div className="p-4 bg-white/5 rounded-full border border-white/5 shadow-inner">
                      <MoreHorizontal size={24} aria-hidden="true" className="text-zinc-500" />
                    </div>
                    <p className="text-sm font-medium text-zinc-300">No {entryLabel}s found for {collection.name}.</p>
                    {!collection.readOnly && <Button asChild variant="outline" size="sm" className="mt-2 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/10">
                      <Link to={sectionEntryRoute} params={{ slug, entryId: 'new' }}>
                        {isProductsCollection ? 'Add the first product' : `Create the first ${entryLabel}`}
                      </Link>
                    </Button>}
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
                // A published entry keeps serving its live slug until the renamed draft is published.
                const pendingRename = getPendingSlugRename(entry);
                const pageUrl = getPageUrl(pendingRename ? pendingRename.liveSlug : entry.slug);
                const sectionCount = Array.isArray(data.layout) ? data.layout.length : 0;
                const rowLabel = isPagesCollection ? pageTitle : entryName;

                return (
                  <TableRow 
                    key={entry.id}
                    className="cursor-pointer border-b border-white/5 hover:bg-white/[0.04] transition-colors duration-200 group"
                    onClick={() => {
                      navigate({ to: sectionEntryRoute, params: { slug, entryId: entry.id } });
                    }}
                  >
                    <TableCell>
                      {/* The name is a real link, so the row can be reached and opened from the keyboard. */}
                      <Link
                        to={sectionEntryRoute}
                        params={{ slug, entryId: entry.id }}
                        onClick={(event) => event.stopPropagation()}
                        className="font-medium text-zinc-100 group-hover:text-indigo-400 transition-colors flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                      >
                        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-zinc-700 group-hover:bg-indigo-400 transition-colors" />
                        {rowLabel}
                      </Link>
                      <div className={`text-xs text-zinc-500 mt-1 ml-3.5 tracking-tight group-hover:text-zinc-400 transition-colors ${isPagesCollection ? '' : 'font-mono'}`}>
                        {pendingRename && !isPagesCollection ? (
                          <>
                            {pendingRename.liveSlug}
                            <span className="ml-2 font-sans text-amber-300/90">renames to {pendingRename.nextSlug} on publish</span>
                          </>
                        ) : entry.slug}
                      </div>
                    </TableCell>
                    {isPagesCollection && (
                      <TableCell>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono bg-zinc-900 border border-white/10 text-zinc-300 shadow-sm">
                          {pageUrl}
                        </span>
                        {pendingRename && (
                          <div className="mt-1 text-[11px] text-amber-300/90">
                            Renames to <span className="font-mono">{getPageUrl(pendingRename.nextSlug)}</span> on publish
                          </div>
                        )}
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
                      <ChevronRight aria-hidden="true" size={14} className="text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {(cursor || loadMoreError) && (
        <div className="flex flex-col items-center gap-2">
          {loadMoreError && <p className="text-sm text-rose-400">{loadMoreError}</p>}
          {cursor && (
            <Button type="button" variant="outline" size="sm" disabled={isLoadingMore} onClick={() => void loadMore()}>
              {isLoadingMore ? 'Loading...' : `Load more ${entryLabel}s`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function CollectionsEntriesRoute() {
  const { collection, entries, nextCursor } = Route.useLoaderData();
  const { slug } = Route.useParams();

  return <CollectionEntriesPage collection={collection} entries={entries} nextCursor={nextCursor} slug={slug} section="collections" />;
}
