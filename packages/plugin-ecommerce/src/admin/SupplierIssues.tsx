import React, { useEffect, useRef, useState } from 'react';
import type { listSupplierIssues, readSupplierIssue } from '@talisman-cms/plugin-ecommerce/operations';
import { Field, Panel } from './common';
import { useOperationsRead, OperationsReadStatus, OperationsPagination, dateTime } from './operations-common';
import { useAftercareRead } from './aftercare-read';
import { useWarehouseWrite } from './warehouse-write';
type Queue = Awaited<ReturnType<typeof listSupplierIssues>>;
type Detail = Awaited<ReturnType<typeof readSupplierIssue>>;
const queueOk = (v: unknown): v is Queue => !!v && Array.isArray((v as Queue).rows) && Number.isFinite((v as Queue).total);
const detailOk = (v: unknown): v is Detail => !!v && typeof (v as Detail).version === 'string' && Array.isArray((v as Detail).history);
const labels = { short: 'Short delivery', damaged: 'Damaged goods', incorrect: 'Incorrect items' };
function IssueDetail({ id, refresh, dirtyChanged, blocked }: { id: string; refresh: () => Promise<unknown>; dirtyChanged: (v: boolean) => void; blocked: boolean }) {
  const read = useAftercareRead('supplierIssueRead', { issueId: id }, detailOk);
  const write = useWarehouseWrite(async () => { await read.load(); await refresh(); });
  const form = useRef<HTMLFormElement>(null), issue = read.data;
  useEffect(() => { dirtyChanged(write.dirty || !!write.pending); return () => dirtyChanged(false); }, [write.dirty, write.pending]);
  useEffect(() => { if (!read.unavailable.current && issue) write.loaded(); }, [issue, read.loading]);
  return <Panel title="Supplier issue details" label="Supplier issue details">
    <OperationsReadStatus loading={read.loading || write.busy} error={read.error} reload={() => void read.load()} />{write.feedback}
    {issue && <><p>{issue.reference} · {issue.supplier} · {issue.name}</p><p>{labels[issue.kind]} · {issue.quantity} reported units · {issue.status}</p>
      <p>{dateTime(issue.createdAt)} · {issue.actorName} · {issue.reason}</p>
      <p>Follow-up records supplier communication and resolution. Receive accepted replacements or cancel outstanding supply through the purchase controls; resolving this issue changes no stock or expected quantities.</p>
      <form ref={form} aria-label="Supplier issue follow-up" onChange={() => write.setDirty(true)} onSubmit={e => {
        e.preventDefault(); if (write.blocked() || read.unavailable.current || blocked) return;
        const f = new FormData(e.currentTarget);
        void write.send({ path: 'operations', body: { action: 'supplierIssueAction', data: { issueId: issue.id, expectedVersion: issue.version,
          requestKey: crypto.randomUUID(), status: String(f.get('status')), reason: String(f.get('reason')).trim() } }, receipt: 'eventId', success: 'Supplier issue follow-up recorded.' }, () => form.current?.reset());
      }}><fieldset disabled={write.busy || !!write.pending || blocked}><legend>Record supplier follow-up</legend>
        <Field label="Supplier issue action"><select aria-label="Supplier issue action" name="status" defaultValue="open">
          <option value="open">{issue.status === 'resolved' ? 'Reopen issue' : 'Keep open and add a note'}</option>
          {issue.status === 'open' && <option value="resolved">Resolve issue</option>}
        </select></Field>
        <Field label="Reason for supplier follow-up"><textarea aria-label="Reason for supplier follow-up" name="reason" required minLength={8} maxLength={500} /></Field>
        <button disabled={read.loading || !!read.error || write.needsReload}>Record supplier follow-up</button>
      </fieldset></form>{write.dirty && !write.pending && <button disabled={write.busy} onClick={() => { form.current?.reset(); write.setDirty(false); }}>Discard supplier follow-up</button>}
      <details><summary>Supplier issue history</summary>{issue.historyTruncated && <p>Showing the latest 100 updates.</p>}<ul>{issue.history.map(e => <li key={e.id}>{dateTime(e.createdAt)} · {e.actorName} · {e.status} · {e.reason}</li>)}</ul></details>
    </>}
  </Panel>;
}
export default function SupplierIssues({ dirtyChanged, blocked, reloadKey, changed }: { dirtyChanged: (v: boolean) => void; blocked: boolean; reloadKey: number; changed: () => Promise<unknown> }) {
  const [filter, setFilter] = useState('open'), [offset, setOffset] = useState(0), [selected, setSelected] = useState(''), [dirty, setDirty] = useState(false);
  const read = useOperationsRead<Queue>(new URLSearchParams({ view: 'supplierIssues', filter, offset: String(offset) }).toString(), queueOk);
  useEffect(() => { if (reloadKey) void read.load(); }, [reloadKey]);
  useEffect(() => { dirtyChanged(dirty); return () => dirtyChanged(false); }, [dirty]);
  return <><Panel title="Supplier delivery issues" label="Supplier delivery issues">
    <p>Reported shortages, damaged goods and incorrect items stay here until staff resolve them, including issues on completed or cancelled purchases. Keep rejected goods aside from sellable stock.</p>
    <form aria-label="Find supplier issues" onSubmit={e => { e.preventDefault(); if (dirty || blocked) return; const f = new FormData(e.currentTarget); setFilter(String(f.get('filter'))); setOffset(0); setSelected(''); }}>
      <Field label="Supplier issue view"><select aria-label="Supplier issue view" name="filter" disabled={dirty || blocked}><option value="open">Open issues</option><option value="resolved">Resolved issues</option><option value="all">All issues</option></select></Field>
      <button disabled={dirty || blocked || read.loading}>Find supplier issues</button>
    </form><OperationsReadStatus loading={read.loading} error={read.error} reload={() => void read.load()} />
    {read.data && <><ul>{read.data.rows.map(i => <li key={i.id}>{i.reference} · {i.supplier} · {i.name} · {labels[i.kind]} · {i.quantity} units · {i.status} <button disabled={dirty || blocked || read.loading} onClick={() => setSelected(i.id)}>Review supplier issue · {i.id}</button></li>)}</ul>
      {!read.data.total && <p>No supplier issues match this view.</p>}<OperationsPagination offset={read.data.offset} total={read.data.total} loading={dirty || blocked || read.loading} change={n => { setOffset(n); setSelected(''); }} /></>}
  </Panel>{selected && <IssueDetail key={selected} id={selected} refresh={async()=>{await read.load();await changed();}} dirtyChanged={setDirty} blocked={blocked} />}</>;
}
