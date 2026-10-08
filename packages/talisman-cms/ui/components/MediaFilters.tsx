import React, { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { MEDIA_FILE_TYPES, validateMediaSearch, type MediaSearch } from '../lib/media-search';

/** A fieldset also works inside an entry form without submitting that form. */
export function MediaFilters({ search, busy, onApply }: { search: MediaSearch; busy: boolean; onApply: (search: MediaSearch) => void }) {
  const [query, setQuery] = useState(search.q || '');
  const [type, setType] = useState(search.type || '');
  useEffect(() => { setQuery(search.q || ''); setType(search.type || ''); }, [search.q, search.type]);
  const apply = () => { if (!busy) onApply(validateMediaSearch({ q: query, type })); };
  return <fieldset aria-label="Media filters" className="flex flex-wrap items-end gap-3">
    <label className="flex min-w-40 flex-1 flex-col gap-2 text-sm text-zinc-300">Search filenames
      <Input type="search" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an uploaded file" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); apply(); } }} />
    </label>
    <label className="flex flex-col gap-2 text-sm text-zinc-300">File type
      <select value={type} onChange={event => setType(event.target.value)} className="h-10 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50">
        <option value="">All file types</option>
        {MEDIA_FILE_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    <Button type="button" aria-disabled={busy || undefined} onClick={apply}>Apply filters</Button>
    <Button type="button" variant="outline" aria-disabled={busy || !(query || type || search.q || search.type) || undefined} onClick={() => {
      if (!busy && (query || type || search.q || search.type)) { setQuery(''); setType(''); onApply({}); }
    }}>Clear filters</Button>
  </fieldset>;
}
