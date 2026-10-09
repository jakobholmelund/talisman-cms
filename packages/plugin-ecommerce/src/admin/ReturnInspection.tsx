import React, { useState } from 'react';
import type { readOrderWarehouse } from '@talisman-cms/plugin-ecommerce/operations';
import { Field } from './common';
type Snapshot = Awaited<ReturnType<typeof readOrderWarehouse>>;
export default function ReturnInspection({ receipt, lines, disabled, submit }: { receipt: Snapshot['returns'][number]; lines: Snapshot['lines']; disabled: boolean; submit: (form: HTMLFormElement, receiptId: string) => void }) {
  const [choices, setChoices] = useState<Record<number,string>>({}), [checks, setChecks] = useState<Record<number,boolean>>({});
  const pending = receipt.inspectionPending?.filter(i => i.quantity > 0) ?? [];
  if (!pending.length) return null;
  return <details><summary>Inspect received goods · {pending.reduce((n,i) => n+i.quantity,0)} pending</summary>
    <form aria-label={`Inspect return ${receipt.id}`} onSubmit={event => { event.preventDefault(); submit(event.currentTarget, receipt.id); }}>
      <p>Resolve only goods already received and awaiting inspection. A decision does not receive them again or refund payment. Quarantined and damaged units stay out of available stock.</p>
      {pending.map(item => { const line = lines[item.lineIndex], disposition = choices[item.lineIndex] ?? 'quarantine'; return <fieldset key={item.lineIndex} disabled={disabled}>
        <legend>{line?.name} · {item.quantity} awaiting inspection</legend>
        <Field label={`Units inspected — ${line?.name}`}><input name={`inspected-${item.lineIndex}`} type="number" min="0" max={item.quantity} step="1" defaultValue="0" /></Field>
        <Field label={`Inspection result — ${line?.name}`}><select aria-label={`Inspection result — ${line?.name}`} name={`disposition-${item.lineIndex}`} value={disposition} onChange={e => setChoices(current => ({ ...current, [item.lineIndex]: e.target.value }))}>
          <option value="quarantine">Quarantine</option><option value="sellable">Approved sellable</option><option value="damaged">Damaged / discard</option>
        </select></Field>
        <label className="ecom-admin__check"><input name={`inspection-restock-${item.lineIndex}`} type="checkbox" checked={disposition === 'sellable' && !!checks[item.lineIndex]} disabled={!line?.restockMapped || disposition !== 'sellable'} onChange={e => setChecks(current => ({ ...current, [item.lineIndex]: e.target.checked }))} /> Add approved units to available stock</label>
        {!line?.restockMapped && <p>No checkout stock mapping is available. Resolve the inspection without automatic restocking and reconcile stock explicitly.</p>}
      </fieldset>; })}
      <Field label="Reason for inspection decision"><input name="reason" required minLength={8} maxLength={500} disabled={disabled} /></Field>
      <button type="submit" disabled={disabled}>Record inspection decision</button>
    </form>
  </details>;
}
