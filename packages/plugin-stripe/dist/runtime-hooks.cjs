"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/runtime-hooks.ts
var runtime_hooks_exports = {};
__export(runtime_hooks_exports, {
  createStripeRuntimeHooks: () => createStripeRuntimeHooks
});
module.exports = __toCommonJS(runtime_hooks_exports);

// src/proxy.ts
var import_stripe = __toESM(require("stripe"), 1);
var stripeProxy = async (args) => {
  const { stripeSecretKey, stripeMethod, stripeArgs = [] } = args;
  if (!stripeSecretKey) {
    throw new Error("Stripe secret key must be provided");
  }
  const stripe = new import_stripe.default(stripeSecretKey, {
    apiVersion: "2022-08-01",
    // Target recent version per docs, or user can override
    appInfo: {
      name: "Talisman CMS Stripe Plugin",
      version: "0.0.1"
    }
  });
  const methodParts = stripeMethod.split(".");
  let currentContext = stripe;
  let methodToCall = void 0;
  for (let i = 0; i < methodParts.length; i++) {
    const part = methodParts[i];
    if (part.startsWith("_")) {
      throw new Error(`Cannot access internal Stripe property: ${part}`);
    }
    if (i === methodParts.length - 1) {
      methodToCall = currentContext[part];
    } else {
      currentContext = currentContext[part];
    }
    if (!currentContext) {
      throw new Error(`Invalid Stripe method path: ${methodParts.slice(0, i + 1).join(".")}`);
    }
  }
  if (typeof methodToCall !== "function") {
    throw new Error(`The resolved Stripe property '${stripeMethod}' is not a function.`);
  }
  try {
    const result = await methodToCall.apply(currentContext, stripeArgs);
    return {
      status: 200,
      data: result
    };
  } catch (err) {
    return {
      status: err.statusCode || 500,
      message: err.message,
      type: err.type,
      code: err.code
    };
  }
};

// src/sync/hooks.ts
function createSyncHooks(pluginConfig, syncConfig) {
  const mapDataToStripe = (cmsData) => {
    const payload = {};
    if (syncConfig.fields) {
      for (const field of syncConfig.fields) {
        if (cmsData[field.fieldPath] !== void 0) {
          payload[field.stripeProperty] = cmsData[field.fieldPath];
        }
      }
    }
    return payload;
  };
  const stripeIdOf = (doc) => doc?.data?.stripeID || doc?.stripeID;
  return {
    beforeChange: [
      async ({ data, operation, originalDoc }) => {
        if (data.skipSync) {
          return { ...data, skipSync: false };
        }
        const stripePayload = mapDataToStripe(data);
        if (Object.keys(stripePayload).length === 0 && !stripeIdOf(originalDoc)) {
          return data;
        }
        try {
          if (operation === "create" || !stripeIdOf(originalDoc) && !data.stripeID) {
            const response = await stripeProxy({
              stripeSecretKey: pluginConfig.stripeSecretKey,
              stripeMethod: `${syncConfig.stripeResourceType}.create`,
              stripeArgs: [stripePayload]
            });
            if (response.status !== 200) {
              console.error(`[plugin-stripe] Failed to create ${syncConfig.stripeResourceTypeSingular} in Stripe:`, response);
              return data;
            }
            if (pluginConfig.logs) {
              console.log(`[plugin-stripe] Created new ${syncConfig.stripeResourceTypeSingular} in Stripe:`, response.data.id);
            }
            return { ...data, stripeID: response.data.id };
          } else if (operation === "update") {
            const idToUpdate = data.stripeID || stripeIdOf(originalDoc);
            if (idToUpdate && Object.keys(stripePayload).length > 0) {
              const response = await stripeProxy({
                stripeSecretKey: pluginConfig.stripeSecretKey,
                stripeMethod: `${syncConfig.stripeResourceType}.update`,
                stripeArgs: [idToUpdate, stripePayload]
              });
              if (response.status !== 200) {
                console.error(`[plugin-stripe] Failed to update ${syncConfig.stripeResourceTypeSingular} in Stripe:`, response);
                return data;
              }
              if (pluginConfig.logs) {
                console.log(`[plugin-stripe] Updated ${syncConfig.stripeResourceTypeSingular} in Stripe:`, idToUpdate);
              }
            }
            return data;
          }
        } catch (error) {
          console.error(`[plugin-stripe] Failed to sync ${syncConfig.stripeResourceTypeSingular} to Stripe:`, error.message);
        }
        return data;
      }
    ],
    afterDelete: [
      async ({ doc }) => {
        const stripeId = stripeIdOf(doc);
        if (!stripeId) return;
        try {
          await stripeProxy({
            stripeSecretKey: pluginConfig.stripeSecretKey,
            stripeMethod: `${syncConfig.stripeResourceType}.del`,
            stripeArgs: [stripeId]
          });
          if (pluginConfig.logs) {
            console.log(`[plugin-stripe] Deleted ${syncConfig.stripeResourceTypeSingular} from Stripe:`, stripeId);
          }
        } catch (error) {
          console.error(`[plugin-stripe] Failed to delete ${syncConfig.stripeResourceTypeSingular} from Stripe:`, error.message);
        }
      }
    ]
  };
}

// src/runtime-hooks.ts
var import_stripe_config = require("virtual:talisman-cms/stripe-config");
function createStripeRuntimeHooks(syncConfig) {
  return createSyncHooks(import_stripe_config.stripeConfig, syncConfig);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createStripeRuntimeHooks
});
