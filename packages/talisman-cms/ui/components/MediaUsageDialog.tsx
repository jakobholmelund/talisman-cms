import React, { useId } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from '../lib/use-modal-dialog';
import { Button } from './ui/button';
import { MediaUsageReview } from './MediaUsageReview';

export function MediaUsageDialog({ id, filename, adminPath, onClose, getReturnFocus }: {
  id: string; filename: string; adminPath: string; onClose: () => void; getReturnFocus: () => HTMLElement | null;
}) {
  const titleId = useId();
  const dialogRef = useModalDialog<HTMLDivElement>({ open: true, onClose, getReturnFocus, inertOutside: true });
  return createPortal(<div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className="max-h-[calc(100dvh-2rem)] w-full max-w-lg space-y-5 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950 p-6 shadow-2xl">
      <h2 id={titleId} className="text-lg font-semibold text-white">Usage of {filename}</h2>
      <MediaUsageReview id={id} adminPath={adminPath} showAcknowledgment={false} />
      <div className="flex justify-end"><Button type="button" variant="outline" onClick={onClose}>Close</Button></div>
    </div>
  </div>, document.getElementById('talisman-root') || document.body);
}
