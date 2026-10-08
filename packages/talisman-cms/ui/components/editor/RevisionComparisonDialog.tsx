import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/button';
import { SnapshotValue } from './SnapshotValue';
import { useModalDialog } from '../../lib/use-modal-dialog';
import { describeRequestError, requestEditorApi } from '../../lib/entry-editor-data';
import { compareRevisionFields, revisionData, type RevisionFieldComparison } from '../../lib/revision-comparison';

export default function RevisionComparisonDialog({ revision, savedEntry, fields, url, hasUnsavedWork, onClose }: {
  revision: any;
  savedEntry: any;
  fields: any[];
  url: string;
  hasUnsavedWork: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [rows, setRows] = useState<RevisionFieldComparison[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const dialogRef = useModalDialog<HTMLDivElement>({ open: true, onClose, inertOutside: true });
  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    setError('');
    requestEditorApi(url, { signal: controller.signal }, 'Could not load this revision').then(snapshot => {
      const comparisons = compareRevisionFields(fields, revisionData(snapshot), revisionData(savedEntry));
      if (!controller.signal.aborted) setRows(comparisons);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(describeRequestError(cause));
    });
    return () => controller.abort();
  }, [url, attempt, fields, savedEntry]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const changed = rows?.filter(row => row.change !== 'unchanged') || [];
  const visible = showUnchanged ? rows || [] : changed;
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} className="max-h-[calc(100dvh-2rem)] w-full max-w-5xl space-y-5 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950 p-6 text-zinc-200 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-white">Compare revision #{revision.revisionNumber}</h2>
          <Button type="button" variant="outline" data-dialog-close onClick={onClose}>Close preview</Button>
        </div>
        <p id={descriptionId} className="text-sm text-zinc-400">Read-only comparison with the saved version loaded in this editor. {hasUnsavedWork ? 'Your unsaved edits are excluded and remain in the editor.' : 'Opening this preview does not change the entry.'}</p>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <p>Revision #{revision.revisionNumber} · {revision.status} · {new Date(revision.createdAt).toLocaleString()}</p>
          <p>Saved version · {savedEntry.status} · {new Date(savedEntry.updatedAt).toLocaleString()}</p>
        </div>
        <p role="status" className="text-sm text-zinc-400">{error ? 'Revision preview unavailable.' : rows ? `${changed.length} ${changed.length === 1 ? 'field differs' : 'fields differ'}.` : 'Loading revision…'}</p>
        {error && <div className="space-y-3"><p ref={errorRef} role="alert" tabIndex={-1} className="text-rose-300 focus:outline-none">{error} Your edits remain in the editor.</p><Button type="button" variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry preview</Button></div>}
        {rows && <>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showUnchanged} onChange={event => setShowUnchanged(event.target.checked)} /> Show unchanged fields</label>
          {changed.length === 0 && <p className="rounded-lg border border-white/10 p-4 text-sm">No content changes between these versions.</p>}
          <div className="space-y-4">
            {visible.slice(0, 100).map(row => <section key={row.name} aria-label={row.label} className="space-y-3 rounded-lg border border-white/10 p-4">
              <h3 className="flex items-center gap-3 font-medium">{row.label}<span className="text-xs text-zinc-400">{row.change === 'added' ? 'Added in saved version' : row.change === 'removed' ? 'Removed from saved version' : row.change === 'changed' ? 'Changed' : 'Unchanged'}</span></h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-2"><h4 className="text-xs font-medium text-amber-300">Revision #{revision.revisionNumber}</h4><div className="rounded-md bg-white/[0.02] p-3 text-sm"><SnapshotValue value={row.before} field={row.field} /></div></div>
                <div className="min-w-0 space-y-2"><h4 className="text-xs font-medium text-indigo-300">Saved version</h4><div className="rounded-md bg-white/[0.02] p-3 text-sm"><SnapshotValue value={row.after} field={row.field} /></div></div>
              </div>
            </section>)}
            {visible.length > 100 && <p className="text-sm text-zinc-400">{visible.length - 100} more fields omitted from this preview.</p>}
          </div>
        </>}
      </div>
    </div>, document.getElementById('talisman-root') || document.body
  );
}
