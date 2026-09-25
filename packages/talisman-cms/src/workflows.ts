import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { TalismanEnv } from './db/client';
import { runPublishingTransition, type PublishWorkflowPayload } from './versioning';

export class TalismanPublishWorkflow extends WorkflowEntrypoint<TalismanEnv, PublishWorkflowPayload> {
  async run(event: Readonly<WorkflowEvent<PublishWorkflowPayload>>, step: WorkflowStep) {
    return step.do('apply publish transition', async () => {
      const entry = await runPublishingTransition(this.env, event.payload);
      return {
        ok: true,
        entryId: entry.id,
        status: entry.status,
      };
    });
  }
}
