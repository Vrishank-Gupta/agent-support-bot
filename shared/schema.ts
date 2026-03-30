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

export const insertConversationSchema = createInsertSchema(conversations).omit({ id: true, createdAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true });
export const insertKnowledgeBaseSchema = createInsertSchema(knowledgeBase).omit({ id: true, updatedAt: true });
export const insertWhitelistedUserSchema = createInsertSchema(whitelistedUsers).omit({ id: true, createdAt: true });
export const insertTokenUsageSchema = createInsertSchema(tokenUsage).omit({ id: true, createdAt: true });

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type KnowledgeBase = typeof knowledgeBase.$inferSelect;
export type InsertKnowledgeBase = z.infer<typeof insertKnowledgeBaseSchema>;
export type WhitelistedUser = typeof whitelistedUsers.$inferSelect;
export type InsertWhitelistedUser = z.infer<typeof insertWhitelistedUserSchema>;
export type TokenUsage = typeof tokenUsage.$inferSelect;
