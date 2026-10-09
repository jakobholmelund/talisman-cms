import React, { useEffect, useState } from 'react';
import type { listStockLocations, listStocktakes } from '@talisman-cms/plugin-ecommerce/operations';
import { adminRequest, errorText, Feedback, Field, Panel } from './common';
import { dateTime, OperationsReadStatus, useOperationsRead } from './operations-common';
import { useWarehouseWrite } from './warehouse-write';
type Locations = Awaited<ReturnType<typeof listStockLocations>>;
type Location = Locations['rows'][number];
type Counts = Awaited<ReturnType<typeof listStocktakes>>;
type Draft = { location: Location; counted: string };
const validLocations = (v: unknown): v is Locations => !!v && Array.isArray((v as Locations).rows) && Number.isFinite((v as Locations).total);
const validCounts = (v: unknown): v is Counts => !!v && Array.isArray((v as Counts).rows) && Number.isFinite((v as Counts).total);
function printSheet(rows: Draft[]) {
  const win = window.open('', '_blank', 'width=800,height=700'); if (!win) return;
  const doc = win.document, title = doc.createElement('h1'); title.textContent = 'Available stock count sheet'; doc.body.appendChild(title);
  const note = doc.createElement('p'); note.textContent = 'Count unreserved, sellable units only. Exclude units held for paid or pending orders, inspection and damaged goods.'; doc.body.appendChild(note);
  const style = doc.createElement('style'); style.textContent = 'body{font:16px system-ui;padding:24px;overflow-wrap:anywhere}li{padding:16px 0;border-bottom:1px solid #aaa}'; doc.head.appendChild(style);
  const list = doc.createElement('ul'); for (const { location } of rows) { const li = doc.createElement('li'); li.textContent = `${location.name} · ${location.type}${location.sku ? ` · ${location.sku}` : ''} · Expected ${location.quantity} · Counted: ______`; list.appendChild(li); } doc.body.appendChild(list); doc.close(); win.print();
}
export default function Stocktakes({ refreshOverview }: { refreshOverview: () => Promise<unknown> }) {
  const [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [drafts, setDrafts] = useState<Draft[]>([]), [reason, setReason] = useState(''), [reviewed, setReviewed] = useState(false), [reloadError, setReloadError] = useState(''), [reloading, setReloading] = useState(false), [historyOffset, setHistoryOffset] = useState(0);
  const read = useOperationsRead<Locations>(new URLSearchParams({ view:'stockLocations', search, offset:String(offset) }).toString(), validLocations);
  const history = useOperationsRead<Counts>(new URLSearchParams({ view:'stocktakes', offset:String(historyOffset) }).toString(), validCounts);
  const write = useWarehouseWrite(async () => { await read.load(); await history.load(); await refreshOverview(); });
  const locked = write.busy || !!write.pending || reloading;
  useEffect(() => { write.setDirty(drafts.length > 0 || !!reason); }, [drafts, reason]);
  const valid = drafts.length > 0 && drafts.every(d => d.counted !== '' && Number.isInteger(Number(d.counted)) && Number(d.counted) >= 0 && Number(d.counted) <= 1000000);
  function add(location: Location) {
    if (locked || drafts.length >= 50 || drafts.some(d => d.location.type === location.type && d.location.id === location.id)) return;
    setDrafts(current => [...current, { location, counted:'' }]); setReviewed(false);
  }
  async function refreshCounts() {
    if (locked) return; setReloading(true); setReloadError(''); setReviewed(false);
    try {
      const result = await adminRequest<{ rows: Location[] }>('operations', { action:'stocktakeRead', data:{ targets: drafts.map(d => ({ targetType:d.location.type,targetId:d.location.id })) } });
      if (!Array.isArray(result?.rows) || result.rows.length !== drafts.length) throw new Error('Some counted stock records are unavailable. Remove them and review the count again.');
      const refreshed = drafts.map(d => { const fresh = result.rows.find(r => r.type === d.location.type && r.id === d.location.id); if (!fresh) throw new Error('A counted record is missing.'); return { ...d, location:fresh }; });
      setDrafts(refreshed);
      write.loaded();
    } catch(cause) { setReloadError(errorText(cause)); } finally { setReloading(false); }
  }
  return <Panel title="Count available stock" label="Stocktakes">
    <p>Count available, unreserved units. Exclude stock held for orders, inspection and damaged goods. Choose up to 50 physical stock records; shared parts are counted separately.</p>
    {write.feedback}<Feedback error message={reloadError} />
    <form aria-label="Find stocktake records" onSubmit={e => { e.preventDefault(); if (locked) return; const f = new FormData(e.currentTarget); setSearch(String(f.get('search') || '')); setOffset(0); }}>
      <Field label="Find stock to count"><input name="search" maxLength={100} disabled={locked} /></Field><button disabled={locked || read.loading}>Find stock to count</button>
    </form>
    <OperationsReadStatus loading={read.loading} error={read.error} reload={() => void read.load()} />
    {read.data && <details><summary>Available stock records</summary><ul>{read.data.rows.map(row => <li key={`${row.type}:${row.id}`}>{row.name} · {row.type} · {row.quantity} units <button type="button" disabled={locked || drafts.length >= 50 || drafts.some(d => d.location.type === row.type && d.location.id === row.id)} onClick={() => add(row)}>Add to count · {row.name}</button></li>)}</ul>
      <div className="ecom-admin__actions"><button disabled={locked || read.loading || offset===0} onClick={() => setOffset(n => Math.max(0,n-50))}>Previous records</button><span>{offset+1}–{Math.min(offset+50,read.data.total)} of {read.data.total}</span><button disabled={locked || read.loading || offset+50>=read.data.total} onClick={() => setOffset(n => n+50)}>Next records</button></div></details>}
    {drafts.length > 0 && <form aria-label="Stocktake count" onSubmit={e => {
      e.preventDefault(); if (write.blocked() || locked || !reviewed || !valid || reloadError) return;
      void write.send({ path:'operations', body:{ action:'stocktake', data:{ requestKey:crypto.randomUUID(),reason:reason.trim(),lines:drafts.map(({location,counted}) => ({ targetType:location.type,targetId:location.id,expectedQuantity:location.quantity,expectedUpdatedAt:location.updatedAt,countedQuantity:Number(counted) })) } }, receipt:'stocktakeId',success:'Stocktake recorded. All discrepancies were applied together.' }, () => { setDrafts([]); setReason(''); setReviewed(false); });
    }}>
      <h3>Count sheet and discrepancies</h3><button type="button" disabled={locked} onClick={() => printSheet(drafts)}>Print count sheet</button>
      <button type="button" disabled={locked} onClick={() => void refreshCounts()}>Reload all expected counts</button>
      <div className="ecom-admin__table-wrap"><table><thead><tr><th>Stock record</th><th>Expected available</th><th>Counted available</th><th>Difference</th><th></th></tr></thead><tbody>{drafts.map((d,index) => <tr key={`${d.location.type}:${d.location.id}`}><td>{d.location.name} · {d.location.type}</td><td>{d.location.quantity}</td><td><input aria-label={`Counted units — ${d.location.name}`} type="number" min="0" max="1000000" step="1" required value={d.counted} disabled={locked} onChange={e => { setDrafts(current => current.map((row,n) => n===index ? {...row,counted:e.target.value}:row)); setReviewed(false); }} /></td><td>{d.counted === '' ? 'Not counted' : Number(d.counted)-d.location.quantity}</td><td><button type="button" disabled={locked} onClick={() => {setDrafts(current=>current.filter((_,n)=>n!==index));setReviewed(false);}}>Remove · {d.location.name}</button></td></tr>)}</tbody></table></div>
      <Field label="Reason for stocktake"><input required minLength={8} maxLength={500} value={reason} disabled={locked} onChange={e => {setReason(e.target.value);setReviewed(false);}} /></Field>
      <label className="ecom-admin__check"><input type="checkbox" checked={reviewed} disabled={locked || !valid || write.needsReload || !!reloadError} onChange={e => setReviewed(e.target.checked)} /> I reviewed every discrepancy and excluded reserved and unsellable units</label>
      <button type="submit" disabled={locked || write.needsReload || !reviewed || !valid || !!reloadError}>Apply stocktake</button>
      {!write.pending && <button type="button" disabled={locked} onClick={() => {setDrafts([]);setReason('');setReviewed(false);setReloadError('');write.loaded();}}>Discard count draft</button>}
    </form>}
    <h3>Recorded stocktakes</h3><OperationsReadStatus loading={history.loading} error={history.error} reload={() => void history.load()} />
    {history.data && <><ul>{history.data.rows.map(row => <li key={row.id}><details><summary>{dateTime(row.createdAt)} · {row.actorName} · {row.lines.length} records · {row.reason}</summary><ul>{row.lines.map(l => <li key={`${l.targetType}:${l.targetId}`}>{l.name || 'Stock record'} · {l.targetType} · {l.expectedQuantity} → {l.countedQuantity} ({l.countedQuantity-l.expectedQuantity>0?'+':''}{l.countedQuantity-l.expectedQuantity})</li>)}</ul></details></li>)}</ul><button disabled={history.loading || historyOffset===0} onClick={()=>setHistoryOffset(n=>Math.max(0,n-20))}>Newer stocktakes</button><button disabled={history.loading || historyOffset+20>=history.data.total} onClick={()=>setHistoryOffset(n=>n+20)}>Older stocktakes</button></>}
  </Panel>;
}
