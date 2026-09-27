import {
  invalidateEntryCache,
  isPermanentPublishError,
  runPublishingTransition
} from "./chunk-B33VKPHM.js";
import "./chunk-NSKY6EIU.js";
import "./chunk-R6EGKTST.js";
import "./chunk-MLKGABMK.js";

// src/workflows.ts
import { WorkflowEntrypoint } from "cloudflare:workers";
var TalismanPublishWorkflow = class extends WorkflowEntrypoint {
  async run(event, step) {
    const { collectionSlug, entryId } = event.payload;
    const result = await step.do("apply publish transition", async () => {
      try {
        const entry = await runPublishingTransition(this.env, event.payload);
        return { ok: true, entryId: entry.id, status: entry.status };
      } catch (error) {
        if (isPermanentPublishError(error)) {
          return { ok: false, error: { name: error.name, message: error.message } };
        }
        throw error;
      }
    });
    if (!result.ok) return result;
    await step.do("invalidate cached entries", async () => {
      await invalidateEntryCache(this.env, collectionSlug, entryId);
      return { ok: true };
    });
    return result;
  }
};
export {
  TalismanPublishWorkflow
};
