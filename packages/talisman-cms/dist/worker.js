import "./chunk-MLKGABMK.js";

// src/worker.ts
import { scheduledJobs } from "virtual:talisman-cms/scheduled";
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}
async function runScheduledJobs(jobs, event) {
  const failed = [];
  for (const { plugin, job } of jobs) {
    try {
      if (typeof job !== "function") {
        throw new Error(`the scheduled export is ${job === void 0 ? "missing" : `not a function but ${typeof job}`}; check the plugin's scheduled.exportName`);
      }
      await job(event);
    } catch (error) {
      console.error(`[talisman-cms] ${plugin} scheduled job failed: ${errorMessage(error)}`, error);
      failed.push(plugin);
    }
  }
  if (failed.length) {
    throw new Error(`[talisman-cms] ${failed.length === 1 ? "A scheduled job" : `${failed.length} scheduled jobs`} failed: ${failed.join(", ")}`);
  }
}
function scheduled(controller, env, ctx) {
  return runScheduledJobs(scheduledJobs, {
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
    env: env && typeof env === "object" ? env : {},
    waitUntil: (task) => ctx.waitUntil(task)
  });
}
export {
  runScheduledJobs,
  scheduled
};
