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

function read(env: EnvSource, name: string, accept: (value: unknown) => unknown) {
  if (!env) return undefined;
  const values = env as Record<string, unknown>;
  const current = accept(values[`TALISMAN_${name}`]);
  if (current !== undefined) return current;
  const legacy = accept(values[`GALAXY_${name}`]);
  if (legacy !== undefined) warnLegacyName(name);
  return legacy;
}

const settingValue = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const bindingValue = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? undefined : value;

/** The trimmed `TALISMAN_<name>` Worker setting, else `GALAXY_<name>`. Blank and non-string values count as unset. */
export function readSetting(env: EnvSource, name: string): string | undefined {
  return read(env, name, settingValue) as string | undefined;
}

/** The `TALISMAN_<name>` Worker binding, else `GALAXY_<name>`. Missing, null and blank values count as unset. */
export function readBinding<T = unknown>(env: EnvSource, name: string): T | undefined {
  return read(env, name, bindingValue) as T | undefined;
}
