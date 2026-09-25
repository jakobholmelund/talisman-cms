// src/runtime-config.ts
var GALAXY_RUNTIME_STORE_KEY = "__GALAXY_CMS_RUNTIME_STORE__";
function getRuntimeStore() {
  const runtime = globalThis;
  if (!runtime[GALAXY_RUNTIME_STORE_KEY]) {
    runtime[GALAXY_RUNTIME_STORE_KEY] = {
      authAdapters: /* @__PURE__ */ new Map()
    };
  }
  return runtime[GALAXY_RUNTIME_STORE_KEY];
}
function registerAuthAdapter(key, adapter) {
  const store = getRuntimeStore();
  if (adapter) {
    store.authAdapters.set(key, adapter);
    return;
  }
  store.authAdapters.delete(key);
}
function getRegisteredAuthAdapter(key) {
  return getRuntimeStore().authAdapters.get(key) || null;
}

export {
  registerAuthAdapter,
  getRegisteredAuthAdapter
};
