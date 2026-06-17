import { pgTable, text, serial, timestamp, integer, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' or 'assistant'
  content: text("content").notNull(),
  sources: text("sources").array(), // Added for source attribution
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const knowledgeBase = pgTable("knowledge_base", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  type: text("type").notNull(), // 'onedrive', 'zoho_ticket', 'zoho_kb', 'manual'
  productCategories: text("product_categories").array().default([]).notNull(),
  modelNumbers: text("model_numbers").array().default([]).notNull(),
  embedding: real("embedding").array(), // vector embedding for similarity search (text-embedding-3-small = 1536 dims)
  sourceUrl: text("source_url"), // original OneDrive/SharePoint URL for refresh
  firmwareRequired: text("firmware_required").default("not_applicable").notNull(),
  appVersionRequired: text("app_version_required").default("not_applicable").notNull(),
  fileHash: text("file_hash"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const knowledgeBaseChunks = pgTable("knowledge_base_chunks", {
  id: serial("id").primaryKey(),
  knowledgeBaseId: integer("knowledge_base_id").notNull().references(() => knowledgeBase.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  stepNumber: integer("step_number"),
  content: text("content").notNull(),
  embedding: real("embedding").array(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const whitelistedUsers = pgTable("whitelisted_users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  role: text("role").notNull().default("agent"), // 'admin' | 'agent'
  canAddKB: boolean("can_add_kb").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tokenUsage = pgTable("token_usage", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull(),
  messageId: integer("message_id"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const conversationState = pgTable("conversation_state", {
  conversationId: integer("conversation_id").primaryKey().references(() => conversations.id, { onDelete: "cascade" }),
  issue: text("issue"),
  productCategory: text("product_category"),
  modelNumber: text("model_number"),
  srNumber: text("sr_number"),
  accountEmail: text("account_email"),
  identifierAvailable: boolean("identifier_available").default(false).notNull(),
  appConnectionStatus: text("app_connection_status"), // "connected" | "disconnected" | "decommissioned"
  signalStatus: text("signal_status"),               // "online" | "offline"
  firmwareVersion: text("firmware_version"),
  firmwareStatus: text("firmware_status"),           // "ok" | "outdated" | "unknown"
  featuresEnabled: text("features_enabled").array().default([]).notNull(),
  featuresDisabled: text("features_disabled").array().default([]).notNull(),
  currentStage: text("current_stage").default("issue_extraction").notNull(),
  troubleshootingIndex: integer("troubleshooting_index").default(0).notNull(),
  kbOnlyMode: boolean("kb_only_mode").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Insert schemas ──────────────────────────────────────────────────────────
export const insertConversationSchema = createInsertSchema(conversations).omit({ id: true, createdAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true });
export const insertKnowledgeBaseSchema = createInsertSchema(knowledgeBase).omit({ id: true, updatedAt: true });
export const insertKnowledgeBaseChunkSchema = createInsertSchema(knowledgeBaseChunks).omit({ id: true, updatedAt: true });
export const insertWhitelistedUserSchema = createInsertSchema(whitelistedUsers).omit({ id: true, createdAt: true });
export const insertTokenUsageSchema = createInsertSchema(tokenUsage).omit({ id: true, createdAt: true });
export const insertConversationStateSchema = createInsertSchema(conversationState).omit({ updatedAt: true });

// ── Select types ────────────────────────────────────────────────────────────
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type KnowledgeBase = typeof knowledgeBase.$inferSelect;
export type InsertKnowledgeBase = z.infer<typeof insertKnowledgeBaseSchema>;
export type KnowledgeBaseChunk = typeof knowledgeBaseChunks.$inferSelect;
export type InsertKnowledgeBaseChunk = z.infer<typeof insertKnowledgeBaseChunkSchema>;
export type WhitelistedUser = typeof whitelistedUsers.$inferSelect;
export type InsertWhitelistedUser = z.infer<typeof insertWhitelistedUserSchema>;
export type TokenUsage = typeof tokenUsage.$inferSelect;
export type ConversationState = typeof conversationState.$inferSelect;
export type InsertConversationState = z.infer<typeof insertConversationStateSchema>;
