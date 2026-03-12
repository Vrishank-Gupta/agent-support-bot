import { db } from "../../db";
import { sql } from "drizzle-orm";
import {
  conversations, messages, knowledgeBase, whitelistedUsers, tokenUsage,
  type InsertKnowledgeBase, type InsertWhitelistedUser
} from "@shared/schema";
import { eq, desc, sum } from "drizzle-orm";

export interface IChatStorage {
  getConversation(id: number): Promise<typeof conversations.$inferSelect | undefined>;
  getAllConversations(): Promise<(typeof conversations.$inferSelect)[]>;
  createConversation(title: string): Promise<typeof conversations.$inferSelect>;
  deleteConversation(id: number): Promise<void>;
  getMessagesByConversation(conversationId: number): Promise<(typeof messages.$inferSelect)[]>;
  createMessage(conversationId: number, role: string, content: string, sources?: string[]): Promise<typeof messages.$inferSelect>;

  // Knowledge Base
  getKB(id: number): Promise<typeof knowledgeBase.$inferSelect | undefined>;
  getAllKB(): Promise<(typeof knowledgeBase.$inferSelect)[]>;
  createKB(kb: InsertKnowledgeBase): Promise<typeof knowledgeBase.$inferSelect>;
  updateKB(id: number, kb: Partial<InsertKnowledgeBase>): Promise<typeof knowledgeBase.$inferSelect>;
  deleteKB(id: number): Promise<void>;

  // Whitelist
  getAllUsers(): Promise<(typeof whitelistedUsers.$inferSelect)[]>;
  getUserByEmail(email: string): Promise<typeof whitelistedUsers.$inferSelect | undefined>;
  createUser(user: InsertWhitelistedUser): Promise<typeof whitelistedUsers.$inferSelect>;
  updateUser(id: number, data: Partial<InsertWhitelistedUser>): Promise<typeof whitelistedUsers.$inferSelect>;
  deleteUser(id: number): Promise<void>;
  isWhitelistEmpty(): Promise<boolean>;

  // Token usage
  recordTokenUsage(conversationId: number, messageId: number | null, promptTokens: number, completionTokens: number): Promise<void>;
  getTokenStats(): Promise<{ totalPrompt: number; totalCompletion: number; totalTokens: number; byConversation: { conversationId: number; total: number }[] }>;
}

export const chatStorage: IChatStorage = {
  async getConversation(id: number) {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conversation;
  },

  async getAllConversations() {
    return db.select().from(conversations).orderBy(desc(conversations.createdAt));
  },

  async createConversation(title: string) {
    const [conversation] = await db.insert(conversations).values({ title }).returning();
    return conversation;
  },

  async deleteConversation(id: number) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  },

  async getMessagesByConversation(conversationId: number) {
    return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt);
  },

  async createMessage(conversationId: number, role: string, content: string, sources?: string[]) {
    const [message] = await db.insert(messages).values({ conversationId, role, content, sources }).returning();
    return message;
  },

  async getKB(id: number) {
    const [kb] = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, id));
    return kb;
  },

  async getAllKB() {
    return db.select().from(knowledgeBase).orderBy(desc(knowledgeBase.updatedAt));
  },

  async createKB(kb: InsertKnowledgeBase) {
    const [newKb] = await db.insert(knowledgeBase).values(kb).returning();
    return newKb;
  },

  async updateKB(id: number, kb: Partial<InsertKnowledgeBase>) {
    const [updated] = await db.update(knowledgeBase).set({ ...kb, updatedAt: new Date() }).where(eq(knowledgeBase.id, id)).returning();
    return updated;
  },

  async deleteKB(id: number) {
    await db.delete(knowledgeBase).where(eq(knowledgeBase.id, id));
  },

  // ── Whitelist ──────────────────────────────────────
  async getAllUsers() {
    return db.select().from(whitelistedUsers).orderBy(whitelistedUsers.createdAt);
  },

  async getUserByEmail(email: string) {
    const [user] = await db.select().from(whitelistedUsers).where(eq(whitelistedUsers.email, email.toLowerCase().trim()));
    return user;
  },

  async createUser(user: InsertWhitelistedUser) {
    const [created] = await db.insert(whitelistedUsers).values({ ...user, email: user.email.toLowerCase().trim() }).returning();
    return created;
  },

  async updateUser(id: number, data: Partial<InsertWhitelistedUser>) {
    const [updated] = await db.update(whitelistedUsers).set(data).where(eq(whitelistedUsers.id, id)).returning();
    return updated;
  },

  async deleteUser(id: number) {
    await db.delete(whitelistedUsers).where(eq(whitelistedUsers.id, id));
  },

  async isWhitelistEmpty() {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(whitelistedUsers);
    return count === 0;
  },

  // ── Token Usage ───────────────────────────────────
  async recordTokenUsage(conversationId: number, messageId: number | null, promptTokens: number, completionTokens: number) {
    await db.insert(tokenUsage).values({
      conversationId,
      messageId,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });
  },

  async getTokenStats() {
    const [totals] = await db
      .select({
        totalPrompt: sql<number>`coalesce(sum(prompt_tokens), 0)::int`,
        totalCompletion: sql<number>`coalesce(sum(completion_tokens), 0)::int`,
        totalTokens: sql<number>`coalesce(sum(total_tokens), 0)::int`,
      })
      .from(tokenUsage);

    const byConversation = await db
      .select({
        conversationId: tokenUsage.conversationId,
        total: sql<number>`coalesce(sum(total_tokens), 0)::int`,
      })
      .from(tokenUsage)
      .groupBy(tokenUsage.conversationId);

    return { ...totals, byConversation };
  },
};
