import type { CollectionHookArgs, CollectionHooks } from '../types';
import { HookError, ServiceError, type HookPhase } from './errors';

type BeforePhase = 'beforeValidate' | 'beforeChange';
type DeleteArgs = Omit<CollectionHookArgs, 'data'>;
type ArgsFor<P extends HookPhase> =
  P extends BeforePhase ? CollectionHookArgs
  : P extends 'afterChange' ? CollectionHookArgs & { doc: any }
  : P extends 'beforeDelete' ? DeleteArgs
  : DeleteArgs & { doc: any };

/** One line per hook call, for tests that prove both callers run the same hooks in the same order. */
export interface HookLogEntry {
  hook: HookPhase;
  operation: CollectionHookArgs['operation'];
  collection: string;
  actorKind: CollectionHookArgs['actor']['kind'];
  dataKeys: string[];
}

export interface RunHooksOptions {
  log?: HookLogEntry[];
}

/**
 * Runs one phase of a collection's hooks in order. A before* hook's result is merged into the data
 * the next hook and the write see, and the merged data is returned. A hook that throws a
 * ServiceError refuses the write with that error; anything else it throws becomes a HookError for
 * the phase, so an afterChange failure is reported as committed.
 */
export async function runHooks<P extends BeforePhase>(
  hooks: CollectionHooks | undefined,
  phase: P,
  args: CollectionHookArgs,
  options?: RunHooksOptions
): Promise<Record<string, any>>;
export async function runHooks<P extends Exclude<HookPhase, BeforePhase>>(
  hooks: CollectionHooks | undefined,
  phase: P,
  args: ArgsFor<P>,
  options?: RunHooksOptions
): Promise<void>;
export async function runHooks(
  hooks: CollectionHooks | undefined,
  phase: HookPhase,
  args: any,
  options: RunHooksOptions = {}
): Promise<any> {
  const list: ((args: any) => unknown)[] = hooks?.[phase] ?? [];
  const merges = phase === 'beforeValidate' || phase === 'beforeChange';
  let data = args.data;

  for (const hook of list) {
    options.log?.push({
      hook: phase,
      operation: args.operation,
      collection: args.collection.slug,
      actorKind: args.actor.kind,
      dataKeys: data && typeof data === 'object' ? Object.keys(data).sort() : [],
    });
    let result: unknown;
    try {
      result = await hook(merges ? { ...args, data } : args);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new HookError(error, phase);
    }
    if (merges && result) data = { ...data, ...(result as Record<string, any>) };
  }

  return merges ? data : undefined;
}
