// src/index.ts
import { existsSync } from "fs";
import { fileURLToPath } from "url";
function routeEntrypoint(name) {
  let path = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));
  if (!existsSync(path)) path = fileURLToPath(new URL(`./routes/${name}.ts`, import.meta.url));
  return path;
}
function analyticsPlugin(options = {}) {
  const overview = { path: "analytics", label: "Analytics", componentPath: "@talisman-cms/plugin-analytics/admin/Analytics" };
  const commerce = { path: "commerce-analytics", label: "Commerce analytics", componentPath: "@talisman-cms/plugin-analytics/admin/CommerceAnalytics", section: "commerce" };
  const ask = { path: "ask-analytics", label: "Ask Analytics", componentPath: "@talisman-cms/plugin-analytics/admin/AskAnalytics" };
  const baseEndpoint = { path: "/analytics/overview", entrypoint: routeEntrypoint("analytics-overview") };
  const commerceEndpoint = { path: "/analytics/commerce", entrypoint: routeEntrypoint("analytics-commerce") };
  const askEndpoint = { path: "/analytics/ask", entrypoint: routeEntrypoint("analytics-ask") };
  const plugin = {
    name: "@talisman-cms/plugin-analytics",
    adminUi: [overview],
    adminLinks: [],
    endpoints: [baseEndpoint],
    onInit(config) {
      const hasCommerce = options.commerce !== false && config.plugins?.some((item) => item.name === "@talisman-cms/plugin-ecommerce");
      const hasAsk = Boolean(hasCommerce && options.ask);
      plugin.adminUi = hasCommerce ? hasAsk ? [overview, commerce, ask] : [overview, commerce] : [overview];
      plugin.adminLinks = hasCommerce ? [{
        section: "commerce",
        label: "Analytics",
        description: "Review orders, sales, refunds, and top products.",
        href: "extensions/commerce-analytics"
      }, ...hasAsk ? [{
        section: "commerce",
        label: "Ask Analytics",
        description: "Ask a question and get a report from approved metrics.",
        href: "extensions/ask-analytics"
      }] : []] : [];
      plugin.endpoints = hasCommerce ? hasAsk ? [baseEndpoint, commerceEndpoint, askEndpoint] : [baseEndpoint, commerceEndpoint] : [baseEndpoint];
      return config;
    }
  };
  return plugin;
}
export {
  analyticsPlugin
};
