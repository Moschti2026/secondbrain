import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  primaryKey,
  vector,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// Embedding dimension for Voyage AI's voyage-3 model.
export const EMBEDDING_DIMENSIONS = 1024;

// --- Auth.js core tables (required shape for @auth/drizzle-adapter) ---

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ]
);

export const sessions = pgTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationTokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })]
);

// --- Application tables ---

export const documentKinds = ["google_drive", "microsoft365", "local"] as const;
export type DocumentKind = (typeof documentKinds)[number];

// One row per indexable "thing": a Drive file, a OneDrive/SharePoint file,
// or a file synced from the local machine (including notes written in
// Obsidian — they're just markdown files in a synced folder, no separate
// "note" concept needed). Chunks always hang off a document so chat/RAG
// search treats every source uniformly.
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DocumentKind>().notNull(),
    // Provider file id (Drive fileId / Graph driveItem id). Null for local
    // files, which are identified by path instead.
    externalId: text("externalId"),
    // Relative path for local-sync files, so re-uploads of the same file
    // update the same document instead of duplicating it.
    localPath: text("localPath"),
    title: text("title").notNull(),
    mimeType: text("mimeType"),
    webUrl: text("webUrl"),
    contentHash: text("contentHash"),
    sourceUpdatedAt: timestamp("sourceUpdatedAt", { mode: "date" }),
    indexedAt: timestamp("indexedAt", { mode: "date" }),
    indexError: text("indexError"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_user_idx").on(t.userId),
    uniqueIndex("documents_user_external_idx").on(t.userId, t.kind, t.externalId),
  ]
);

// Chunked, embedded text for RAG. Every ingested document is split into
// chunks here — notes included, since a note written in Obsidian is just
// a markdown file synced in via local-sync-cli (kind = 'local').
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("documentId")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("chunks_document_idx").on(t.documentId),
    index("chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops")
    ),
  ]
);

// Incremental-sync cursor per user/provider (Drive startPageToken, Graph
// deltaLink), so cron re-syncs only pull what changed.
export const syncState = pgTable(
  "sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"google_drive" | "microsoft365">().notNull(),
    cursor: text("cursor"),
    status: text("status").$type<"idle" | "syncing" | "error">().notNull().default("idle"),
    lastError: text("lastError"),
    lastSyncedAt: timestamp("lastSyncedAt", { mode: "date" }),
  },
  (t) => [uniqueIndex("sync_state_user_provider_idx").on(t.userId, t.provider)]
);

// API keys for the local-sync CLI. The key itself is only ever shown once;
// we store a SHA-256 hash.
export const syncKeys = pgTable("sync_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  hashedKey: text("hashedKey").notNull().unique(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  lastUsedAt: timestamp("lastUsedAt", { mode: "date" }),
});
