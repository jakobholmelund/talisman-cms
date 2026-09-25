// src/index.ts
import { fileURLToPath } from "url";
import { existsSync } from "fs";
function resolveRouteEntrypoint(name) {
  let routePath = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));
  if (!existsSync(routePath)) routePath = fileURLToPath(new URL(`./routes/${name}.ts`, import.meta.url));
  return routePath;
}
function stripePlugin(config = {}) {
  if (config.webhooks && !config.webhooksModule) {
    throw new Error("[plugin-stripe] Inline webhook handlers cannot survive the server build. Provide webhooksModule.");
  }
  const ignoredSecrets = ["stripeSecretKey", "stripeWebhooksEndpointSecret"].filter((key) => config[key] !== void 0);
  if (ignoredSecrets.length) {
    console.warn(`[plugin-stripe] ${ignoredSecrets.join(" and ")} in astro.config is ignored. Set the STRIPE_SECRET_KEY and TALISMAN_STRIPE_WEBHOOK_SECRET Worker secrets instead, and remove the key from your config.`);
  }
  const webhookEndpoint = config.webhookEndpoint ?? Boolean(config.webhooksModule);
  const runtimeConfig = {
    rest: config.rest === true,
    restMethods: config.restMethods ?? [],
    logs: config.logs === true
  };
  return {
    name: "stripe-plugin",
    onInit: (cmsConfig) => {
      if (config.sync && cmsConfig.collections) {
        config.sync.forEach((syncOpt) => {
          const col = cmsConfig.collections.find((c) => c.slug === syncOpt.collection);
          if (col) {
            col.runtimeHooks = [
              ...col.runtimeHooks || [],
              {
                moduleId: "@talisman-cms/plugin-stripe/runtime-hooks",
                exportName: "createStripeRuntimeHooks",
                factory: true,
                args: syncOpt
              }
            ];
          }
        });
      }
      return cmsConfig;
    },
    vite: {
      plugins: [
        {
          name: "talisman-cms-stripe-plugin-config",
          resolveId(id) {
            if (id === "virtual:talisman-cms/stripe-config") {
              return "\0virtual:talisman-cms/stripe-config";
            }
          },
          load(id) {
            if (id === "\0virtual:talisman-cms/stripe-config") {
              const handlerImport = config.webhooksModule ? `import { ${config.webhooksModule.exportName} as runtimeWebhooks } from ${JSON.stringify(config.webhooksModule.moduleId)};` : "";
              return `${handlerImport}
export const stripeConfig = { ...${JSON.stringify(runtimeConfig)}, webhooks: ${config.webhooksModule ? "runtimeWebhooks" : "undefined"} };`;
            }
          }
        }
      ],
      ssr: {
        noExternal: ["@talisman-cms/plugin-stripe"]
      }
    },
    endpoints: [
      ...config.rest === true && config.restMethods?.length ? [{
        path: "/stripe/rest",
        entrypoint: resolveRouteEntrypoint("rest")
      }] : [],
      ...webhookEndpoint ? [{
        path: "/stripe/webhooks",
        entrypoint: resolveRouteEntrypoint("webhooks"),
        public: true
      }] : []
    ]
  };
}
export {
  stripePlugin
};
