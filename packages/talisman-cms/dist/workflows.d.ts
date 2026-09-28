import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { T as TalismanEnv } from './client-BYOu0i3b.js';
import { PublishWorkflowPayload, PublishWorkflowResult } from './versioning.js';
import 'drizzle-orm/d1';
import './media-CIuK48g5.js';
import 'drizzle-orm/sqlite-core';
import './actor-Daa_hmny.js';
import './types-C5a-hx5D.js';
import 'astro';

declare class TalismanPublishWorkflow extends WorkflowEntrypoint<TalismanEnv, PublishWorkflowPayload> {
    run(event: Readonly<WorkflowEvent<PublishWorkflowPayload>>, step: WorkflowStep): Promise<PublishWorkflowResult>;
}

export { TalismanPublishWorkflow };
