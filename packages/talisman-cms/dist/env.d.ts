/**
 * Worker settings and bindings use the `TALISMAN_` prefix. Deployments configured before the rename
 * use `GALAXY_` names, which are still read as a fallback. Pass the name without its prefix, for
 * example `readSetting(env, 'AUTH_SECRET')`.
 */
type EnvSource = object | null | undefined;
/**
 * The trimmed `TALISMAN_<name>` Worker setting, else `GALAXY_<name>`, as a string. Numbers and
 * booleans are converted (`500` reads as "500"); blank values and other types count as unset.
 */
declare function readSetting(env: EnvSource, name: string): string | undefined;
/** The `TALISMAN_<name>` Worker binding, else `GALAXY_<name>`. Missing, null and blank values count as unset. */
declare function readBinding<T = unknown>(env: EnvSource, name: string): T | undefined;

export { readBinding, readSetting };
