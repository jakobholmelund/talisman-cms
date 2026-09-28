import type { TalismanEnv } from 'talisman-cms/client';
import type { ScheduledJobEvent } from 'talisman-cms/worker';
import { purgeStaleCommerceData, reconcileCommerce } from './api';
import { runtimePaymentAdapters } from './runtime';

/**
 * The plugin's scheduled job, registered through `Plugin.scheduled` and run on every cron tick by the
 * handler from `talisman-cms/worker`. It reconciles checkouts with the payment providers configured in
 * the Worker, then purges data past its retention period. The two steps are independent: a failure in
 * one never skips the other. When either failed, the job throws one error that names both, so the
 * invocation is recorded as failed. Failures are logged as `[Commerce] Checkout reconciliation failed`
 * and `[Commerce] Data retention cleanup failed`.
 */
export async function scheduled(event: ScheduledJobEvent): Promise<void> {
  const env = event.env as TalismanEnv;
  const errors: string[] = [];
  try {
    const results = await reconcileCommerce({ env, paymentAdapters: runtimePaymentAdapters(event.env) });
    const failures = results.filter((result) => result.status === 'error');
    if (failures.length) {
      console.error('[Commerce] Checkout reconciliation failed', failures);
      errors.push(`${failures.length} checkout reconciliation attempts failed`);
    }
  } catch (error) {
    console.error('[Commerce] Checkout reconciliation failed', error);
    errors.push('Checkout reconciliation failed');
  }
  try {
    await purgeStaleCommerceData({ env });
  } catch (error) {
    console.error('[Commerce] Data retention cleanup failed', error);
    errors.push('Data retention cleanup failed');
  }
  if (errors.length) throw new Error(errors.join('; '));
}
