import {
  __export
} from "./chunk-MLKGABMK.js";

// src/db/schema.ts
var schema_exports = {};
__export(schema_exports, {
  collections: () => collections,
  entries: () => entries,
  entryRevisions: () => entryRevisions,
  globals: () => globals,
  media: () => media
});
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
var collections = sqliteTable("galaxy_collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  fields: text("fields", { mode: "json" }).notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
var entries = sqliteTable("galaxy_entries", {
  id: text("id").primaryKey(),
  collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  status: text("status", { enum: ["draft", "published", "archived"] }).notNull().default("draft"),
  data: text("data", { mode: "json" }).notNull(),
  // Draft payload currently being edited
  publishedData: text("published_data", { mode: "json" }),
  // Last published snapshot served to the site
  publishedRevisionId: text("published_revision_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  archivedAt: integer("archived_at", { mode: "timestamp" })
}, (table) => [
  index("galaxy_entries_collection_status_created_idx").on(table.collectionId, table.status, table.createdAt),
  index("galaxy_entries_collection_status_slug_idx").on(table.collectionId, table.status, table.slug, table.createdAt)
]);
var entryRevisions = sqliteTable("galaxy_entry_revisions", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull().references(() => entries.id, { onDelete: "cascade" }),
  collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  type: text("type", { enum: ["draft_save", "publish", "archive", "restore"] }).notNull(),
  status: text("status", { enum: ["draft", "published", "archived"] }).notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("galaxy_entry_revisions_entry_number_idx").on(table.entryId, table.revisionNumber)
]);
var media = sqliteTable("galaxy_media", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  url: text("url").notNull(),
  // Could be an R2 presigned URL or public bucket URL
  altText: text("alt_text"),
  width: integer("width"),
  height: integer("height"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var globals = sqliteTable("galaxy_globals", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  data: text("data", { mode: "json" }).notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

export {
  collections,
  entries,
  entryRevisions,
  media,
  globals,
  schema_exports
};
