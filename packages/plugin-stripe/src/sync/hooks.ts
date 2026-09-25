import type { CollectionHookArgs, CollectionHooks } from 'talisman-cms';
import type { StripePluginConfig, StripeSyncConfig } from '../types';
import { stripeProxy } from '../proxy';

export function createSyncHooks(
  pluginConfig: StripePluginConfig,
  syncConfig: StripeSyncConfig
): CollectionHooks {
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

  const stripeIdOf = (doc: any) => doc?.data?.stripeID || doc?.stripeID;

  return {
    beforeChange: [
      async ({ data, operation, originalDoc }: CollectionHookArgs) => {
        // If skipSync is true, this change originated from a Stripe Webhook.
        // We skip syncing back up to Stripe to prevent an infinite loop.
        if (data.skipSync) {
          return { ...data, skipSync: false }; // Reset skipSync flag for future edits
        }

        const stripePayload = mapDataToStripe(data);
        if (Object.keys(stripePayload).length === 0 && !stripeIdOf(originalDoc)) {
           return data; // Nothing to sync and no existing resource
        }

        try {
          if (operation === 'create' || (!stripeIdOf(originalDoc) && !data.stripeID)) {
            // Create new Stripe resource
            const response = await stripeProxy({
              stripeSecretKey: pluginConfig.stripeSecretKey,
              stripeMethod: `${syncConfig.stripeResourceType}.create`,
              stripeArgs: [stripePayload],
            });

            if (response.status !== 200) {
              console.error(`[plugin-stripe] Failed to create ${syncConfig.stripeResourceTypeSingular} in Stripe:`, response);
              return data;
            }

            if (pluginConfig.logs) {
               console.log(`[plugin-stripe] Created new ${syncConfig.stripeResourceTypeSingular} in Stripe:`, response.data.id);
            }

            return { ...data, stripeID: response.data.id };
          } else if (operation === 'update') {
            // Update existing Stripe resource
            const idToUpdate = data.stripeID || stripeIdOf(originalDoc);
            if (idToUpdate && Object.keys(stripePayload).length > 0) {
              const response = await stripeProxy({
                stripeSecretKey: pluginConfig.stripeSecretKey,
                stripeMethod: `${syncConfig.stripeResourceType}.update`,
                stripeArgs: [idToUpdate, stripePayload],
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
        } catch (error: any) {
          console.error(`[plugin-stripe] Failed to sync ${syncConfig.stripeResourceTypeSingular} to Stripe:`, error.message);
          // Depending on strictness, we might throw here to prevent CMS saving,
          // but for resilience it's often better to just log it.
        }

        return data;
      }
    ],
    afterDelete: [
      async ({ doc }: Omit<CollectionHookArgs, 'data'> & { doc: any }) => {
        const stripeId = stripeIdOf(doc);
        if (!stripeId) return;

        try {
          await stripeProxy({
            stripeSecretKey: pluginConfig.stripeSecretKey,
            stripeMethod: `${syncConfig.stripeResourceType}.del`,
            stripeArgs: [stripeId],
          });
          
          if (pluginConfig.logs) {
             console.log(`[plugin-stripe] Deleted ${syncConfig.stripeResourceTypeSingular} from Stripe:`, stripeId);
          }
        } catch (error: any) {
          console.error(`[plugin-stripe] Failed to delete ${syncConfig.stripeResourceTypeSingular} from Stripe:`, error.message);
        }
      }
    ]
  };
}
