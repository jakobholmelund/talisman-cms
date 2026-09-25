"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  stripePlugin: () => stripePlugin
});
module.exports = __toCommonJS(index_exports);
var import_node_url = require("url");
var import_node_fs = require("fs");
var import_meta = {};
function resolveRouteEntrypoint(name) {
  const isESM = typeof import_meta !== "undefined" && typeof import_meta.url === "string";
  if (!isESM) {
    return `../src/routes/${name}.ts`;
  }
  let routePath = (0, import_node_url.fileURLToPath)(new URL(`./routes/${name}.js`, import_meta.url));
  if (!(0, import_node_fs.existsSync)(routePath)) {
    routePath = (0, import_node_url.fileURLToPath)(new URL(`../src/routes/${name}.ts`, import_meta.url));
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  stripePlugin
});
