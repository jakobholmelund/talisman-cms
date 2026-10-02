import React, { useEffect, useState } from 'react';

type Usage = { id: string; title: string; collection: string | null; kind: string; entryId?: string };
type UsagePage = { usages: Usage[]; nextCursor: string | null; excludedCollections: string[]; scope: string };

export function MediaUsageReview({ id, adminPath, onReady, showAcknowledgment = true }: { id: string; adminPath: string; onReady?: (ready: boolean) => void; showAcknowledgment?: boolean }) {
  const [usages, setUsages] = useState<Usage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const needsReview = usages.length > 0 || cursor !== null || excluded.length > 0;
  useEffect(() => { onReady?.(loaded && !loading && !error && (!needsReview || acknowledged)); }, [loaded, loading, error, needsReview, acknowledged, onReady]);
  async function load(next: string | null, signal?: AbortSignal) {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (next) params.set('cursor', next);
      const response = await fetch(`${adminPath}/api/media/${encodeURIComponent(id)}/usage?${params}`, { cache: 'no-store', signal });
      if (!response.ok) throw new Error('Could not check media usage. Retry before deleting.');
      const page = await response.json() as UsagePage;
      if (signal?.aborted) return;
      setUsages(current => next ? [...current, ...page.usages] : page.usages);
      setCursor(page.nextCursor); setExcluded(page.excludedCollections); setLoaded(true);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Could not check media usage.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(null, controller.signal); return () => controller.abort(); }, [id, adminPath]);
  return <section aria-label="Media usage" className="space-y-3 text-sm">
    <h3 className="font-medium text-white">Where this asset is used</h3>
    {loading && <p role="status" className="text-zinc-400">Checking references…</p>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {usages.length > 0 && <ul className="max-h-48 space-y-2 overflow-y-auto">{usages.map(usage => <li key={`${usage.kind}:${usage.collection}:${usage.id}`}>
      <a className="text-indigo-300 underline" target="_blank" rel="noopener noreferrer"
        href={usage.kind === 'global' ? `${adminPath}/globals/${encodeURIComponent(usage.id)}` : `${adminPath}/collections/${encodeURIComponent(usage.collection || '')}/${encodeURIComponent(usage.entryId || usage.id)}`}>
        {usage.title}
      </a><span className="ml-2 text-zinc-400">{usage.collection || 'Global'} · {usage.kind === 'revision' ? 'saved revision' : usage.kind}</span>
    </li>)}</ul>}
    {loaded && !loading && !error && usages.length === 0 && !cursor && <p className="text-zinc-300">No structured CMS references found in the content checked.</p>}
    {excluded.length > 0 && <p className="text-amber-300">Some collections could not be checked: {excluded.join(', ')}.</p>}
    {cursor && <p className="text-amber-300">The check is incomplete. More content remains to be checked.</p>}
    {(error || cursor) && <button type="button" disabled={loading} onClick={() => void load(cursor)} className="text-indigo-300 underline disabled:opacity-50">{error ? 'Retry usage check' : 'Check more content'}</button>}
    <p className="text-zinc-400">Checks drafts, published snapshots, saved revisions, globals and configured native fields. References in site code, external sites and HTML strings are not scanned. Content can change after this check.</p>
    {showAcknowledgment && loaded && needsReview && <label className="flex items-start gap-2 text-amber-200"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1" />I understand that deleting this asset may break references and restored revisions.</label>}
  </section>;
}
