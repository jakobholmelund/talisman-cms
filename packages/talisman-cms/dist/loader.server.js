import {
  getClient
} from "./chunk-AMX3BXNH.js";
import "./chunk-7VUPBVR5.js";
import "./chunk-HSF22PCU.js";
import "./chunk-SHMAAJ4S.js";
import "./chunk-WO46ICPJ.js";
import "./chunk-GAOPNFAO.js";
import "./chunk-OAGJMNST.js";
import "./chunk-MLKGABMK.js";

// src/loader.server.ts
async function fetchLiveEntry(options, filter) {
  const pkg = "cloudflare:workers";
  const { env } = await import(
    /* @vite-ignore */
    pkg
  );
  const client = getClient(env);
  const entry = await client.entries.find(options.collection, filter.id, {
    version: options.version || "published"
  });
  if (!entry) {
    return void 0;
  }
  let parsedData = entry.data;
  if (typeof parsedData === "string") {
    try {
      parsedData = JSON.parse(parsedData);
    } catch (e) {
    }
  }
  return {
    id: entry.id,
    data: {
      ...parsedData,
      slug: entry.slug,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }
  };
}
async function fetchLiveCollection(options, filter) {
  const pkg = "cloudflare:workers";
  const { env } = await import(
    /* @vite-ignore */
    pkg
  );
  const client = getClient(env);
  const entries = await client.entries.findMany(options.collection, {
    version: options.version || "published"
  });
  return {
    entries: entries.map((entry) => {
      let parsedData = entry.data;
      if (typeof parsedData === "string") {
        try {
          parsedData = JSON.parse(parsedData);
        } catch (e) {
        }
      }
      return {
        id: entry.id,
        data: {
          ...parsedData,
          slug: entry.slug,
          status: entry.status,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt
        }
      };
    })
  };
}
export {
  fetchLiveCollection,
  fetchLiveEntry
};
