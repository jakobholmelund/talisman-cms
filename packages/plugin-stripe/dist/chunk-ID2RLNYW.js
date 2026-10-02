// src/schema.ts
import { sqliteTable, text, integer, check, uniqueIndex } from "drizzle-orm/sqlite-core";
import { defineRelations, sql } from "drizzle-orm";
var SYNC_STATES = ["ready", "pending", "blocked", "deleted"];
var stripeSync = sqliteTable("_stripe_sync", {
  id: text("id").primaryKey(),
  collection: text("collection").notNull(),
  resource: text("resource").notNull(),
  identity: text("identity").notNull(),
  stripeId: text("stripe_id"),
  docId: text("doc_id"),
  state: text("state", { enum: SYNC_STATES }).notNull().default("ready"),
  operation: text("operation").notNull().default(""),
  payloadHash: text("payload_hash").notNull().default(""),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
}, (table) => [
  uniqueIndex("stripe_sync_identity").on(table.collection, table.resource, table.identity),
  check("stripe_sync_state", sql`${table.state} IN ('ready', 'pending', 'blocked', 'deleted')`),
  check("stripe_sync_attempts", sql`${table.attempts} >= 0`)
]);
var stripeOperations = sqliteTable("_stripe_sync_operations", {
  id: text("id").primaryKey(),
  syncId: text("sync_id").notNull().references(() => stripeSync.id),
  method: text("method").notNull(),
  stripeId: text("stripe_id"),
  payloadHash: text("payload_hash").notNull(),
  attempts: integer("attempts").notNull().default(1),
  outcome: text("outcome").notNull().default("pending"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});
var stripeRelations = defineRelations({ stripeSync, stripeOperations }, (r) => ({
  stripeSync: { operations: r.many.stripeOperations() },
  stripeOperations: { resource: r.one.stripeSync({ from: r.stripeOperations.syncId, to: r.stripeSync.id, optional: false }) }
}));

export {
  SYNC_STATES,
  stripeSync,
  stripeOperations,
  stripeRelations
};
