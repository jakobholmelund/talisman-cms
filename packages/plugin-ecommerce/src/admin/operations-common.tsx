import React, { useCallback, useEffect, useRef, useState } from 'react';
import { adminRequest, errorText, Feedback } from './common';

/** Keep the last readable snapshot on a failed refresh, visibly stale. Sequence guards keep a slow
 * earlier page from overwriting a later filter or page request. */
export function useOperationsRead<T>(query: string, validate: (value: unknown) => value is T) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const unavailable = useRef(true);
  const load = useCallback(async () => {
    const run = ++sequence.current;
    unavailable.current = true;
    setLoading(true); setError('');
    try {
      const result = await adminRequest<unknown>(`operations?${query}`);
      if (!validate(result)) throw new Error('The server returned an incomplete operations response. Retry loading.');
      if (run !== sequence.current) return;
      setData(result); unavailable.current = false;
    } catch (cause) { if (run === sequence.current) setError(errorText(cause)); }
    finally { if (run === sequence.current) setLoading(false); }
  }, [query, validate]);
  useEffect(() => { void load(); return () => { sequence.current += 1; unavailable.current = true; }; }, [load]);
  return { data, loading, error, load, unavailable };
}
export function OperationsReadStatus({ loading, error, reload }: { loading: boolean; error: string; reload: () => void }) {
  return <><button type="button" onClick={reload} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
    <Feedback error message={error ? `${error} Displayed records may be out of date.` : ''} /></>;
}
export function OperationsPagination({ offset, total, loading, change }: { offset: number; total: number; loading: boolean; change: (offset: number) => void }) {
  return <div className="ecom-admin__actions" aria-label="Results pages">
    <button type="button" disabled={loading || offset === 0} onClick={() => change(Math.max(0, offset - 50))}>Previous page</button>
    <span>{total ? `${offset + 1}–${Math.min(offset + 50, total)} of ${total}` : '0 results'}</span>
    <button type="button" disabled={loading || offset + 50 >= total} onClick={() => change(offset + 50)}>Next page</button>
  </div>;
}
export const dateTime = (value: string) => new Date(value).toLocaleString();
