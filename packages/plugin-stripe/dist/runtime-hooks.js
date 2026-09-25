import {
  stripeProxy
} from "./chunk-Q4AUFOYH.js";

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
import { stripeConfig } from "virtual:talisman-cms/stripe-config";
function createStripeRuntimeHooks(syncConfig) {
  return createSyncHooks(stripeConfig, syncConfig);
}
export {
  createStripeRuntimeHooks
};
