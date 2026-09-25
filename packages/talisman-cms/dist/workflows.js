import {
  runPublishingTransition
} from "./chunk-2KNJPUUL.js";
import "./chunk-QDILJIDR.js";
import "./chunk-XG3TKNL6.js";
import "./chunk-MLKGABMK.js";

// src/workflows.ts
import { WorkflowEntrypoint } from "cloudflare:workers";
var TalismanPublishWorkflow = class extends WorkflowEntrypoint {
  async run(event, step) {
    return step.do("apply publish transition", async () => {
      const entry = await runPublishingTransition(this.env, event.payload);
      return {
        ok: true,
        entryId: entry.id,
        status: entry.status
      };
    });
  }
};
export {
  TalismanPublishWorkflow
};
