import type { Plugin } from 'talisman-cms';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AnalyticsPluginOptions {
  /** Add Commerce Analytics when the ecommerce plugin is registered. Defaults to true. */
  commerce?: boolean;
  /** Add Ask Analytics when ecommerce is registered. Requires a Cloudflare Workers AI binding. */
  ask?: boolean;
}

function routeEntrypoint(name: string) {
  let path = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));
  if (!existsSync(path)) path = fileURLToPath(new URL(`./routes/${name}.ts`, import.meta.url));
  return path;
}

export function analyticsPlugin(options: AnalyticsPluginOptions = {}): Plugin {
  const overview = { path: 'analytics', label: 'Analytics', componentPath: '@talisman-cms/plugin-analytics/admin/Analytics' };
  const commerce = { path: 'commerce-analytics', label: 'Commerce analytics', componentPath: '@talisman-cms/plugin-analytics/admin/CommerceAnalytics', section: 'commerce' as const };
  const ask = { path: 'ask-analytics', label: 'Ask Analytics', componentPath: '@talisman-cms/plugin-analytics/admin/AskAnalytics' };
  const baseEndpoint = { path: '/analytics/overview', entrypoint: routeEntrypoint('analytics-overview') };
  const commerceEndpoint = { path: '/analytics/commerce', entrypoint: routeEntrypoint('analytics-commerce') };
  const askEndpoint = { path: '/analytics/ask', entrypoint: routeEntrypoint('analytics-ask') };
  const plugin: Plugin = {
    name: '@talisman-cms/plugin-analytics',
    adminUi: [overview],
    adminLinks: [],
    endpoints: [baseEndpoint],
    onInit(config: { plugins?: Plugin[]; adminPath?: string }) {
      const hasCommerce = options.commerce !== false &&
        config.plugins?.some(item => item.name === '@talisman-cms/plugin-ecommerce');
      const hasAsk = Boolean(hasCommerce && options.ask);
      const adminPath = `/${(config.adminPath || 'admin').replace(/^\/+|\/+$/g, '')}`;
      plugin.adminUi = hasCommerce ? (hasAsk ? [overview, commerce, ask] : [overview, commerce]) : [overview];
      plugin.adminLinks = hasCommerce ? [{
        section: 'commerce', label: 'Analytics', description: 'Review orders, sales, refunds, and top products.',
        href: `${adminPath === '/' ? '' : adminPath}/extensions/commerce-analytics`
      }, ...(hasAsk ? [{ section: 'commerce' as const, label: 'Ask Analytics', description: 'Ask a question and get a report from approved metrics.',
        href: `${adminPath === '/' ? '' : adminPath}/extensions/ask-analytics` }] : [])] : [];
      plugin.endpoints = hasCommerce ? (hasAsk ? [baseEndpoint, commerceEndpoint, askEndpoint] : [baseEndpoint, commerceEndpoint]) : [baseEndpoint];
      return config;
    }
  };
  return plugin;
}
