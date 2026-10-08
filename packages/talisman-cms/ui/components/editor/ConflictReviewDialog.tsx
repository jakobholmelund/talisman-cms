import React, { useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/button';
import { SnapshotValue } from './SnapshotValue';
import { useModalDialog } from '../../lib/use-modal-dialog';
import { applyConflictChoices, compareConflictFields, type ConflictChoice, type ConflictSnapshot } from '../../lib/revision-comparison';

export default function ConflictReviewDialog({ original, mine, latest, fields, onClose, onApply, getReturnFocus }: {
  original: ConflictSnapshot;
  mine: ConflictSnapshot;
  latest: ConflictSnapshot;
  fields: any[];
  onClose: () => void;
  onApply: (resolved: ConflictSnapshot) => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const id = useId();
  const dialogRef = useModalDialog<HTMLDivElement>({ open: true, onClose, getReturnFocus, inertOutside: true });
  const rows = useMemo(() => compareConflictFields(fields, original, mine, latest), [fields, original, mine, latest]);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [page, setPage] = useState(0);
  const unresolved = rows.filter(row => row.kind === 'overlap' && !Object.hasOwn(choices, row.key)).length;
  const visible = rows.slice(page * 20, (page + 1) * 20);
  return createPortal(<div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1} className="max-h-[calc(100dvh-2rem)] w-full max-w-6xl space-y-5 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950 p-6 text-zinc-200 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><h2 id={`${id}-title`} className="text-lg font-semibold text-white">Review conflicting changes</h2><Button type="button" variant="outline" data-dialog-close onClick={onClose}>Cancel review</Button></div>
      <p id={`${id}-description`} className="text-sm text-zinc-400">Compare your edits with the latest saved version loaded in this editor. Choose a value for fields both editors changed. Applying choices updates the form; save separately to store them. Other fields keep their latest saved values.</p>
      <p role="status" className="text-sm text-amber-200">{unresolved ? `${unresolved} ${unresolved === 1 ? 'field needs' : 'fields need'} a choice.` : 'All fields are ready to apply.'}</p>
      <div className="space-y-4">{visible.map(row => <section key={row.key} aria-label={row.label} className="space-y-3 rounded-lg border border-white/10 p-4">
        <h3 className="font-medium">{row.label}</h3>
        <p className={`text-sm ${row.kind === 'overlap' ? 'text-amber-300' : 'text-zinc-400'}`}>{row.kind === 'overlap' ? 'Both editors changed this field.' : row.kind === 'already-saved' ? 'Your value is already saved.' : 'Only you changed this field.'}</p>
        <div className="grid gap-4 md:grid-cols-3">{([
          ['Originally opened', row.original], ['Your edits', row.mine], ['Latest saved', row.latest],
        ] as const).map(([label, value]) => <div key={label} className="min-w-0 space-y-2"><h4 className="text-xs font-medium text-zinc-400">{label}</h4><div className="rounded-md bg-white/[0.02] p-3 text-sm"><SnapshotValue value={value} field={row.field} /></div></div>)}</div>
        {row.kind !== 'already-saved' && <div className="flex flex-col gap-2 text-sm text-zinc-300"><label htmlFor={`${id}-${row.key}`}>Value to keep for {row.label}</label>
          <select id={`${id}-${row.key}`} value={choices[row.key] || (row.kind === 'mine-only' ? 'mine' : '')} onChange={event => setChoices(previous => ({ ...previous, [row.key]: event.target.value as ConflictChoice }))} className="h-10 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50">
            {row.kind === 'overlap' && <option value="" disabled>Choose a value</option>}<option value="mine">Keep my edits</option><option value="latest">Keep latest saved</option>
          </select>
        </div>}
      </section>)}</div>
      {rows.length > 20 && <nav aria-label="Conflict fields" className="flex items-center justify-between gap-3"><Button type="button" variant="outline" aria-disabled={page === 0 || undefined} onClick={() => { if (page > 0) setPage(page - 1); }}>Previous fields</Button><span role="status" className="text-sm text-zinc-400">Fields {page * 20 + 1}–{Math.min((page + 1) * 20, rows.length)} of {rows.length}</span><Button type="button" variant="outline" aria-disabled={(page + 1) * 20 >= rows.length || undefined} onClick={() => { if ((page + 1) * 20 < rows.length) setPage(page + 1); }}>Next fields</Button></nav>}
      <Button type="button" aria-disabled={unresolved > 0 || undefined} onClick={() => { if (!unresolved) onApply(applyConflictChoices(latest, mine, rows, choices)); }}>Apply choices to form</Button>
    </div>
  </div>, document.getElementById('talisman-root') || document.body);
}
