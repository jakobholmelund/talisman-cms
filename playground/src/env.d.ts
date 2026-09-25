/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types/experimental" />

declare module 'cloudflare:workers' {
  export interface Env {
    DB: D1Database;
    KV: KVNamespace;
    [key: string]: any;
  }
  export const env: Env;
}
