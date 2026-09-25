import { Plugin } from 'talisman-cms';

interface AnalyticsPluginOptions {
    /** Add Commerce Analytics when the ecommerce plugin is registered. Defaults to true. */
    commerce?: boolean;
    /** Add Ask Analytics when ecommerce is registered. Requires a Cloudflare Workers AI binding. */
    ask?: boolean;
}
declare function analyticsPlugin(options?: AnalyticsPluginOptions): Plugin;

export { type AnalyticsPluginOptions, analyticsPlugin };
