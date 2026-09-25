import type { CollectionHookArgs, CollectionHooks } from 'talisman-cms';
import type { StripeRuntimeConfig, StripeSyncConfig } from '../types';
import { stripeProxy } from '../proxy';
import { MISSING_SECRET_KEY, readStripeSecretKey, type StripeEnv } from '../secrets';

export const DEFAULT_STRIPE_ID_FIELD = 'stripeID';

export interface SyncRuntime {
  /** Worker settings and secrets for the current request. */
  getEnv: () => Promise<StripeEnv>;
  /** The Drizzle table behind a native collection, or null for CMS entries. */
  nativeTable: Record<string, unknown> | null;
  /** Whether the request was made by a CMS admin. */
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

  // beforeDelete and afterDelete receive the same request; authenticate it once.
  const adminChecks = new WeakMap<Request, Promise<boolean>>();
  const isAdmin = (request: Request) => {
    let check = adminChecks.get(request);
    if (!check) {
      check = runtime.isAdmin(request);
      adminChecks.set(request, check);
    }
    return check;
  };

  return {
    beforeChange: [
      async ({ data, originalDoc }: CollectionHookArgs) => {
        if (missingColumn) throw new Error(missingColumn);

        // The CMS merges hook results into the submitted data, so client values are overwritten
        // rather than omitted. skipSync was a client-settable flag in earlier versions.
        const stripeId = storedStripeId(originalDoc);
        const trusted = { ...data, [idField]: stripeId, skipSync: undefined };

        const stripePayload = mapDataToStripe(data);
        if (Object.keys(stripePayload).length === 0) {
          return trusted; // Nothing to sync
        }

        const stripeSecretKey = await requireSecretKey();
        try {
          if (!stripeId) {
            // Create new Stripe resource
            const response = await stripeProxy({
              stripeSecretKey,
              stripeMethod: `${syncConfig.stripeResourceType}.create`,
              stripeArgs: [stripePayload],
            });

            if (response.status !== 200) {
              console.error(`[plugin-stripe] Failed to create ${resource} in Stripe:`, response);
              return trusted;
            }

            if (pluginConfig.logs) {
               console.log(`[plugin-stripe] Created new ${resource} in Stripe:`, response.data.id);
            }

            return { ...trusted, [idField]: response.data.id };
          }

          // Update existing Stripe resource
          const response = await stripeProxy({
            stripeSecretKey,
            stripeMethod: `${syncConfig.stripeResourceType}.update`,
            stripeArgs: [stripeId, stripePayload],
          });

          if (response.status !== 200) {
            console.error(`[plugin-stripe] Failed to update ${resource} in Stripe:`, response);
          } else if (pluginConfig.logs) {
            console.log(`[plugin-stripe] Updated ${resource} in Stripe:`, stripeId);
          }
        } catch (error: any) {
          console.error(`[plugin-stripe] Failed to sync ${resource} to Stripe:`, error.message);
          // Depending on strictness, we might throw here to prevent CMS saving,
          // but for resilience it's often better to just log it.
        }

        return trusted;
      }
    ],
    beforeDelete: [
      // Refuse before the CMS record is removed, so it cannot outlive its Stripe resource unnoticed.
      async ({ req, originalDoc }: Omit<CollectionHookArgs, 'data'>) => {
        if (!storedStripeId(originalDoc)) return;
        if (!(await isAdmin(req))) {
          throw new Error(`[plugin-stripe] Only CMS admins can delete records linked to a Stripe ${resource}.`);
        }
        await requireSecretKey();
      }
    ],
    afterDelete: [
      async ({ req, doc }: Omit<CollectionHookArgs, 'data'> & { doc: any }) => {
        const stripeId = storedStripeId(doc);
        if (!stripeId) return;
        if (!(await isAdmin(req))) {
          console.error(`[plugin-stripe] Kept ${resource} ${stripeId} in Stripe: the delete was not made by a CMS admin.`);
          return;
        }

        const stripeSecretKey = readStripeSecretKey(await runtime.getEnv());
        if (!stripeSecretKey) {
          console.error(MISSING_SECRET_KEY);
          return;
        }

        try {
          // Stripe cannot delete prices, or products that have prices; archiving keeps order history.
          const response = await stripeProxy(syncConfig.stripeResourceType === 'customers'
            ? { stripeSecretKey, stripeMethod: 'customers.del', stripeArgs: [stripeId] }
            : { stripeSecretKey, stripeMethod: `${syncConfig.stripeResourceType}.update`, stripeArgs: [stripeId, { active: false }] });

          if (response.status !== 200) {
            console.error(`[plugin-stripe] Failed to remove ${resource} from Stripe:`, response);
          } else if (pluginConfig.logs) {
             console.log(`[plugin-stripe] Removed ${resource} from Stripe:`, stripeId);
          }
        } catch (error: any) {
          console.error(`[plugin-stripe] Failed to remove ${resource} from Stripe:`, error.message);
        }
      }
    ]
  };
}
