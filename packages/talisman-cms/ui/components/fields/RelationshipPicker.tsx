import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { describeEntry } from '../../lib/entry-describers';
import { getRelationTargets, type RelationReference } from '../../lib/page-builder';
import { fetchCollectionConfigs, fetchEntriesPage } from '../../lib/admin-api';
import {
  getRelationSelectionKey,
  normalizeRelationSelections,
  serializeRelationSelections,
  type RelationOptions,
  type RelationSupportEntries,
} from './relations';

/** Searches bounded server pages and keeps selected records independently, in order for hasMany. */
export function RelationshipPicker({
  field,
  adminBasePath,
  value,
  onChange,
  onBlur,
  relationOptions,
  relationSupportEntries,
  labelId,
  describedBy,
}: {
  field: any;
  adminBasePath: string;
  value: any;
  onChange: (value: any) => void;
  onBlur: () => void;
  relationOptions: RelationOptions;
  relationSupportEntries: RelationSupportEntries;
  /** The id of the field's visible label, which names the picker. */
  labelId?: string;
  describedBy?: string;
}) {
  const [query, setQuery] = useState('');
  // Read out by screen readers: "Added X", "Removed X", "Moved X to position N of M".
  const [announcement, setAnnouncement] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selections = normalizeRelationSelections(field, value);
  const selectedKeys = new Set(selections.map(getRelationSelectionKey));
  const targetKey = JSON.stringify(getRelationTargets(field));
  const [searchableFields, setSearchableFields] = useState<Record<string, any[]>>({});
  const [searchFields, setSearchFields] = useState<Record<string, string>>({});
  const searchFieldsKey = JSON.stringify(searchFields);
  const [pages, setPages] = useState<Record<string, { docs: any[]; nextCursor: string | null }>>({});
  const [knownEntries, setKnownEntries] = useState<RelationSupportEntries>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [retry, setRetry] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const selectedKey = JSON.stringify(selections);
  const supportEntries: RelationSupportEntries = { ...relationSupportEntries };
  for (const slug of Object.keys(knownEntries)) {
    supportEntries[slug] = [...new Map([...(relationSupportEntries[slug] || []), ...knownEntries[slug]].map((entry) => [entry.id, entry])).values()];
  }
  const remember = (slug: string, docs: any[]) => setKnownEntries((current) => ({
    ...current, [slug]: [...new Map([...(current[slug] || []), ...docs].map((entry) => [entry.id, entry])).values()],
  }));

  // Typing cancels obsolete searches. Each target has its own cursor so polymorphic relations
  // never omit a target or silently discard the remainder of a collection.
  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    generationRef.current += 1;
    setPages({});
    setError('');
    setLoading(true);
    busyRef.current = true;
    const timer = setTimeout(async () => {
      try {
        const targets: string[] = JSON.parse(targetKey);
        const configs = await fetchCollectionConfigs(adminBasePath);
        if (controller.signal.aborted) return;
        const fieldsBySlug = Object.fromEntries(targets.map((slug) => [slug, (configs.find((config) => config.slug === slug)?.fields || []).filter((candidate: any) => ['text', 'textarea'].includes(candidate.type))]));
        setSearchableFields(fieldsBySlug);
        const results = await Promise.all(targets.map(async (slug) => {
          const fields = fieldsBySlug[slug];
          const searchField = searchFields[slug] || fields.find((candidate: any) => ['title', 'name', 'label', 'filename', 'email'].includes(candidate.name))?.name || fields[0]?.name;
          return [slug, await fetchEntriesPage(adminBasePath, slug, { search: searchField ? query : '', searchField, signal: controller.signal })] as const;
        }));
        if (controller.signal.aborted) return;
        setPages(Object.fromEntries(results));
        for (const [slug, page] of results) remember(slug, page.docs);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Search failed. Try again.');
      } finally {
        if (!controller.signal.aborted) { setLoading(false); busyRef.current = false; }
      }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [adminBasePath, targetKey, query, searchFieldsKey, retry]);

  // Selected records are fetched by id, independent of the search page. Keep their labels even
  // when the user searches for something else or advances beyond the selected record's page.
  useEffect(() => {
    const controller = new AbortController();
    setSelectionError('');
    void Promise.all(selections.map(async (selection) => {
      if ((supportEntries[selection.relationTo] || []).some((entry) => entry.id === selection.value)) return;
      const response = await fetch(`${adminBasePath}/api/collections/${encodeURIComponent(selection.relationTo)}/entries/${encodeURIComponent(selection.value)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load a selected ${selection.relationTo} label (HTTP ${response.status}). Its saved reference is unchanged.`);
      const entry = await response.json();
      if (!controller.signal.aborted) remember(selection.relationTo, [entry]);
    })).catch((cause) => { if (!controller.signal.aborted) setSelectionError(cause instanceof Error ? cause.message : 'Could not load selected labels.'); });
    return () => controller.abort();
  }, [adminBasePath, selectedKey, retry]);

  const filteredOptions = Object.entries(pages).flatMap(([collectionSlug, page]) => page.docs.map((entry) => ({ collectionSlug, entry })));
  const hasMore = Object.values(pages).some((page) => page.nextCursor);
  const loadMore = async () => {
    if (busyRef.current || !hasMore) return;
    busyRef.current = true;
    setLoading(true);
    setError('');
    const controller = requestRef.current;
    const generation = generationRef.current;
    try {
      const results = await Promise.all(Object.entries(pages).filter(([, page]) => page.nextCursor).map(async ([slug, page]) =>
        [slug, await fetchEntriesPage(adminBasePath, slug, { search: searchableFields[slug]?.length ? query : '', searchField: searchFields[slug] || searchableFields[slug]?.find((candidate: any) => ['title', 'name', 'label', 'filename', 'email'].includes(candidate.name))?.name || searchableFields[slug]?.[0]?.name, cursor: page.nextCursor, signal: controller?.signal })] as const));
      if (controller?.signal.aborted || generation !== generationRef.current) return;
      setPages((current) => {
        const next = { ...current };
        for (const [slug, page] of results) next[slug] = { ...page, docs: [...new Map([...(current[slug]?.docs || []), ...page.docs].map((entry) => [entry.id, entry])).values()] };
        return next;
      });
      for (const [slug, page] of results) remember(slug, page.docs);
      if (results.every(([, page]) => !page.nextCursor)) searchRef.current?.focus();
    } catch (cause) {
      if (!controller?.signal.aborted) setError(cause instanceof Error ? cause.message : 'Loading more failed. Try again.');
    } finally {
      if (generation === generationRef.current && !controller?.signal.aborted) { setLoading(false); busyRef.current = false; }
    }
  };

  function commitSelections(nextSelections: RelationReference[]) {
    onChange(serializeRelationSelections(field, nextSelections));
    onBlur();
  }

  function addSelection(collectionSlug: string, entryId: string, title: string) {
    const nextSelection = { relationTo: collectionSlug, value: entryId };
    // A selected option stays focusable and reports its state; activating it again does nothing.
    if (selectedKeys.has(getRelationSelectionKey(nextSelection))) return;
    commitSelections(field.hasMany ? [...selections, nextSelection] : [nextSelection]);
    setAnnouncement(`${field.hasMany ? 'Added' : 'Selected'} ${title}.`);
  }

  function removeSelection(selectionToRemove: RelationReference, title: string) {
    commitSelections(selections.filter((selection) => getRelationSelectionKey(selection) !== getRelationSelectionKey(selectionToRemove)));
    setAnnouncement(`Removed ${title}.`);
    // The Remove button goes with its row, so focus moves to the search field.
    searchRef.current?.focus();
  }

  function moveSelection(selectionToMove: RelationReference, direction: -1 | 1, title: string) {
    const index = selections.findIndex((selection) => getRelationSelectionKey(selection) === getRelationSelectionKey(selectionToMove));
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= selections.length) return;

    const nextSelections = [...selections];
    const [selection] = nextSelections.splice(index, 1);
    nextSelections.splice(targetIndex, 0, selection);
    commitSelections(nextSelections);
    setAnnouncement(`Moved ${title} to position ${targetIndex + 1} of ${selections.length}.`);
  }

  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="space-y-3">
      <p role="status" className="sr-only">{loading ? 'Loading relationship options…' : announcement || `${filteredOptions.length} options loaded.${hasMore ? ' More options are available.' : ''}`}</p>
      {(error || selectionError) && <div role="alert" className="text-sm text-red-300"><p>{error || selectionError}</p><Button type="button" variant="outline" size="sm" onClick={() => setRetry((current) => current + 1)}>Retry {field.label}</Button></div>}
      <input
        ref={searchRef}
        type="text"
        maxLength={200}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${field.label.toLowerCase()}...`}
        aria-label={`Search ${field.label}`}
        className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm text-zinc-100 shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
      />

      {Object.entries(searchableFields).map(([slug, fields]) => fields.length ? (
        <label key={slug} className="flex items-center gap-2 text-xs text-zinc-400">
          Search {slug} by
          <select aria-label={`Search ${field.label} in ${slug} by`} className="rounded border border-white/10 bg-zinc-950 p-1" value={searchFields[slug] || fields.find((candidate: any) => ['title', 'name', 'label', 'filename', 'email'].includes(candidate.name))?.name || fields[0].name} onChange={(event) => setSearchFields((current) => ({ ...current, [slug]: event.target.value }))}>
            {fields.map((candidate: any) => <option key={candidate.name} value={candidate.name}>{candidate.label || candidate.name}</option>)}
          </select>
        </label>
      ) : <p key={slug} className="text-xs text-zinc-400">{slug} has no searchable text fields. Browse all its options using Load more.</p>)}

      {selections.length > 0 && (
        <div className="space-y-2">
          {selections.map((selection, index) => {
            const entry = (supportEntries[selection.relationTo] || []).find((candidate: any) => candidate.id === selection.value) || null;
            const description = describeEntry(selection.relationTo, entry || { id: selection.value }, supportEntries);

            return (
              <div key={getRelationSelectionKey(selection)} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{description.title}</span>
                      <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                        {selection.relationTo}
                      </span>
                    </div>
                    {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {field.hasMany && (
                      <>
                        <Button type="button" size="sm" variant="outline" aria-label={`Move ${description.title} up`} onClick={() => moveSelection(selection, -1, description.title)} aria-disabled={index === 0 || undefined}>
                          Up
                        </Button>
                        <Button type="button" size="sm" variant="outline" aria-label={`Move ${description.title} down`} onClick={() => moveSelection(selection, 1, description.title)} aria-disabled={index === selections.length - 1 || undefined}>
                          Down
                        </Button>
                      </>
                    )}
                    <Button type="button" size="sm" variant="destructive" aria-label={`Remove ${description.title}`} onClick={() => removeSelection(selection, description.title)}>
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div role="group" aria-label={`${field.label} options`} className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950/30">
        {filteredOptions.length === 0 ? (
          <div className="px-3 py-4 text-sm text-zinc-500">{loading ? 'Loading options…' : error ? 'Options could not be loaded.' : 'No entries matched this search.'}</div>
        ) : (
          filteredOptions.map((option) => {
            const description = describeEntry(option.collectionSlug, option.entry, supportEntries);
            const selection = { relationTo: option.collectionSlug, value: option.entry.id };
            const isSelected = selectedKeys.has(getRelationSelectionKey(selection));

            return (
              <button
                key={`${option.collectionSlug}:${option.entry.id}`}
                type="button"
                onClick={() => addSelection(option.collectionSlug, option.entry.id, description.title)}
                aria-pressed={isSelected}
                className={`flex w-full items-start justify-between gap-4 border-b border-white/5 px-3 py-3 text-left transition-colors last:border-b-0 ${isSelected ? 'bg-indigo-500/10' : 'hover:bg-white/[0.04]'}`}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{description.title}</span>
                    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                      {option.collectionSlug}
                    </span>
                  </div>
                  {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
                </div>
                <span className="text-xs text-zinc-400">{isSelected ? 'Selected' : field.hasMany ? 'Add' : 'Choose'}</span>
              </button>
            );
          })
        )}
      </div>
      {hasMore && <Button type="button" variant="outline" size="sm" aria-disabled={loading || undefined} aria-busy={loading || undefined} onClick={() => void loadMore()}>Load more {field.label} options</Button>}
    </div>
  );
}
