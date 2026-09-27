import {
  stripeProxy
} from "./chunk-3PUM3JYR.js";
import {
  MISSING_SECRET_KEY,
  getWorkerEnv,
  readStripeSecretKey
} from "./chunk-W7JZMBL7.js";

// src/runtime-hooks.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { nativeSchemas } from "virtual:talisman-cms/native-schemas";
import { stripeConfig } from "virtual:talisman-cms/stripe-config";

// src/sync/hooks.ts
var DEFAULT_STRIPE_ID_FIELD = "stripeID";
function createSyncHooks(pluginConfig, syncConfig, runtime) {
  const idField = syncConfig.stripeIdField || DEFAULT_STRIPE_ID_FIELD;
  const resource = syncConfig.stripeResourceTypeSingular;
  const idColumn = runtime.nativeTable?.[idField];
  const missingColumn = runtime.nativeTable && !(idColumn && typeof idColumn === "object" && "dataType" in idColumn) ? `[plugin-stripe] ${syncConfig.collection} is a native table without a "${idField}" column, so the Stripe ${resource} ID cannot be stored. Add a text column with that property name to the table, or set stripeIdField to an existing column.` : null;
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
  const storedStripeId = (doc) => {
    const value = doc?.data?.[idField];
    return typeof value === "string" && value ? value : void 0;
  };
  const requireSecretKey = async () => {
    const secretKey = readStripeSecretKey(await runtime.getEnv());
    if (!secretKey) throw new Error(MISSING_SECRET_KEY);
    return secretKey;
  };
  const adminChecks = /* @__PURE__ */ new WeakMap();
  const isAdmin = ({ actor, req }) => {
    if (actor) return Promise.resolve(actor.kind !== "user" || actor.user.role === "admin");
    if (!req) return Promise.resolve(false);
    let check = adminChecks.get(req);
    if (!check) {
      check = runtime.isAdmin(req);
      adminChecks.set(req, check);
    }
    return check;
  };
  return {
    beforeChange: [
      async ({ data, originalDoc }) => {
        if (missingColumn) throw new Error(missingColumn);
        const stripeId = storedStripeId(originalDoc);
        const trusted = { ...data, [idField]: stripeId, skipSync: void 0 };
        const stripePayload = mapDataToStripe(data);
        if (Object.keys(stripePayload).length === 0) {
          return trusted;
        }
        const stripeSecretKey = await requireSecretKey();
        try {
          if (!stripeId) {
            const response2 = await stripeProxy({
              stripeSecretKey,
              stripeMethod: `${syncConfig.stripeResourceType}.create`,
              stripeArgs: [stripePayload]
            });
            if (response2.status !== 200) {
              console.error(`[plugin-stripe] Failed to create ${resource} in Stripe:`, response2);
              return trusted;
            }
            if (pluginConfig.logs) {
              console.log(`[plugin-stripe] Created new ${resource} in Stripe:`, response2.data.id);
            }
            return { ...trusted, [idField]: response2.data.id };
          }
          const response = await stripeProxy({
            stripeSecretKey,
            stripeMethod: `${syncConfig.stripeResourceType}.update`,
            stripeArgs: [stripeId, stripePayload]
          });
          if (response.status !== 200) {
            console.error(`[plugin-stripe] Failed to update ${resource} in Stripe:`, response);
          } else if (pluginConfig.logs) {
            console.log(`[plugin-stripe] Updated ${resource} in Stripe:`, stripeId);
          }
        } catch (error) {
          console.error(`[plugin-stripe] Failed to sync ${resource} to Stripe:`, error.message);
        }
        return trusted;
      }
    ],
    beforeDelete: [
      // Refuse before the CMS record is removed, so it cannot outlive its Stripe resource unnoticed.
      async ({ actor, req, originalDoc }) => {
        if (!storedStripeId(originalDoc)) return;
        if (!await isAdmin({ actor, req })) {
          throw new Error(`[plugin-stripe] Only CMS admins can delete records linked to a Stripe ${resource}.`);
        }
        await requireSecretKey();
      }
    ],
    afterDelete: [
      async ({ actor, req, doc }) => {
        const stripeId = storedStripeId(doc);
        if (!stripeId) return;
        if (!await isAdmin({ actor, req })) {
          console.error(`[plugin-stripe] Kept ${resource} ${stripeId} in Stripe: the delete was not made by a CMS admin.`);
          return;
        }
        const stripeSecretKey = readStripeSecretKey(await runtime.getEnv());
        if (!stripeSecretKey) {
          console.error(MISSING_SECRET_KEY);
          return;
        }
        try {
          const response = await stripeProxy(syncConfig.stripeResourceType === "customers" ? { stripeSecretKey, stripeMethod: "customers.del", stripeArgs: [stripeId] } : { stripeSecretKey, stripeMethod: `${syncConfig.stripeResourceType}.update`, stripeArgs: [stripeId, { active: false }] });
          if (response.status !== 200) {
            console.error(`[plugin-stripe] Failed to remove ${resource} from Stripe:`, response);
          } else if (pluginConfig.logs) {
            console.log(`[plugin-stripe] Removed ${resource} from Stripe:`, stripeId);
          }
        } catch (error) {
          console.error(`[plugin-stripe] Failed to remove ${resource} from Stripe:`, error.message);
        }
      }
    ]
  };
}

// src/runtime-hooks.ts
function createStripeRuntimeHooks(syncConfig) {
  return createSyncHooks(stripeConfig, syncConfig, {
    getEnv: getWorkerEnv,
    nativeTable: nativeSchemas[syncConfig.collection] ?? null,
    isAdmin: async (request) => !(await authorizeCmsRequest(request, "admin")).response
  });
}
export {
  createStripeRuntimeHooks
};
