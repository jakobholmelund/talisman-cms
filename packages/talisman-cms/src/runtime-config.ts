import type { TalismanAuthAdapter } from './auth/types';

type TalismanRuntimeStore = {
  authAdapters: Map<string, TalismanAuthAdapter>;
};

const GALAXY_RUNTIME_STORE_KEY = '__GALAXY_CMS_RUNTIME_STORE__';

function getRuntimeStore(): TalismanRuntimeStore {
  const runtime = globalThis as typeof globalThis & {
    [GALAXY_RUNTIME_STORE_KEY]?: TalismanRuntimeStore;
  };

  if (!runtime[GALAXY_RUNTIME_STORE_KEY]) {
    runtime[GALAXY_RUNTIME_STORE_KEY] = {
      authAdapters: new Map()
    };
  }

  return runtime[GALAXY_RUNTIME_STORE_KEY];
}

export function registerAuthAdapter(key: string, adapter: TalismanAuthAdapter | null | undefined) {
  const store = getRuntimeStore();

  if (adapter) {
    store.authAdapters.set(key, adapter);
    return;
  }

  store.authAdapters.delete(key);
}

export function getRegisteredAuthAdapter(key: string): TalismanAuthAdapter | null {
  return getRuntimeStore().authAdapters.get(key) || null;
}
