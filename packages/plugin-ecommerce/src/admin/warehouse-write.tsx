import React, { useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { adminRequest, errorText, Feedback } from './common';

type Pending = { path: string; body: Record<string, unknown>; receipt: string; success: string };
/** Freeze ambiguous writes until their same receipt is recovered; a definite refusal retains the draft. */
export function useWarehouseWrite(refresh: () => Promise<unknown>) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null), saving = useRef(false), refused = useRef(false), active = useRef(true);
  const [busy, setBusy] = useState(false), [needsReload, setNeedsReload] = useState(false), [dirty, setDirty] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const confirm = useRef<(() => void) | null>(null);
  useBlocker({ shouldBlockFn: () => (dirty || !!pendingRef.current) && !window.confirm('Leave this unsaved warehouse draft? An unconfirmed change may already be recorded.') });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending]);
  async function send(value: Pending, onConfirmed?: () => void) {
    if (saving.current || (refused.current && !pendingRef.current)) return;
    if (pendingRef.current && pendingRef.current !== value) return;
    saving.current = true; pendingRef.current = value; setPending(value); setBusy(true); setError(''); setMessage('');
    if (onConfirmed) confirm.current = onConfirmed;
    try {
      const response = await adminRequest<{ result?: Record<string, unknown> }>(value.path, value.body);
      if (typeof response?.result?.[value.receipt] !== 'string' || !response.result[value.receipt]) throw new Error('The response was incomplete. Recover the same request to check its receipt.');
      if (!active.current) return;
      pendingRef.current = null; setPending(null); setDirty(false); setMessage(value.success);
      confirm.current?.(); confirm.current = null;
      await refresh();
    } catch (cause) {
      if (!active.current) return;
      if ((cause as { status?: number })?.status === 409) { refused.current = true; setNeedsReload(true); }
      if ([400,403,409].includes((cause as { status?: number })?.status ?? 0)) { pendingRef.current = null; setPending(null); confirm.current = null; }
      setError(errorText(cause));
    } finally { saving.current = false; if (active.current) setBusy(false); }
  }
  return { busy, dirty, pending, needsReload, blocked: () => saving.current || !!pendingRef.current || refused.current, loaded: () => { refused.current = false; setNeedsReload(false); }, setDirty, send,
    feedback: <>{needsReload && <p>Refresh the current quantities before retrying this draft.</p>}<Feedback message={message} /><Feedback error message={error} />{pending && <div className="ecom-admin__email-record"><p>Unconfirmed change. Recover this same request before recording another change.</p>
      <button type="button" disabled={busy} onClick={() => void send(pending)}>Recover same request</button></div>}</> };
}
