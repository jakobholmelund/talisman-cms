import { ScheduledJobEvent } from 'talisman-cms/worker';

/**
 * The plugin's scheduled job, registered through `Plugin.scheduled` and run on every cron tick by the
 * handler from `talisman-cms/worker`. It reconciles checkouts with the payment providers configured in
 * the Worker, then purges data past its retention period. The two steps are independent: a failure in
 * one never skips the other. When either failed, the job throws one error that names both, so the
 * invocation is recorded as failed. Failures are logged as `[Commerce] Checkout reconciliation failed`
 * and `[Commerce] Data retention cleanup failed`.
 */
declare function scheduled(event: ScheduledJobEvent): Promise<void>;

export { scheduled };
