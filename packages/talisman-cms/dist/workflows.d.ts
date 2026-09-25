import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { TalismanEnv } from './client.js';
import { PublishWorkflowPayload } from './versioning.js';
import 'drizzle-orm/d1';
import './media-Cm407HSH.js';
import 'drizzle-orm/sqlite-core';

declare class TalismanPublishWorkflow extends WorkflowEntrypoint<TalismanEnv, PublishWorkflowPayload> {
    run(event: Readonly<WorkflowEvent<PublishWorkflowPayload>>, step: WorkflowStep): Promise<{
        ok: true;
        entryId: string;
        status: "draft" | "published" | "archived";
    }>;
}

export { TalismanPublishWorkflow };
