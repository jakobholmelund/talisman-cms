import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { T as TalismanEnv } from './client-BnymGq0d.js';
import { PublishWorkflowPayload, PublishWorkflowResult } from './versioning.js';
import 'drizzle-orm/d1';
import 'drizzle-orm';
import './actor-Daa_hmny.js';
import './types-C5a-hx5D.js';
import 'astro';
import './query-DgmKqS5C.js';
import './db/schema.js';
import 'drizzle-orm/sqlite-core';

declare class TalismanPublishWorkflow extends WorkflowEntrypoint<TalismanEnv, PublishWorkflowPayload> {
    run(event: Readonly<WorkflowEvent<PublishWorkflowPayload>>, step: WorkflowStep): Promise<PublishWorkflowResult>;
}

export { TalismanPublishWorkflow };
