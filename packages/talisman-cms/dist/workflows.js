import {
  runPublishingTransition
} from "./chunk-M47S7VHS.js";
import "./chunk-ACDUZVLI.js";
import "./chunk-MR6IJMXT.js";
import "./chunk-VVR3XKHB.js";
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
