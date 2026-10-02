import {
  bindSyncRecord,
  digest,
  syncResource
} from "./chunk-CW7GUZCD.js";
import "./chunk-ID2RLNYW.js";
import "./chunk-RFCYOEDO.js";
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
  const identityFor = async (data, originalDoc) => {
    const field = syncConfig.identityField;
    const stored = field && originalDoc?.data?.[field];
    const value = stored ?? (field ? data[field] : void 0);
    if (stored !== void 0 && data[field] !== void 0 && data[field] !== stored) {
      throw new Error("[plugin-stripe] The sync identity cannot be changed after creation.");
    }
    if (typeof value === "string" && value.trim()) return digest(["field", field, value]);
    if (originalDoc?.id && storedStripeId(originalDoc)) return digest(["legacy", originalDoc.id]);
    throw new Error("[plugin-stripe] Set identityField to a stable, unique collection field and supply it before syncing a new resource. CMS save refused.");
  };
  return {
    beforeChange: [async ({ data, originalDoc }) => {
      if (missingColumn) throw new Error(missingColumn);
      if (runtime.nativeTable && syncConfig.identityField && !runtime.nativeTable[syncConfig.identityField]) {
        throw new Error("[plugin-stripe] identityField must name a stored column of the native table. CMS save refused.");
      }
      const stripeId = storedStripeId(originalDoc);
      const trusted = { ...data, [idField]: stripeId, skipSync: void 0 };
      if (syncConfig.identityField && originalDoc?.data?.[syncConfig.identityField] !== void 0 && data[syncConfig.identityField] !== void 0 && data[syncConfig.identityField] !== originalDoc.data[syncConfig.identityField]) {
        throw new Error("[plugin-stripe] The sync identity cannot be changed after creation.");
      }
      const payload = mapDataToStripe(data);
      if (!Object.keys(payload).length) return trusted;
      const secret = await requireSecretKey();
      const identity = await identityFor(data, originalDoc);
      const resultId = await syncResource({
        env: await runtime.getEnv(),
        secret,
        collection: syncConfig.collection,
        resource: syncConfig.stripeResourceType,
        identity,
        storedId: stripeId,
        docId: originalDoc?.id,
        payload
      });
      if (pluginConfig.logs) console.log(`[plugin-stripe] Synced ${resource}.`);
      return { ...trusted, [idField]: resultId };
    }],
    afterChange: [async ({ data, originalDoc, doc }) => {
      if (!storedStripeId(doc) || !Object.keys(mapDataToStripe(data)).length) return;
      try {
        await bindSyncRecord(
          await runtime.getEnv(),
          syncConfig.collection,
          syncConfig.stripeResourceType,
          await identityFor(data, originalDoc),
          doc.id
        );
      } catch {
        throw new Error("[plugin-stripe] The CMS record was saved and Stripe synced, but its audit binding failed. Reload this record; do not create a replacement. Ask an administrator to inspect the sync journal.");
      }
    }],
    beforeDelete: [async ({ actor, req, originalDoc }) => {
      const stripeId = storedStripeId(originalDoc);
      if (!stripeId) return;
      if (!await isAdmin({ actor, req })) {
        throw new Error(`[plugin-stripe] Only CMS admins can delete records linked to a Stripe ${resource}.`);
      }
      const secret = await requireSecretKey();
      await syncResource({
        env: await runtime.getEnv(),
        secret,
        collection: syncConfig.collection,
        resource: syncConfig.stripeResourceType,
        identity: await identityFor(originalDoc.data, originalDoc),
        storedId: stripeId,
        docId: originalDoc.id,
        payload: {},
        deleting: true
      });
    }],
    // Stripe removal happens before the CMS delete, so failure never becomes silent success.
    afterDelete: []
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
