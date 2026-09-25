import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { nativeSchemas } from 'virtual:talisman-cms/native-schemas';
import { stripeConfig } from 'virtual:talisman-cms/stripe-config';
import type { StripeSyncConfig } from './types';
import { createSyncHooks } from './sync/hooks';
import { getWorkerEnv } from './secrets';

export function createStripeRuntimeHooks(syncConfig: StripeSyncConfig) {
  return createSyncHooks(stripeConfig, syncConfig, {
    getEnv: getWorkerEnv,
    nativeTable: nativeSchemas[syncConfig.collection] ?? null,
    isAdmin: async (request) => !(await authorizeCmsRequest(request, 'admin')).response,
  });
}
