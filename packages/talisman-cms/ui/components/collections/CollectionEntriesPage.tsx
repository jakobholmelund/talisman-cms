import { adminCollectionViews } from 'virtual:talisman-cms/admin-extensions';
import React, { Suspense, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { describeEntry } from '../../lib/entry-describers';
import { Input } from '../ui/input';
import { COLLECTION_PAGE_SIZE, COLLECTION_MAX_PAGE, getCollectionListOptions, normalizeCollectionListSearch, type CollectionListSearch } from '../../lib/collection-list';
import { Card } from '../ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button } from '../ui/button';
import { Plus, MoreHorizontal, ArrowLeft, ChevronRight } from 'lucide-react';
import { getSectionEntryLink, getSectionIndexLink, getSectionLabel, getSectionCollectionLink, type AdminSection } from '../../lib/admin-sections';
import { getCollectionPermissions, getCollectionWriteNotice } from '../../lib/collection-permissions';
import { getPagePath, getPendingSlugRename } from '../../lib/entry-save';

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

function GenericCollectionEntriesPage({ collection, entries, hasNextPage, listSearch, listError, slug, section }: {
  collection: any;
  entries: any[];
  hasNextPage: boolean;
  listSearch: CollectionListSearch;
  listError: string;
  slug: string;
  section: AdminSection;
}) {
  const controlId = useId();
  const navigate = useNavigate();
  const router = useRouter();
  const context = router.options.context;
  const isLoading = useRouterState({ select: state => state.isLoading });
  const permissions = getCollectionPermissions(collection, context.user);
  const options = getCollectionListOptions(collection);
  const [query, setQuery] = useState(listSearch.q || '');
  const [status, setStatus] = useState(listSearch.status || '');
  const [sort, setSort] = useState(listSearch.sort || '');
  const pageNumber = listSearch.page || 1;
  const hasFilters = Boolean(listSearch.q || listSearch.status || listSearch.sort);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const previousPage = useRef(pageNumber);
  useEffect(() => {
    setQuery(listSearch.q || '');
    setStatus(listSearch.status || '');
    setSort(listSearch.sort || '');
    if (previousPage.current !== pageNumber) summaryRef.current?.focus();
    previousPage.current = pageNumber;
  }, [slug, listSearch.q, listSearch.status, listSearch.sort, pageNumber]);
  const changeView = (search: CollectionListSearch) => {
    if (!isLoading) void navigate({ ...getSectionCollectionLink(section, slug), search });
  };
  const entryLink = (id: string) => ({ ...getSectionEntryLink(section, slug, id), search: listSearch });
  const selectClass = 'h-10 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50';

  const entryLabel = collection?.nativeSchemaMapping ? 'record' : 'entry';
  const entriesLabel = collection?.nativeSchemaMapping ? 'records' : 'entries';
  const isPagesCollection = slug === 'pages';

  if (!collection) {
    return <div>Collection not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 text-zinc-400 mb-2">
        <Link {...getSectionIndexLink(section)} className="hover:text-white transition-colors flex items-center gap-1 text-sm bg-white/5 px-2.5 py-1 rounded-md backdrop-blur-sm border border-white/5 hover:bg-white/10 hover:border-white/10">
          <ArrowLeft size={14} /> Back to {getSectionLabel(section)}
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
        {permissions.canCreate && <Button asChild className="gap-2 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] transition-all duration-300 border-0">
          <Link {...entryLink('new')}>
            <Plus size={16} strokeWidth={2.5} aria-hidden="true" /> Create {entryLabel}
          </Link>
        </Button>}
      </div>

      {!permissions.canCreate && <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{getCollectionWriteNotice(collection, context.user, 'create')}</p>}

      <form aria-label="Collection filters" className="flex flex-wrap items-end gap-3" onSubmit={event => {
        event.preventDefault();
        changeView(normalizeCollectionListSearch(collection, { q: query, status, sort }));
      }}>
        {options.searchField && <label className="flex min-w-48 flex-1 flex-col gap-2 text-sm text-zinc-300">
          Search {options.searchField.label || options.searchField.name}
          <Input type="search" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${collection.name}`} />
        </label>}
        {options.statuses.length > 0 && <label className="flex flex-col gap-2 text-sm text-zinc-300">
          <span id={`${controlId}-status`}>Status</span>
          <select aria-labelledby={`${controlId}-status`} className={selectClass} value={status} onChange={event => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            {options.statuses.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>}
        <label className="flex flex-col gap-2 text-sm text-zinc-300">
          <span id={`${controlId}-sort`}>Sort by</span>
          <select aria-labelledby={`${controlId}-sort`} className={selectClass} value={sort} onChange={event => setSort(event.target.value)}>
            {options.sorts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <Button type="submit" aria-disabled={isLoading || undefined} aria-busy={isLoading || undefined}>Apply filters</Button>
        {(hasFilters || pageNumber > 1) && <Button type="button" variant="outline" aria-disabled={isLoading || undefined} onClick={() => changeView({})}>Clear filters</Button>}
      </form>
      <p ref={summaryRef} tabIndex={-1} role="status" className="text-sm text-zinc-400 focus:outline-none">
        {isLoading ? 'Loading entries…' : listError ? 'Entries could not be loaded.' : `Page ${pageNumber} · ${entries.length} ${entries.length === 1 ? entryLabel : entriesLabel} shown`}
      </p>
      {listError && <div role="alert" className="flex items-center gap-3 rounded-lg border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-300">
        <span>{listError} Your filters are kept; try again or change them.</span>
        <Button type="button" variant="outline" aria-disabled={isLoading || undefined} onClick={() => { if (!isLoading) void router.invalidate(); }}>Retry</Button>
      </div>}

      {!listError && <Card aria-busy={isLoading || undefined} className="overflow-hidden border-white/10 bg-zinc-950/50 backdrop-blur-2xl shadow-xl">
        <Table>
          <TableHeader className="bg-white/[0.02] hover:bg-white/[0.02] border-b border-white/5">
            <TableRow className="border-none hover:bg-transparent">
              <TableHead className="w-[300px] text-zinc-400 font-medium">
                {isPagesCollection ? 'Page' : collection.nativeSchemaMapping ? 'Record' : 'Entry'}
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
                    <p className="text-sm font-medium text-zinc-300">{hasFilters ? `No ${entriesLabel} match these filters.` : pageNumber > 1 ? `No ${entriesLabel} on this page.` : `No ${entriesLabel} found for ${collection.name}.`}</p>
                    {!hasFilters && pageNumber === 1 && permissions.canCreate && <Button asChild variant="outline" size="sm" className="mt-2 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/10">
                      <Link {...entryLink('new')}>
                        Create the first {entryLabel}
                      </Link>
                    </Button>}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry: any) => {
                const data = parseEntryData(entry);
                const description = describeEntry(slug, entry, {});
                const pageTitle = typeof data.title === 'string' && data.title.length > 0 ? data.title : 'Untitled page';
                // A record without a naming field is shown as its collection plus the end of its id.
                const entryName = [data.title, data.name, data.customerEmail, data.email, data.code, data.value, entry.slug]
                  .find(value => typeof value === 'string' && value.length > 0)
                  || `${collection.name} ${String(entry.id).slice(-8)}`;
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
                      navigate(entryLink(entry.id));
                    }}
                  >
                    <TableCell>
                      {/* The name is a real link, so the row can be reached and opened from the keyboard. */}
                      <Link
                        {...entryLink(entry.id)}
                        onClick={(event) => event.stopPropagation()}
                        className="font-medium text-zinc-100 group-hover:text-indigo-400 transition-colors flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                      >
                        {description.imageUrl ? <img src={description.imageUrl} alt="" loading="lazy" width="48" height="48" className="h-12 w-12 shrink-0 rounded-lg border border-white/10 object-cover" /> : <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-zinc-700 group-hover:bg-indigo-400 transition-colors" />}
                        {rowLabel}
                      </Link>
                      <div className={`text-xs text-zinc-500 mt-1 ml-3.5 tracking-tight group-hover:text-zinc-400 transition-colors ${isPagesCollection ? '' : 'font-mono'}`}>
                        {pendingRename && !isPagesCollection ? (
                          <>
                            {pendingRename.liveSlug}
                            <span className="ml-2 font-sans text-amber-300/90">renames to {pendingRename.nextSlug} on publish</span>
                          </>
                        ) : description.subtitle || entry.slug}
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
      </Card>}

      <nav aria-label="Collection pages" className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" aria-disabled={isLoading || pageNumber === 1 || undefined} onClick={() => { if (pageNumber > 1) changeView({ ...listSearch, page: pageNumber === 2 ? undefined : pageNumber - 1 }); }}>Previous page</Button>
        <span className="text-sm text-zinc-400">Page {pageNumber}</span>
        <Button type="button" variant="outline" aria-disabled={isLoading || !hasNextPage || pageNumber >= COLLECTION_MAX_PAGE || undefined} onClick={() => { if (hasNextPage && pageNumber < COLLECTION_MAX_PAGE) changeView({ ...listSearch, page: pageNumber + 1 }); }}>Next page</Button>
      </nav>
      {hasNextPage && pageNumber >= COLLECTION_MAX_PAGE && <p className="text-sm text-zinc-400">Narrow your search to find more entries beyond this page.</p>}

    </div>
  );
}


/** Keep the collection URL and editor back links while letting a plugin own its list workflow. */
export function CollectionEntriesPage(props: React.ComponentProps<typeof GenericCollectionEntriesPage>) {
  const router=useRouter();
  const view=adminCollectionViews.find(view=>view.slug===props.slug && (!view.nativeSchemaExport || view.nativeSchemaExport===props.collection?.nativeSchemaMapping?.exportName));
  if(view && getCollectionPermissions(props.collection,router.options.context.user).canRead){
    const Component=view.component;
    return <Suspense fallback={<p role="status">Loading catalogue…</p>}><Component collection={props.collection} section={props.section} adminBasePath={router.options.context.adminBasePath || '/admin'} /></Suspense>;
  }
  return <GenericCollectionEntriesPage {...props}/>;
}
