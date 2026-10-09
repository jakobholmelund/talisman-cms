import React, { useEffect, useRef, useState } from 'react';
import type { listStockLocations, readStockHistory } from '@talisman-cms/plugin-ecommerce/operations';
import { Field, Panel } from './common';
import { dateTime, OperationsPagination, OperationsReadStatus, useOperationsRead } from './operations-common';
import { useWarehouseWrite } from './warehouse-write';
type Locations = Awaited<ReturnType<typeof listStockLocations>>;
type Location = Locations['rows'][number];
type History = Awaited<ReturnType<typeof readStockHistory>>;
const validLocations = (v: unknown): v is Locations => !!v && Array.isArray((v as Locations).rows) && Number.isFinite((v as Locations).total);
const validHistory = (v: unknown): v is History => !!v && Array.isArray((v as History).rows) && Number.isFinite((v as History).total);
function HistoryPanel({ location, refreshKey }: { location: Location; refreshKey: unknown }) {
  const [offset, setOffset] = useState(0);
  const read = useOperationsRead<History>(new URLSearchParams({ view: 'stockHistory', targetType: location.type, targetId: location.id, offset: String(offset) }).toString(), validHistory);
  useEffect(() => { void read.load(); }, [refreshKey]);
  return <section aria-label="Stock movement history"><h4>Movement history · {location.name}</h4><OperationsReadStatus loading={read.loading} error={read.error} reload={() => void read.load()} />
    {read.data && <>{!read.data.rows.length ? <p>No recorded movements yet.</p> : <ul>{read.data.rows.map(row => <li key={`${row.kind}:${row.id}`}><strong>{row.kind.replaceAll('_', ' ')}</strong> · {row.delta > 0 ? '+' : ''}{row.delta} units
      {row.beforeQuantity !== null && <> · {row.beforeQuantity} → {row.afterQuantity}</>}<br />{dateTime(row.createdAt)} · {row.actorName || row.actor || 'Checkout'} · {row.reason}
      {row.orderId && <> · Order {row.orderId}</>}</li>)}</ul>}
      <OperationsPagination offset={read.data.offset} total={read.data.total} loading={read.loading} change={setOffset} /></>}
  </section>;
}
export default function StockMovements({ refreshOverview }: { refreshOverview: () => Promise<unknown> }) {
  const [filters, setFilters] = useState({ search: '', offset: '0' }), [selected, setSelected] = useState(''), [kind, setKind] = useState('receipt'), [delta, setDelta] = useState(''), [reason, setReason] = useState('');
  const read = useOperationsRead<Locations>(new URLSearchParams({ view: 'stockLocations', ...filters }).toString(), validLocations);
  const write = useWarehouseWrite(async () => { await read.load(); await refreshOverview(); });
  useEffect(() => { if (read.data && !read.unavailable.current) write.loaded(); }, [read.data]);
  const location = read.data?.rows.find(row => `${row.type}:${row.id}` === selected);
  const locked = write.busy || !!write.pending;
  const blocked = locked || write.needsReload || read.loading || !!read.error;
  return <Panel title="Incoming stock, corrections and history" label="Stock movements">
    <p>Choose the stock record that physically holds the units. Shared parts have their own counts. Record incoming units or a signed correction with a reason.</p>
    {write.feedback}
    <form aria-label="Find stock records" onSubmit={e => { e.preventDefault(); if (write.dirty || locked) return; const f = new FormData(e.currentTarget); setSelected(''); setFilters({ search: String(f.get('search') || ''), offset: '0' }); }}>
      <Field label="Find a stock record"><input name="search" maxLength={100} disabled={locked || write.dirty} /></Field><button type="submit" disabled={locked || write.dirty || read.loading}>Find stock records</button>
    </form>
    <OperationsReadStatus loading={read.loading || write.busy} error={read.error} reload={() => void read.load()} />
    {read.data && <><Field label="Stock record"><select aria-label="Stock record" value={selected} disabled={locked || write.dirty || read.loading} onChange={event => setSelected(event.target.value)}><option value="">Choose a stock record</option>{read.data.rows.map(row => <option key={`${row.type}:${row.id}`} value={`${row.type}:${row.id}`}>{row.name} · {row.type} · {row.quantity} units{row.sku ? ` · ${row.sku}` : ''}</option>)}</select></Field>
      <OperationsPagination offset={read.data.offset} total={read.data.total} loading={read.loading || locked || write.dirty} change={offset => { setSelected(''); setFilters(current => ({ ...current, offset: String(offset) })); }} /></>}
    {location && <><form aria-label="Stock change" onSubmit={event => {
      event.preventDefault(); if (write.blocked() || read.unavailable.current) return;
      void write.send({ path: 'operations', body: { action: 'stockMovement', data: { requestKey: crypto.randomUUID(), targetType: location.type, targetId: location.id,
        expectedQuantity: location.quantity, expectedUpdatedAt: location.updatedAt, kind, delta: Number(delta), reason: reason.trim() } }, receipt: 'movementId', success: 'Stock change recorded with its staff history.' }, () => { setDelta(''); setReason(''); });
    }} onChange={() => write.setDirty(true)}>
      <p>Available now: <strong>{location.quantity}</strong>{delta && Number.isFinite(Number(delta)) && <> · After change: <strong>{location.quantity + Number(delta)}</strong></>}</p>
      <Field label="Change type"><select aria-label="Change type" value={kind} disabled={locked} onChange={e => setKind(e.target.value)}><option value="receipt">Incoming stock</option><option value="correction">Stock correction</option></select></Field>
      <Field label={kind === 'receipt' ? 'Units received' : 'Quantity change (positive or negative)'}><input type="number" min={kind === 'receipt' ? 1 : -1000000} max={1000000} step="1" required value={delta} disabled={locked} onChange={e => setDelta(e.target.value)} /></Field>
      <Field label="Reason for stock change"><input required minLength={8} maxLength={500} value={reason} disabled={locked} onChange={e => setReason(e.target.value)} /></Field>
      <button type="submit" disabled={blocked || !delta || Number(delta) === 0 || location.quantity + Number(delta) < 0}>Record stock change</button>
      {write.dirty && !write.pending && <button type="button" disabled={write.busy} onClick={() => { setDelta(''); setReason(''); write.setDirty(false); }}>Discard stock draft</button>}
    </form><HistoryPanel key={selected} location={location} refreshKey={read.data} /></>}
  </Panel>;
}
