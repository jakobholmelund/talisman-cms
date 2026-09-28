import { AstroIntegration } from 'astro';
import { T as TalismanAuthAdapter } from './types-B9Ys5hZL.js';
import { E as EmailRuntimeDescriptor } from './types-CqOBvOgc.js';
import { C as CollectionConfig, G as GlobalConfig, P as Plugin } from './types-D6sn2KlA.js';
export { A as AdminEditorPanelDefinition, a as AdminEntryDescriberDefinition, b as AdminSection, c as AdminSectionDefinition, B as BlockDefinition, d as CollectionHookArgs, e as CollectionHooks, f as ComponentDefinition, g as ComponentSlotDefinition, F as FieldDefinition, h as FieldType, i as RuntimeCollectionHooks, U as UiComponentPresetDefinition, j as UiLibraryBlockAdapter, k as UiLibraryComponentAdapter, l as UiLibraryDefinition } from './types-D6sn2KlA.js';
export { A as Actor } from './actor-BAnSg_qp.js';

interface TalismanCmsOptions {
    /**
     * The base path where the CMS admin dashboard will be served.
     * @default '/admin'
     */
    adminPath?: string;
    /**
     * The authentication provider used to protect the CMS routes.
     * Required for production.
     */
    auth?: TalismanAuthAdapter;
    /**
     * Schemas defining the data collections managed by Talisman CMS.
     */
    collections?: CollectionConfig[];
    /**
     * Schemas defining singleton global documents managed by Talisman CMS.
     */
    globals?: GlobalConfig[];
    /**
     * Plugins to extend Talisman CMS functionality
     */
    plugins?: Plugin[];
    /**
     * A custom email provider, loaded in the Worker from `customEmail({ moduleId, exportName, args })`
     * (`talisman-cms/email`). It is used when `TALISMAN_EMAIL_PROVIDER` is unset or `custom`.
     * Without it, email goes through the `[[send_email]]` binding named `EMAIL`.
     */
    email?: EmailRuntimeDescriptor;
    /**
     * The folder, relative to the project root, into which the core's and every plugin's D1 migrations
     * are copied on each config setup. Point the `DB` binding's `migrations_dir` at it.
     * @default 'node_modules/.talisman-cms/migrations'
     */
    migrationsDir?: string;
    /**
     * Optional Cloudflare Workflow binding used for publish/archive transitions.
     */
    publishing?: {
        /**
         * Workflow binding available on the Worker environment.
         * @default 'TALISMAN_PUBLISH_WORKFLOW'
         */
        workflowBinding?: string;
    };
}
declare function talismanCms(options?: TalismanCmsOptions): AstroIntegration;

export { CollectionConfig, EmailRuntimeDescriptor, GlobalConfig, Plugin, TalismanAuthAdapter, type TalismanCmsOptions, talismanCms as default };
