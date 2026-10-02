import { Plugin } from 'talisman-cms';
import { S as StripePluginConfig } from './types-Bl2QfBwV.js';
export { a as StripeRuntimeConfig, b as StripeSyncConfig, c as StripeWebhookHandlers } from './types-Bl2QfBwV.js';

declare function stripePlugin(config?: StripePluginConfig): Plugin;

export { StripePluginConfig, stripePlugin };
