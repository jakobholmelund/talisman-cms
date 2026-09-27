import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { T as TalismanEnv } from './client-D5mWOXyL.js';
import { PublishWorkflowPayload, PublishWorkflowResult } from './versioning.js';
import 'drizzle-orm/d1';
import './media-Cm407HSH.js';
import 'drizzle-orm/sqlite-core';
import './actor-BAnSg_qp.js';
import './types-B9Ys5hZL.js';
import 'astro';

declare class TalismanPublishWorkflow extends WorkflowEntrypoint<TalismanEnv, PublishWorkflowPayload> {
    run(event: Readonly<WorkflowEvent<PublishWorkflowPayload>>, step: WorkflowStep): Promise<PublishWorkflowResult>;
}

export { TalismanPublishWorkflow };
