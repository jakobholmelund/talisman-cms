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

/**
 * Moves focus to the control of the field at `fieldPath`, found through the `data-field-path` the
 * renderer puts on each field. Nothing happens when the field is not on the page (a block's fields
 * only render in the inspector).
 */
export function focusFieldControl(fieldPath: string) {
  const field = document.querySelector<HTMLElement>(`[data-field-path="${CSS.escape(fieldPath)}"]`);
  const control = field?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, [contenteditable="true"], button');
  (control || field)?.focus();
}
