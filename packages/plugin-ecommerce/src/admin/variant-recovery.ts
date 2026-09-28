// How the product editor's Options & stock panel recovers from a failed change, which the variants
// endpoint applies in one batch. Pure functions over the core's SaveFailure shape.
import { isStaleRecordConflict, type SaveFailure } from 'talisman-cms/ui/lib/entry-save';

export type { SaveFailure };

/**
 * - `keep`: the server refused the change and wrote nothing, so the edits stay for another try;
 * - `reload`: the rows changed or are gone since they were loaded, so the saved ones are loaded;
 * - `unknown`: no answer says what happened (no connection, a server error, an unreadable body), so
 *   the change may have been saved, and the saved rows are loaded before a value is created again.
 */
export function getVariantChangeRecovery(failure: SaveFailure): 'keep' | 'reload' | 'unknown' {
  if (failure.status === 404 || isStaleRecordConflict(failure)) return 'reload';
  return failure.status >= 400 && failure.status < 500 ? 'keep' : 'unknown';
}

const asSentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The message after a failed change that the panel answered by loading the saved rows (`reload` or
 * `unknown` above). When they loaded, the panel shows them instead of the edits; when they did not,
 * the edits are still there. The message says which.
 */
export function describeVariantChangeFailure(failure: SaveFailure, failedAction: string, reloaded: boolean) {
  if (isStaleRecordConflict(failure)) {
    return 'This option or its stock changed after the page loaded, for example because a checkout reserved stock, so the change was refused. '
      + (reloaded ? 'The latest values are loaded now; make your change again.' : 'Load the latest values, then make your change again.');
  }
  if (failure.status === 404) {
    return `${asSentence(failure.message)} ${reloaded ? 'The latest options and stock are loaded now.' : 'Load the latest options and stock.'}`;
  }
  // The message of a lost answer says the edits are still here, which is not true after a reload.
  const reason = failure.status === 0 ? `${failedAction}: the server could not be reached.` : asSentence(failure.message);
  return reloaded
    ? `${reason} The saved options and stock are loaded again: check them, and make the change again if it is missing.`
    : `${reason} The saved options and stock could not be loaded to check whether it was saved. `
      + 'Your edits are still here; load the latest options and stock before creating a value.';
}
