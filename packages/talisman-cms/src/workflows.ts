import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { TalismanEnv } from './db/client';
import {
  invalidateEntryCache,
  isPermanentPublishError,
  runPublishingTransition,
  type PublishWorkflowPayload,
  type PublishWorkflowResult
} from './versioning';

export class TalismanPublishWorkflow extends WorkflowEntrypoint<TalismanEnv, PublishWorkflowPayload> {
  async run(event: Readonly<WorkflowEvent<PublishWorkflowPayload>>, step: WorkflowStep): Promise<PublishWorkflowResult> {
    const { collectionSlug, entryId } = event.payload;
    const result = await step.do('apply publish transition', async (): Promise<PublishWorkflowResult> => {
      try {
        const entry = await runPublishingTransition(this.env, event.payload);
        return { ok: true, entryId: entry.id, status: entry.status };
      } catch (error) {
        // A stale revision or a taken slug fails the same way on every retry. It is returned rather
        // than thrown, so the step is not retried and the waiting request reads the error from the
        // instance output. (A thrown NonRetryableError keeps its message only with the
        // workflows_preserve_non_retryable_error_message compatibility flag.) Other errors are retried.
        if (isPermanentPublishError(error)) {
          return { ok: false, error: { name: (error as Error).name, message: (error as Error).message } };
        }
        throw error;
      }
    });
    if (!result.ok) return result;

    // The site reads entries through the KV cache, which this Worker shares with the site Worker.
    await step.do('invalidate cached entries', async () => {
      await invalidateEntryCache(this.env, collectionSlug, entryId);
      return { ok: true };
    });

    return result;
  }
}
