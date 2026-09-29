import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, type CommerceDb } from './db';
import type { PaymentProviderAdapter } from './payments';

export interface CommerceApiOptions {
  env: TalismanEnv;
  paymentAdapters?: PaymentProviderAdapter[];
}

/** What every commerce operation works with: the bindings, the plugin's Drizzle client and the configured payment adapters. */
export interface CommerceContext {
  env: TalismanEnv;
  db: CommerceDb;
  adapters: PaymentProviderAdapter[];
}

export function commerceContext(options: CommerceApiOptions): CommerceContext {
  return { env: options.env, db: commerceDb(options.env), adapters: options.paymentAdapters ?? [] };
}
