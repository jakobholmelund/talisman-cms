import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';
import { useModalDialog } from '../lib/use-modal-dialog';
import { describeRequestError, EditorRequestError, requestEditorApi } from '../lib/entry-editor-data';

/** A destructive action starts on Cancel, keeps focus while busy, and leaves the dialog open on failure. */
export function DeleteConfirmation({ title, url, warning, onClose, onDeleted, getReturnFocus }: {
  title: string;
  url: string;
  warning: string;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
  getReturnFocus?: () => HTMLElement | null;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleted, setDeleted] = useState(false);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const dialogRef = useModalDialog<HTMLDivElement>({ open: true, onClose: () => { if (!busyRef.current) onClose(); }, getReturnFocus, inertOutside: true });
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const remove = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (!deleted) await requestEditorApi(url, { method: 'DELETE' }, 'Deletion failed');
    } catch (cause) {
      // A retry after an uncertain network response may find the entry already gone.
      if (!(cause instanceof EditorRequestError && cause.status === 404)) {
        setError(`${describeRequestError(cause)} Nothing has been removed from this screen. You can cancel or try again.`);
        busyRef.current = false;
        setBusy(false);
        return;
      }
    }
    setDeleted(true);
    try {
      await onDeleted();
    } catch {
      setError('Deleted successfully, but the updated view could not be opened. Try Continue, or cancel and refresh the page.');
      busyRef.current = false;
      setBusy(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} className="w-full max-w-lg space-y-5 rounded-xl border border-white/10 bg-zinc-950 p-6 shadow-2xl">
        <h2 id={titleId} className="text-lg font-semibold text-white">{title}</h2>
        <p id={descriptionId} className="text-sm text-zinc-300">{warning} This cannot be undone.</p>
        {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-red-300 focus:outline-none">{error}</p>}
        <p role="status" className="sr-only">{busy ? 'Deleting…' : ''}</p>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" aria-disabled={busy || undefined} onClick={() => { if (!busyRef.current) onClose(); }}>Cancel</Button>
          <Button type="button" variant="destructive" aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => void remove()}>{busy ? deleted ? 'Opening updated view…' : 'Deleting…' : deleted ? 'Continue' : 'Delete permanently'}</Button>
        </div>
      </div>
    </div>, document.getElementById('talisman-root') || document.body
  );
}
