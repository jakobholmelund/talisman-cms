/**
 * Worker settings and bindings use the `TALISMAN_` prefix. Deployments configured before the rename
 * use `GALAXY_` names, which are still read as a fallback. Pass the name without its prefix, for
 * example `readSetting(env, 'AUTH_SECRET')`.
 */
type EnvSource = object | null | undefined;

// Shared through globalThis so a second copy of this module (source and built) still warns only once.
const LEGACY_WARNING_KEY = '__TALISMAN_CMS_LEGACY_ENV_WARNED__';

function warnLegacyName(name: string) {
  const runtime = globalThis as typeof globalThis & { [LEGACY_WARNING_KEY]?: boolean };
  if (runtime[LEGACY_WARNING_KEY]) return;
  runtime[LEGACY_WARNING_KEY] = true;
  console.warn(`[Talisman CMS] GALAXY_${name} is deprecated; rename it to TALISMAN_${name}. `
    + 'Other GALAXY_* settings and bindings are still read until they are renamed too.');
}

function read(env: EnvSource, name: string, accept: (value: unknown, key: string) => unknown) {
  if (!env) return undefined;
  const values = env as Record<string, unknown>;
  const current = accept(values[`TALISMAN_${name}`], `TALISMAN_${name}`);
  if (current !== undefined) return current;
  const legacy = accept(values[`GALAXY_${name}`], `GALAXY_${name}`);
  if (legacy !== undefined) warnLegacyName(name);
  return legacy;
}

const IGNORED_WARNING_KEY = '__TALISMAN_CMS_IGNORED_SETTINGS_WARNED__';

/** Warns once per setting name (never with its value) about a value readSetting cannot use. */
function warnIgnoredSetting(name: string) {
  const runtime = globalThis as typeof globalThis & { [IGNORED_WARNING_KEY]?: Set<string> };
  const warned = runtime[IGNORED_WARNING_KEY] ??= new Set();
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[Talisman CMS] The ${name} setting is not text, a number or true/false, so it is ignored. `
    + 'Set it as a string in wrangler.toml [vars] or the dashboard.');
}

/**
 * Wrangler passes a TOML number or boolean in [vars] through as that type, so `LIMIT = 500` and
 * `ENABLED = true` read as "500" and "true". Other non-string values (objects, lists) are ignored.
 */
function settingValue(value: unknown, name: string) {
  if (typeof value === 'string') return value.trim() || undefined;
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return String(value);
  if (value !== undefined && value !== null) warnIgnoredSetting(name);
  return undefined;
}

const bindingValue = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? undefined : value;

/**
 * The trimmed `TALISMAN_<name>` Worker setting, else `GALAXY_<name>`, as a string. Numbers and
 * booleans are converted (`500` reads as "500"); blank values and other types count as unset.
 */
export function readSetting(env: EnvSource, name: string): string | undefined {
  return read(env, name, (value, key) => settingValue(value, key)) as string | undefined;
}

// Common API key and signing secret prefixes.
const SECRET_LOOKING_VALUE = /^(?:re_|sk_|rk_|whsec_|xkeysib-|SG\.)/;

/** True for a value that reads like an API key or signing secret, which never belongs in a page or a browser bundle. */
export function looksLikeSecretValue(value: unknown): boolean {
  return typeof value === 'string' && SECRET_LOOKING_VALUE.test(value);
}

/** The `TALISMAN_<name>` Worker binding, else `GALAXY_<name>`. Missing, null and blank values count as unset. */
export function readBinding<T = unknown>(env: EnvSource, name: string): T | undefined {
  return read(env, name, bindingValue) as T | undefined;
}
