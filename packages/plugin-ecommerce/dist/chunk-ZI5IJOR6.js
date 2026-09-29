import {
  relations
} from "./chunk-NKJTK7MK.js";

// src/db.ts
import { createDbClient } from "talisman-cms/client";
var commerceDb = (env) => createDbClient(env, relations);
var IN_CHUNK = 80;
function chunked(values, size = IN_CHUNK) {
  const chunks = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}
function errorText(error) {
  const messages = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.message === "string") messages.push(current.message);
  }
  return messages.join("\n");
}
async function batchGroups(db, groups) {
  const queries = Object.values(groups).flat();
  const results = queries.length ? await db.batch(queries) : [];
  let offset = 0;
  return Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, results.slice(offset, offset += list.length).flat()]));
}
async function commitBatch(db, items) {
  if (!items.length) return [];
  return db.batch(items);
}
var runStatements = (db, statements) => commitBatch(db, statements.map((statement) => db.run(statement)));

export {
  commerceDb,
  chunked,
  errorText,
  batchGroups,
  commitBatch,
  runStatements
};
