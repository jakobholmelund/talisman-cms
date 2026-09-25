import "./chunk-MLKGABMK.js";

// src/loader.ts
function talismanLoader(options) {
  return {
    name: "talisman-cms-loader",
    load: async (context) => {
      const { store, generateDigest } = context;
      if (!options.buildEntries) {
        throw new Error(`talismanLoader(${options.collection}) needs buildEntries for Astro content sync. Use talismanLiveLoader for request-time Cloudflare data.`);
      }
      const entries = await options.buildEntries();
      store.clear();
      for (const entry of entries) {
        store.set({
          id: entry.id,
          data: entry.data,
          digest: generateDigest ? generateDigest(entry.data) : void 0
        });
      }
    },
    loadEntry: async (context) => {
      try {
        const { fetchLiveEntry } = await import("./loader.server.js");
        return await fetchLiveEntry(options, context.filter);
      } catch (err) {
        return { error: err };
      }
    },
    loadCollection: async (context) => {
      try {
        const { fetchLiveCollection } = await import("./loader.server.js");
        return await fetchLiveCollection(options, context.filter);
      } catch (err) {
        return { error: err };
      }
    }
  };
}
var talismanLiveLoader = talismanLoader;
export {
  talismanLiveLoader,
  talismanLoader
};
