import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0);
}

/**
 * Keyboard behaviour for a modal dialog: focus moves into it when it opens, Tab stays inside it,
 * Escape closes it, and focus goes back to where it was when it closes. Attach the returned ref to
 * the element with role="dialog". `getReturnFocus` names an element to focus on close when the one
 * that opened the dialog is gone (for example a picker button that closed itself). `inertOutside`
 * also makes the page behind the dialog inert while it is open, where the browser supports `inert`.
 */
export function useModalDialog<T extends HTMLElement>({
  open,
  onClose,
  getReturnFocus,
  inertOutside = false,
}: {
  open: boolean;
  onClose: () => void;
  getReturnFocus?: () => HTMLElement | null | undefined;
  inertOutside?: boolean;
}) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  const getReturnFocusRef = useRef(getReturnFocus);
  onCloseRef.current = onClose;
  getReturnFocusRef.current = getReturnFocus;

  // Declared before the focus effect below, so its cleanup lifts `inert` before focus returns to the page.
  useEffect(() => {
    if (!open || !inertOutside || !('inert' in HTMLElement.prototype)) return;
    const dialog = dialogRef.current;
    const root = document.getElementById('talisman-root');
    if (!dialog || !root) return;
    const outside = Array.from(root.children).filter((child): child is HTMLElement => child instanceof HTMLElement && !child.contains(dialog) && !child.inert);
    outside.forEach((element) => { element.inert = true; });
    return () => outside.forEach((element) => { element.inert = false; });
  }, [open, inertOutside]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      // Start on the first control of the content rather than on the Close button.
      const focusable = getFocusableElements(dialog);
      const first = focusable.find((element) => element.dataset.dialogClose === undefined) || focusable[0];
      (first || dialog).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const current = dialogRef.current;
      if (!current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(current);
      if (focusable.length === 0) {
        event.preventDefault();
        current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      // Effect cleanup runs after React has removed the dialog, so the page can take focus again.
      const target = opener && opener.isConnected && !dialogRef.current?.contains(opener)
        ? opener
        : getReturnFocusRef.current?.();
      target?.focus();
    };
  }, [open]);

  return dialogRef;
}
