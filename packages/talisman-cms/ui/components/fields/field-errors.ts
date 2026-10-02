import { createContext } from 'react';

/**
 * Field errors can be strings, Standard Schema issues ({ message }) or nested
 * arrays of either. Returns readable, de-duplicated messages.
 */
export function formatFieldErrors(errors: unknown): string[] {
  const messages: string[] = [];
  const visit = (error: unknown) => {
    if (error === null || error === undefined || error === false || error === '') return;
    if (Array.isArray(error)) {
      error.forEach(visit);
      return;
    }
    if (typeof error === 'string') {
      messages.push(error);
      return;
    }
    if (typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) {
        messages.push(message);
        return;
      }
      Object.values(error as Record<string, unknown>).forEach(visit);
      return;
    }
    messages.push(String(error));
  };
  visit(errors);
  return [...new Set(messages)];
}

/** Server-side field errors keyed by form field path (for example `layout[0].title`). */
export type ServerFieldErrors = Record<string, string[]>;

export const ServerFieldErrorsContext = createContext<{
  errors: ServerFieldErrors;
  clearError: (fieldPath: string) => void;
}>({ errors: {}, clearError: () => {} });

/** Open a closed inspector before focusing a nested field from the error summary. */
export const FIELD_FOCUS_EVENT = 'talisman:focus-field';
export function focusFieldControl(fieldPath: string, attempts = 0) {
  const fields = Array.from(document.querySelectorAll<HTMLElement>(`[data-field-path="${CSS.escape(fieldPath)}"]`));
  const field = fields.find((candidate) => !candidate.closest('[inert], [hidden]') && candidate.getClientRects().length > 0);
  const control = field?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], button:not([disabled])');
  if (control || field) { (control || field)?.focus(); return; }
  if (attempts >= 4) return;
  document.dispatchEvent(new CustomEvent(FIELD_FOCUS_EVENT, { detail: { fieldPath, attempts } }));
}
