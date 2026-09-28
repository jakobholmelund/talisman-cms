import { scheduledJobs } from 'virtual:talisman-cms/scheduled';

/** What a scheduled job receives on each cron tick. */
export interface ScheduledJobEvent {
  /** The cron expression that fired, for a job that runs on some ticks only. */
  cron: string;
  /** The time the tick was scheduled for, in milliseconds since the epoch. */
  scheduledTime: number;
  /** The Worker bindings. */
  env: Record<string, unknown>;
  /** Keeps the invocation alive until the task settles, as `ExecutionContext.waitUntil` does. */
  waitUntil: (task: Promise<unknown>) => void;
}

/** A plugin's scheduled job: the export `Plugin.scheduled` names. */
export type ScheduledJob = (event: ScheduledJobEvent) => Promise<void> | void;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

/**
 * Runs every job in order. A job that throws or rejects is logged as
 * `[talisman-cms] <plugin> scheduled job failed: <message>` and never skips the next one. After the
 * run, one error naming the failed plugins is thrown when any job failed, so the platform records the
 * invocation as failed. An export that is not a function counts as a failure.
 */
export async function runScheduledJobs(jobs: Array<{ plugin: string; job: ScheduledJob }>, event: ScheduledJobEvent): Promise<void> {
  const failed: string[] = [];
  for (const { plugin, job } of jobs) {
    try {
      if (typeof job !== 'function') {
        throw new Error(`the scheduled export is ${job === undefined ? 'missing' : `not a function but ${typeof job}`}; check the plugin's scheduled.exportName`);
      }
      await job(event);
    } catch (error) {
      console.error(`[talisman-cms] ${plugin} scheduled job failed: ${errorMessage(error)}`, error);
      failed.push(plugin);
    }
  }
  if (failed.length) {
    throw new Error(`[talisman-cms] ${failed.length === 1 ? 'A scheduled job' : `${failed.length} scheduled jobs`} failed: ${failed.join(', ')}`);
  }
}

/**
 * The Worker's scheduled handler: runs the job of every plugin that declares `scheduled`, in
 * registration order. A site exports it from its Worker entry next to Astro's fetch handler:
 * `export default { fetch: handle, scheduled }`.
 */
export function scheduled(controller: ScheduledController, env: unknown, ctx: ExecutionContext): Promise<void> {
  return runScheduledJobs(scheduledJobs, {
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
    env: (env && typeof env === 'object' ? env : {}) as Record<string, unknown>,
    waitUntil: (task) => ctx.waitUntil(task),
  });
}
