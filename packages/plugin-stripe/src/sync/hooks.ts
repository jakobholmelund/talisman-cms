import type { Actor, CollectionHookArgs, CollectionHooks } from 'talisman-cms';
import type { StripeRuntimeConfig, StripeSyncConfig } from '../types';
import { bindSyncRecord, digest, syncResource } from './journal';
import { MISSING_SECRET_KEY, readStripeSecretKey, type StripeEnv } from '../secrets';

export const DEFAULT_STRIPE_ID_FIELD = 'stripeID';

export interface SyncRuntime {
  /** Worker settings and secrets for the current request. */
  getEnv: () => Promise<StripeEnv>;
  /** The Drizzle table behind a native collection, or null for CMS entries. */
  nativeTable: Record<string, unknown> | null;
  /** Whether a request was made by a CMS admin, for hooks called without an actor. */
  isAdmin: (request: Request) => Promise<boolean>;
}

export function createSyncHooks(
  pluginConfig: Pick<StripeRuntimeConfig, 'logs'>,
  syncConfig: StripeSyncConfig,
  runtime: SyncRuntime
): CollectionHooks {
  const idField = syncConfig.stripeIdField || DEFAULT_STRIPE_ID_FIELD;
  const resource = syncConfig.stripeResourceTypeSingular;
  const idColumn = runtime.nativeTable?.[idField];
  // Drizzle drops values without a column, so the ID would be lost and each save would create
  // another Stripe resource.
  const missingColumn = runtime.nativeTable && !(idColumn && typeof idColumn === 'object' && 'dataType' in idColumn)
    ? `[plugin-stripe] ${syncConfig.collection} is a native table without a "${idField}" column, so the Stripe ${resource} ID cannot be stored. Add a text column with that property name to the table, or set stripeIdField to an existing column.`
    : null;

  const mapDataToStripe = (cmsData: any) => {
    const payload: Record<string, any> = {};
    if (syncConfig.fields) {
      for (const field of syncConfig.fields) {
        if (cmsData[field.fieldPath] !== undefined) {
          payload[field.stripeProperty] = cmsData[field.fieldPath];
        }
      }
    }
    return payload;
  };

  // Only the stored record is trusted; the admin form and API clients can send any value.
  const storedStripeId = (doc: any): string | undefined => {
    const value = doc?.data?.[idField];
    return typeof value === 'string' && value ? value : undefined;
  };

  const requireSecretKey = async () => {
    const secretKey = readStripeSecretKey(await runtime.getEnv());
    if (!secretKey) throw new Error(MISSING_SECRET_KEY);
    return secretKey;
  };

  // The CMS names the actor: an admin API user, or trusted server code (the SDK), which may delete
  // linked records. A hook called with only a request authenticates it once for both delete hooks.
  const adminChecks = new WeakMap<Request, Promise<boolean>>();
  const isAdmin = ({ actor, req }: { actor?: Actor; req?: Request }) => {
    if (actor) return Promise.resolve(actor.kind !== 'user' || actor.user.role === 'admin');
    if (!req) return Promise.resolve(false);
    let check = adminChecks.get(req);
    if (!check) {
      check = runtime.isAdmin(req);
      adminChecks.set(req, check);
    }
    return check;
  };

  const identityFor = async (data: any, originalDoc?: any) => {
    const field = syncConfig.identityField;
    const stored = field && originalDoc?.data?.[field];
    const value = stored ?? (field ? data[field] : undefined);
    if (stored !== undefined && data[field!] !== undefined && data[field!] !== stored) {
      throw new Error('[plugin-stripe] The sync identity cannot be changed after creation.');
    }
    if (typeof value === 'string' && value.trim()) return digest(['field', field, value]);
    if (originalDoc?.id && storedStripeId(originalDoc)) return digest(['legacy', originalDoc.id]);
    throw new Error('[plugin-stripe] Set identityField to a stable, unique collection field and supply it before syncing a new resource. CMS save refused.');
  };

  return {
    beforeChange: [async ({ data, originalDoc }: CollectionHookArgs) => {
      if (missingColumn) throw new Error(missingColumn);
      if (runtime.nativeTable && syncConfig.identityField && !runtime.nativeTable[syncConfig.identityField]) {
        throw new Error('[plugin-stripe] identityField must name a stored column of the native table. CMS save refused.');
      }
      const stripeId = storedStripeId(originalDoc);
      const trusted = { ...data, [idField]: stripeId, skipSync: undefined };
      if (syncConfig.identityField && originalDoc?.data?.[syncConfig.identityField] !== undefined
        && data[syncConfig.identityField] !== undefined && data[syncConfig.identityField] !== originalDoc.data[syncConfig.identityField]) {
        throw new Error('[plugin-stripe] The sync identity cannot be changed after creation.');
      }
      const payload = mapDataToStripe(data);
      if (!Object.keys(payload).length) return trusted;
      const secret = await requireSecretKey();
      const identity = await identityFor(data, originalDoc);
      const resultId = await syncResource({ env: await runtime.getEnv(), secret,
        collection: syncConfig.collection, resource: syncConfig.stripeResourceType,
        identity, storedId: stripeId, docId: originalDoc?.id, payload });
      if (pluginConfig.logs) console.log(`[plugin-stripe] Synced ${resource}.`);
      return { ...trusted, [idField]: resultId };
    }],
    afterChange: [async ({ data, originalDoc, doc }) => {
      if (!storedStripeId(doc) || !Object.keys(mapDataToStripe(data)).length) return;
      try {
        await bindSyncRecord(await runtime.getEnv(), syncConfig.collection, syncConfig.stripeResourceType,
          await identityFor(data, originalDoc), doc.id);
      } catch {
        throw new Error('[plugin-stripe] The CMS record was saved and Stripe synced, but its audit binding failed. Reload this record; do not create a replacement. Ask an administrator to inspect the sync journal.');
      }
    }],
    beforeDelete: [async ({ actor, req, originalDoc }) => {
      const stripeId = storedStripeId(originalDoc);
      if (!stripeId) return;
      if (!(await isAdmin({ actor, req }))) {
        throw new Error(`[plugin-stripe] Only CMS admins can delete records linked to a Stripe ${resource}.`);
      }
      const secret = await requireSecretKey();
      await syncResource({ env: await runtime.getEnv(), secret,
        collection: syncConfig.collection, resource: syncConfig.stripeResourceType,
        identity: await identityFor(originalDoc.data, originalDoc), storedId: stripeId,
        docId: originalDoc.id, payload: {}, deleting: true });
    }],
    // Stripe removal happens before the CMS delete, so failure never becomes silent success.
    afterDelete: [],
  };
}
