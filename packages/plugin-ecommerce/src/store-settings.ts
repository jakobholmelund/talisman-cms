import { readBinding } from 'talisman-cms/env';

/**
 * How the store sells, read from its `TALISMAN_COMMERCE_*` Worker settings. A store that sets none
 * of them sells in USD.
 */
export interface StoreSettings {
  /** Lowercase ISO 4217 code. Every order amount is an integer in its minor units. */
  currency: string;
}

/**
 * A store setting is set but cannot be used. Checkout stops rather than guess; the message names
 * the setting for the Worker log and is never shown to shoppers.
 */
export class StoreSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreSettingsError';
  }
}

/** Reads and checks the store settings. Throws StoreSettingsError when one of them is invalid. */
export function readStoreSettings(env: object): StoreSettings {
  return { currency: readCurrency(env) };
}

/** Logs why the settings were refused, for the operator, and returns the answer for shoppers. */
export function reportStoreSettingsError(error: StoreSettingsError) {
  console.error(`[Commerce] Store settings are invalid: ${error.message}`);
  return 'Checkout is temporarily unavailable.';
}

/**
 * A text setting. Unset or blank is undefined. Any other type is refused: readSetting would ignore
 * it, and the store would quietly fall back to the default.
 */
function readText(env: object, name: string) {
  const value = readBinding(env, name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new StoreSettingsError(`TALISMAN_${name} must be text`);
  return value.trim();
}

function readCurrency(env: object) {
  const value = readText(env, 'COMMERCE_CURRENCY');
  if (value === undefined) return 'usd';
  const currency = value.toLowerCase();
  if (!/^[a-z]{3}$/.test(currency) || !isIntlCurrency(currency)) {
    throw new StoreSettingsError('TALISMAN_COMMERCE_CURRENCY must be a three-letter ISO 4217 code '
      + `such as "usd", not ${JSON.stringify(value)}`);
  }
  return currency;
}

function isIntlCurrency(code: string) {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}
