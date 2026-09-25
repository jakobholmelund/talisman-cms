import { Plugin } from 'talisman-cms';
import { S as StripePluginConfig } from './types-CgczayAw.js';
export { a as StripeRuntimeConfig, b as StripeSyncConfig, c as StripeWebhookHandlers } from './types-CgczayAw.js';

declare function stripePlugin(config?: StripePluginConfig): Plugin;

export { StripePluginConfig, stripePlugin };
