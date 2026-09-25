declare module 'virtual:talisman-cms/stripe-config' {
  import type { StripeRuntimeConfig } from './types';
  export const stripeConfig: StripeRuntimeConfig;
}

declare module 'virtual:talisman-cms/native-schemas' {
  export const nativeSchemas: Record<string, any>;
}
