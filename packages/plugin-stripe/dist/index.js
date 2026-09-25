// src/index.ts
import { fileURLToPath } from "url";
import { existsSync } from "fs";
function resolveRouteEntrypoint(name) {
  const isESM = typeof import.meta !== "undefined" && typeof import.meta.url === "string";
  if (!isESM) {
    return `../src/routes/${name}.ts`;
  }
  let routePath = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));
  if (!existsSync(routePath)) {
    routePath = fileURLToPath(new URL(`../src/routes/${name}.ts`, import.meta.url));
  }
  return routePath;
}
function stripePlugin(config) {
  if (config.webhooks && !config.webhooksModule) {
    throw new Error("[plugin-stripe] Inline webhook handlers cannot survive the server build. Provide webhooksModule.");
  }
  const restEndpointPath = resolveRouteEntrypoint("rest");
  const webhooksEndpointPath = resolveRouteEntrypoint("webhooks");
  return {
    name: "stripe-plugin",
    onInit: (cmsConfig) => {
      if (config.sync && cmsConfig.collections) {
        config.sync.forEach((syncOpt) => {
          const col = cmsConfig.collections.find((c) => c.slug === syncOpt.collection);
          if (col) {
            col.fields = col.fields || [];
            if (!col.fields.some((f) => f.name === "stripeID")) {
              col.fields.push({
                name: "stripeID",
                label: "Stripe ID",
                type: "text",
                admin: { hidden: true }
              });
            }
            if (!col.fields.some((f) => f.name === "skipSync")) {
              col.fields.push({
                name: "skipSync",
                label: "Skip Stripe Sync",
                type: "boolean",
                defaultValue: false,
                admin: { hidden: true },
                description: "When true, prevents infinite sync loops when webhooks trigger updates"
              });
            }
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
              const { webhooks, ...serializableConfig } = config;
              const handlerImport = config.webhooksModule ? `import { ${config.webhooksModule.exportName} as runtimeWebhooks } from ${JSON.stringify(config.webhooksModule.moduleId)};` : "";
              return `${handlerImport}
export const stripeConfig = { ...${JSON.stringify(serializableConfig)}, webhooks: ${config.webhooksModule ? "runtimeWebhooks" : "undefined"} };`;
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
        entrypoint: restEndpointPath
      }] : [],
      {
        path: "/stripe/webhooks",
        entrypoint: webhooksEndpointPath,
        public: true
      }
    ]
  };
}
export {
  stripePlugin
};
