/// <reference types="astro/client" />

declare module 'astro:actions' {
  export * from 'astro/actions/runtime/entrypoints/server.js';
}

/** Provided by ecommercePlugin() to its admin screens. */
declare module 'virtual:talisman-cms/ecommerce-admin' {
  export const adminTestCheckout: boolean;
}
