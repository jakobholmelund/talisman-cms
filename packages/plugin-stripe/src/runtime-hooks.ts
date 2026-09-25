import type { StripeSyncConfig, StripePluginConfig } from './types';
import { createSyncHooks } from './sync/hooks';
import { stripeConfig } from 'virtual:talisman-cms/stripe-config';

export function createStripeRuntimeHooks(syncConfig: StripeSyncConfig) {
  return createSyncHooks(stripeConfig as StripePluginConfig, syncConfig);
}
