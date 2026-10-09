import React, { useEffect, useRef, useState } from 'react';
import { Link, useBlocker } from '@tanstack/react-router';
import type { listEmailRecovery, retryCommerceEmail } from '@talisman-cms/plugin-ecommerce/operations';
import { CommerceAdmin, errorText, Feedback, Field, Panel, adminRequest } from './common';
import { dateTime, OperationsPagination, OperationsReadStatus, useOperationsRead } from './operations-common';

type Snapshot = Awaited<ReturnType<typeof listEmailRecovery>>;
type Receipt = Awaited<ReturnType<typeof retryCommerceEmail>>;
type Retry = { requestKey: string; emailId: string; reason: string; expectedAttempts: number; expectedRetryId: string | null; expectedError: string | null };
const validSnapshot = (value: unknown): value is Snapshot => !!value && typeof value === 'object'
  && Array.isArray((value as Snapshot).rows) && Array.isArray((value as Snapshot).history) && Number.isFinite((value as Snapshot).total);
export default function EmailRecovery() {
  const [offset, setOffset] = useState(0);
  const { data, loading, error, load, unavailable } = useOperationsRead<Snapshot>(`view=emails&offset=${offset}`, validSnapshot);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Retry | null>(null);
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const pendingRef = useRef<Retry | null>(null);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  useEffect(() => { if (data && !unavailable.current) setNeedsReload(false); }, [data]);
  const dirty = !!pending || Object.values(reasons).some(reason => !!reason.trim());
  useBlocker({ shouldBlockFn: () => dirty && !window.confirm('Leave this email recovery draft? An unconfirmed retry may already have been queued.') });
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function submit(payload: Retry) {
    if (writingRef.current) return;
    writingRef.current = true; pendingRef.current = payload; setPending(payload); setWriting(true); setSaveError(''); setMessage('');
    try {
      const response = await adminRequest<{ result?: Receipt }>('operations', { action: 'retryEmail', data: payload });
      if (typeof response?.result?.decisionId !== 'string' || !response.result.decisionId || response.result.emailId !== payload.emailId) throw new Error('The retry response was incomplete. Recover the same request to check whether it was queued.');
      setMessage(`Retry recorded for ${payload.emailId}. Current delivery status: ${response.result.delivery?.status ?? 'unavailable'}. The scheduled sender handles delivery.`);
      pendingRef.current = null; setPending(null);
      setReasons(current => { const next = { ...current }; delete next[payload.emailId]; return next; });
      await load();
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      // A definite refusal can be edited after a fresh read. A lost response keeps the exact key and
      // payload independently of the list: the email may have disappeared from the failed queue.
      if (status === 400 || status === 409 || status === 403) { pendingRef.current = null; setPending(null); }
      if (status === 409) { unavailable.current = true; setNeedsReload(true); }
      setSaveError(errorText(cause));
    } finally { writingRef.current = false; setWriting(false); }
  }
  return <CommerceAdmin current="emails"><p className="ecom-admin__intro">Resolve the recorded error before requesting a retry. A recorded retry queues another attempt; it does not confirm inbox delivery.</p>
    <Feedback message={message} /><Feedback error message={saveError} />
    {needsReload && <p>Refresh the latest email status before requesting another retry. Your reason is retained.</p>}
    {pending && <Panel title="Unconfirmed retry" label="Unconfirmed retry"><p>The response for {pending.emailId} was not confirmed. Recover this same request to check its receipt without queuing it twice.</p><p>Reason: {pending.reason}</p>
      <button type="button" disabled={writing} onClick={() => void submit(pending)}>Recover same retry</button>
    </Panel>}
    <OperationsReadStatus loading={loading || writing} error={error} reload={() => void load()} />
    {data && <><Panel title="Email problems" label="Email problems"><p>Pending emails retry automatically. Sent and cancelled notices are excluded. Suppressed or invalid recipients cannot be retried here.</p>
      {!data.rows.length ? <p>No email problems are recorded.</p> : data.rows.map(row => <section className="ecom-admin__email-record" key={row.id} aria-label={`Email ${row.id}`}>
        <h3>{row.kind.replaceAll('_', ' ')} · {row.subjectId}</h3><p>Email ID: {row.id}</p><p>{row.status} · {row.attempts} attempts · Error: {row.lastError ?? 'none'}</p>
        <p>Created {dateTime(String(row.createdAt))}{row.status === 'pending' ? ` · Next attempt ${dateTime(String(row.nextAttemptAt))}` : ''}</p><p>{row.guidance}</p>
        {row.kind === 'gift_card_claim' && <Link to="/extensions/$extensionPath" params={{ extensionPath: 'commerce-gift-cards' }}>Open gift cards</Link>}
        {row.retryable && <form onSubmit={event => {
          event.preventDefault(); if (writingRef.current || pendingRef.current || unavailable.current) return;
          void submit({ requestKey: crypto.randomUUID(), emailId: row.id, reason: (reasons[row.id] ?? '').trim(),
            expectedAttempts: row.attempts, expectedRetryId: row.retryRequestId, expectedError: row.lastError });
        }}><Field label="Reason for retry"><textarea minLength={8} maxLength={500} required value={reasons[row.id] ?? ''} disabled={writing || !!pending}
          onChange={event => setReasons(current => ({ ...current, [row.id]: event.target.value }))} /></Field>
          <button type="submit" disabled={loading || !!error || writing || !!pending || needsReload}>Request retry</button></form>}
      </section>)}
      {Object.keys(reasons).some(id => reasons[id]?.trim() && !data.rows.some(row => row.id === id)) && <Panel title="Retained drafts" label="Retained email drafts"><p>These emails no longer appear on this page. Their unsaved reasons are kept here.</p>{Object.entries(reasons).filter(([id, reason]) => reason.trim() && !data.rows.some(row => row.id === id)).map(([id, reason]) => <p key={id}>{id}: {reason}</p>)}</Panel>}
      {dirty && !pending && <button type="button" className="ecom-admin__secondary" disabled={writing} onClick={() => { setReasons({}); setSaveError(''); }}>Discard unsaved reasons</button>}
      <OperationsPagination offset={data.offset} total={data.total} loading={loading || writing || !!pending} change={setOffset} />
    </Panel><Panel title="Recent recovery history" label="Email recovery history">
      {!data.history.length ? <p>No staff retries recorded yet.</p> : <ul>{data.history.map(row => <li key={row.id}><strong>{row.emailId}</strong><br />{dateTime(String(row.createdAt))} · {row.actorName}<br />{row.reason}<br />Earlier error: {row.priorError ?? 'none'} · {row.priorAttempts} attempts</li>)}</ul>}
    </Panel></>}
  </CommerceAdmin>;
}
