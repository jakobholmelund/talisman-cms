import ReturnInspection from './ReturnInspection';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { readOrderWarehouse } from '@talisman-cms/plugin-ecommerce/operations';
import { adminRequest, errorText, Feedback, Field } from './common';
import { dateTime } from './operations-common';
import { useWarehouseWrite } from './warehouse-write';

type Snapshot = Awaited<ReturnType<typeof readOrderWarehouse>>;
type Order = { id: string; canShip: boolean; shipments: Array<{ id: string; carrier: string | null; trackingNumber: string | null }> };
const text = (f: FormData, key: string) => String(f.get(key) || '').trim();
/** Text-only DOM output keeps catalog names, notes and addresses out of HTML interpretation. */
function printParcel(data: Snapshot, parcel: Snapshot['parcels'][number], tracking?: Order['shipments'][number]) {
  const win = window.open('', '_blank', 'width=800,height=700'); if (!win) return;
  const doc = win.document;
  doc.title = `Packing slip ${data.orderId}`;
  const add = (tag: string, text: string) => { const node = doc.createElement(tag); node.textContent = text; doc.body.appendChild(node); };
  const style = doc.createElement('style'); style.textContent = 'body{font:16px system-ui;padding:24px;line-height:1.5;overflow-wrap:anywhere}p{white-space:pre-line}h1{font-size:24px}li{margin:12px 0}@media print{button{display:none}}'; doc.head.appendChild(style);
  add('h1', 'Packing slip'); add('p', `Order: ${data.orderId}`); add('p', `Parcel: ${parcel.fulfillmentId}`);
  add('p', `Recorded: ${dateTime(parcel.createdAt)}`);
  if (tracking) add('p', [tracking.carrier, tracking.trackingNumber].filter(Boolean).join(' · '));
  const address = data.shippingAddress;
  if (address) add('p', [address.name, address.line1, address.line2, address.city, address.state, address.postalCode, address.country].filter(Boolean).join('\n'));
  const list = doc.createElement('ul');
  for (const item of parcel.items) { const line = data.lines[item.lineIndex], li = doc.createElement('li'); li.textContent = `${item.quantity} × ${line?.name || `Order line ${item.lineIndex + 1}`}${line?.sku ? ` · SKU ${line.sku}` : ''}`; list.appendChild(li); }
  doc.body.appendChild(list);
  const button = doc.createElement('button'); button.textContent = 'Print packing slip'; button.onclick = () => win.print(); doc.body.appendChild(button);
  doc.close(); win.focus(); win.print();
}
export default function OrderWarehouse({ order, refreshOrders, parentBlocked, canRecord, draftChanged }: { order: Order; refreshOrders: () => Promise<unknown>; parentBlocked: boolean; canRecord: () => boolean; draftChanged: (dirty: boolean) => void }) {
  const [data, setData] = useState<Snapshot | null>(null), [loading, setLoading] = useState(true), [readError, setReadError] = useState(''), [inputError, setInputError] = useState('');
  const [resetVersion, setResetVersion] = useState(0);
  const [conditions, setConditions] = useState<Record<number, string>>({}), [restockChecks, setRestockChecks] = useState<Record<number, boolean>>({});
  const unavailable = useRef(true), sequence = useRef(0), forms = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const current = ++sequence.current; unavailable.current = true; setLoading(true); setReadError('');
    try {
      const result = await adminRequest<Snapshot>('operations', { action: 'warehouseRead', data: { orderId: order.id } });
      if (!Array.isArray(result?.lines) || !Array.isArray(result.parcels) || !Array.isArray(result.returns)) throw new Error('Incomplete warehouse response. Retry loading.');
      if (current !== sequence.current) return;
      setData(result); unavailable.current = false;
    } catch (cause) { if (current === sequence.current) setReadError(errorText(cause)); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [order.id]);
  useEffect(() => { void load(); return () => { ++sequence.current; unavailable.current = true; }; }, [load, order.shipments.length]);
  const write = useWarehouseWrite(async () => { await load(); await refreshOrders(); });
  useEffect(() => { if (data && !unavailable.current) write.loaded(); }, [data]);
  useEffect(() => { draftChanged(write.dirty || !!write.pending); return () => draftChanged(false); }, [write.dirty, write.pending]);
  const disabled = parentBlocked || write.needsReload || loading || !!readError || write.busy || !!write.pending;
  const reset = () => { setResetVersion(n => n + 1); setConditions({}); setRestockChecks({}); forms.current?.querySelectorAll('form').forEach(form => form.reset()); write.setDirty(false); };
  function parcel(event: React.FormEvent<HTMLFormElement>, fulfillmentId?: string) {
    event.preventDefault(); if (!data || !canRecord() || unavailable.current || write.blocked()) return;
    const form = event.currentTarget, f = new FormData(form);
    const items = data.lines.map(line => ({ lineIndex: line.lineIndex, quantity: Number(f.get(`quantity-${line.lineIndex}`)) })).filter(i => i.quantity > 0);
    if (!items.length) { setInputError('Enter at least one item quantity.'); return; }
    setInputError('');
    const reason = text(f, 'reason'), requestKey = crypto.randomUUID();
    void write.send(fulfillmentId ? { path: 'operations', body: { action: 'parcelContents', data: { orderId: order.id, fulfillmentId, items, reason, requestKey } }, receipt: 'parcelId', success: 'Earlier parcel contents recorded.' }
      : { path: 'fulfillment', body: { action: 'ship', orderId: order.id, requestKey, items, note: reason, carrier: text(f, 'carrier') || null, trackingNumber: text(f, 'trackingNumber') || null }, receipt: 'fulfillmentId', success: 'Parcel and its item quantities recorded.' }, () => { form.reset(); write.setDirty(false); });
  }
  function intake(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data || !canRecord() || unavailable.current || write.blocked()) return;
    const form = event.currentTarget, f = new FormData(form);
    const items = data.lines.map(line => ({ lineIndex: line.lineIndex, quantity: Number(f.get(`received-${line.lineIndex}`)),
      condition: text(f, `condition-${line.lineIndex}`), restock: f.has(`restock-${line.lineIndex}`) })).filter(i => i.quantity > 0);
    if (!items.length) { setInputError('Enter at least one item quantity.'); return; }
    setInputError('');
    void write.send({ path: 'operations', body: { action: 'receiveReturn', data: { orderId: order.id, requestKey: crypto.randomUUID(), reason: text(f, 'reason'), items } }, receipt: 'receiptId', success: 'Return intake recorded; only selected sellable units were added to stock.' }, () => { setConditions({}); setRestockChecks({}); form.reset(); write.setDirty(false); });
  }
  function inspect(form: HTMLFormElement, receiptId: string) {
    if (!data || !canRecord() || unavailable.current || write.blocked()) return;
    const f = new FormData(form), receipt = data.returns.find(r => r.id === receiptId);
    const items = (receipt?.inspectionPending ?? []).map(i => ({ lineIndex: i.lineIndex, quantity: Number(f.get(`inspected-${i.lineIndex}`)), disposition: text(f, `disposition-${i.lineIndex}`), restock: f.has(`inspection-restock-${i.lineIndex}`) })).filter(i => i.quantity > 0);
    if (!items.length) { setInputError('Enter at least one inspected quantity.'); return; }
    setInputError('');
    void write.send({ path: 'operations', body: { action: 'inspectReturn', data: { orderId: order.id, receiptId, items, reason: text(f,'reason'), requestKey: crypto.randomUUID() } }, receipt: 'inspectionId', success: 'Inspection decision recorded; only selected approved goods were restocked.' }, reset);
  }
  return <section aria-label={`Warehouse ${order.id}`} ref={forms} onChange={() => write.setDirty(true)}>
    <h3>Parcel contents and returns</h3>
    {write.feedback}<Feedback error message={inputError} /><Feedback error message={readError ? `${readError} Displayed quantities may be out of date.` : ''} />
    <button type="button" disabled={loading || write.busy} onClick={() => void load()}>{loading ? 'Loading quantities…' : 'Refresh quantities'}</button>
    {write.dirty && !write.pending && <button type="button" disabled={write.busy} onClick={reset}>Discard warehouse draft</button>}
    {data && <>
      <div className="ecom-admin__table-wrap"><table><thead><tr><th>Item</th><th>Ordered</th><th>Recorded shipped</th><th>Remaining</th><th>Received back</th></tr></thead><tbody>{data.lines.map(line => <tr key={line.lineIndex}><td>{line.name}</td><td>{line.quantity}</td><td>{line.shipped}</td><td>{line.remaining === null ? 'Earlier parcel contents needed' : line.remaining}</td><td>{line.received}</td></tr>)}</tbody></table></div>
      {data.unrecorded.length > 0 && <p>Earlier parcels have no item quantities. Record what actually shipped in each one before sending further parcels. Return restocking is available only where checkout saved the stock mapping.</p>}
      {data.unrecorded.map(parcel => <details key={parcel.id}><summary>Record earlier parcel contents · {dateTime(parcel.createdAt)}</summary>
        <form onSubmit={event => parcelForm(event, parcel.id)} aria-label={`Contents ${parcel.id}`}><p>{parcel.note}</p>{data.lines.map(line => <Field key={line.lineIndex} label={`${line.name} — units in earlier parcel`}><input name={`quantity-${line.lineIndex}`} type="number" min="0" max={line.quantity - line.shipped} step="1" defaultValue="0" disabled={disabled} /></Field>)}
          <Field label="Reason for recording contents"><input name="reason" required minLength={8} maxLength={500} disabled={disabled} /></Field><button type="submit" disabled={disabled}>Record parcel contents</button></form></details>)}
      {data.parcels.map(parcel => <div key={parcel.id} className="ecom-admin__email-record"><strong>Parcel {parcel.fulfillmentId}</strong><ul>{parcel.items.map(item => <li key={item.lineIndex}>{item.quantity} × {data.lines[item.lineIndex]?.name}</li>)}</ul>
        <small>{dateTime(parcel.createdAt)} · {parcel.actorName || parcel.actor} · {parcel.reason}</small><br /><button type="button" disabled={loading || !!readError} onClick={() => printParcel(data, parcel, order.shipments.find(s => s.id === parcel.fulfillmentId))}>Print packing slip</button></div>)}
      {order.canShip && !data.unrecorded.length && data.lines.some(line => (line.remaining ?? 0) > 0) && <form onSubmit={event => parcel(event)} aria-label="Item parcel">
        <h3>Record shipment</h3><p>Record the quantities that left in this parcel. The order completes automatically when every ordered unit has shipped.</p>
        {data.lines.map(line => <Field key={line.lineIndex} label={`${line.name} — units in this parcel (${line.remaining} remaining)`}><input type="number" name={`quantity-${line.lineIndex}`} min="0" max={line.remaining ?? 0} step="1" defaultValue="0" disabled={disabled || !line.remaining} /></Field>)}
        <div className="ecom-admin__grid"><Field label="Carrier"><input name="carrier" maxLength={100} disabled={disabled} /></Field><Field label="Tracking number"><input name="trackingNumber" maxLength={150} disabled={disabled} /></Field></div>
        <Field label="Shipment note"><input name="reason" required minLength={8} maxLength={500} disabled={disabled} /></Field><button type="submit" disabled={disabled}>Record shipment</button>
      </form>}
      {data.canReceive && <details><summary>Receive returned goods</summary><form aria-label="Return intake" onSubmit={intake}>
        <p>Count only goods physically received. Damaged goods and goods awaiting inspection stay out of sellable stock. This records inventory intake independently of the payment refund.</p>
        {data.lines.filter(line => line.returnable > 0).map(line => <fieldset className="ecom-admin__fields" key={line.lineIndex}><legend>{line.name} · {line.returnable} units can be received</legend>
          <Field label={`Received quantity — ${line.name}`}><input name={`received-${line.lineIndex}`} type="number" min="0" max={line.returnable} step="1" defaultValue="0" disabled={disabled} /></Field>
          <Field label={`Condition — ${line.name}`}><select aria-label={`Condition — ${line.name}`} name={`condition-${line.lineIndex}`} value={conditions[line.lineIndex] ?? "inspection"} disabled={disabled} onChange={event => setConditions(current => ({ ...current, [line.lineIndex]: event.target.value }))}><option value="inspection">Awaiting inspection</option><option value="sellable">Sellable</option><option value="damaged">Damaged</option></select></Field>
          <label className="ecom-admin__check"><input name={`restock-${line.lineIndex}`} type="checkbox" checked={(conditions[line.lineIndex] ?? "inspection") === "sellable" && !!restockChecks[line.lineIndex]} onChange={event => setRestockChecks(current => ({ ...current, [line.lineIndex]: event.target.checked }))} disabled={disabled || !line.restockMapped || (conditions[line.lineIndex] ?? "inspection") !== "sellable"} /> Restock received sellable units</label>
          {!line.restockMapped && <p>No checkout stock mapping is available. Receive without automatic restocking and reconcile any stock explicitly.</p>}
        </fieldset>)}
        <Field label="Reason for the return"><input name="reason" required minLength={8} maxLength={500} disabled={disabled} /></Field><button type="submit" disabled={disabled || !data.lines.some(line => line.returnable > 0)}>Record return intake</button>
      </form></details>}
      {data.returns.length > 0 && <><h4>Return intake history</h4><ul>{data.returns.map(receipt => <li key={receipt.id}>{dateTime(receipt.createdAt)} · {receipt.actorName || receipt.actor} · {receipt.reason}<ul>{receipt.items.map(item => <li key={item.lineIndex}>{item.quantity} × {data.lines[item.lineIndex]?.name} · {item.condition} · {item.restock ? 'Restocked' : 'Kept out of stock'}</li>)}</ul>
        {(receipt.inspections ?? []).map(decision => <div key={decision.id}><small>{dateTime(decision.createdAt)} · {decision.actorName} · {decision.reason}</small><ul>{decision.items.map(i => <li key={i.lineIndex}>{i.quantity} × {data.lines[i.lineIndex]?.name} · {i.disposition} · {i.restock ? 'Restocked' : 'Kept out of stock'}</li>)}</ul></div>)}
        <ReturnInspection key={`${receipt.id}:${resetVersion}`} receipt={receipt} lines={data.lines} disabled={disabled} submit={inspect} />
      </li>)}</ul></>}
    </>}
  </section>;
  function parcelForm(event: React.FormEvent<HTMLFormElement>, fulfillmentId: string) { parcel(event, fulfillmentId); }
}
