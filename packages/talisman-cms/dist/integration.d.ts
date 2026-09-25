import { AstroIntegration } from 'astro';
import { T as TalismanAuthAdapter } from './types-B9Ys5hZL.js';
import { C as CollectionConfig, G as GlobalConfig, P as Plugin } from './types-ENgZDEOO.js';
export { B as BlockDefinition, a as CollectionHookArgs, b as CollectionHooks, c as ComponentDefinition, d as ComponentSlotDefinition, F as FieldDefinition, e as FieldType, f as RuntimeCollectionHooks, U as UiComponentPresetDefinition, g as UiLibraryBlockAdapter, h as UiLibraryComponentAdapter, i as UiLibraryDefinition } from './types-ENgZDEOO.js';

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
     * Optional Cloudflare Workflow binding used for publish/archive transitions.
     */
    publishing?: {
        /**
         * Workflow binding available on the Worker environment.
         * @default 'GALAXY_PUBLISH_WORKFLOW'
         */
        workflowBinding?: string;
    };
}
declare function talismanCms(options?: TalismanCmsOptions): AstroIntegration;

export { CollectionConfig, GlobalConfig, Plugin, TalismanAuthAdapter, type TalismanCmsOptions, talismanCms as default };
