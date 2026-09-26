/// <reference types="astro/client" />

declare module 'astro:actions' {
  export * from 'astro/actions/runtime/entrypoints/server.js';
}

/** Provided by ecommercePlugin() to its admin screens. */
declare module 'virtual:talisman-cms/ecommerce-admin' {
  export const adminTestCheckout: boolean;
}

/** Provided by ecommercePlugin() to server code: the exports of its `emailTemplates` module, or null. */
declare module 'virtual:talisman-cms/ecommerce-emails' {
  export const emailTemplates: Record<string, unknown> | null;
}
