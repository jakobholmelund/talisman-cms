/** What a scheduled job receives on each cron tick. */
interface ScheduledJobEvent {
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
type ScheduledJob = (event: ScheduledJobEvent) => Promise<void> | void;
/**
 * Runs every job in order. A job that throws or rejects is logged as
 * `[talisman-cms] <plugin> scheduled job failed: <message>` and never skips the next one. After the
 * run, one error naming the failed plugins is thrown when any job failed, so the platform records the
 * invocation as failed. An export that is not a function counts as a failure.
 */
declare function runScheduledJobs(jobs: Array<{
    plugin: string;
    job: ScheduledJob;
}>, event: ScheduledJobEvent): Promise<void>;
/**
 * The Worker's scheduled handler: runs the job of every plugin that declares `scheduled`, in
 * registration order. A site exports it from its Worker entry next to Astro's fetch handler:
 * `export default { fetch: handle, scheduled }`.
 */
declare function scheduled(controller: ScheduledController, env: unknown, ctx: ExecutionContext): Promise<void>;

export { type ScheduledJob, type ScheduledJobEvent, runScheduledJobs, scheduled };
