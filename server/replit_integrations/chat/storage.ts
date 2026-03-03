import { db } from "../../db";
import { conversations, messages, knowledgeBase, type InsertKnowledgeBase } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

export interface IChatStorage {
  getConversation(id: number): Promise<typeof conversations.$inferSelect | undefined>;
  getAllConversations(): Promise<(typeof conversations.$inferSelect)[]>;
  createConversation(title: string): Promise<typeof conversations.$inferSelect>;
  deleteConversation(id: number): Promise<void>;
  getMessagesByConversation(conversationId: number): Promise<(typeof messages.$inferSelect)[]>;
  createMessage(conversationId: number, role: string, content: string, sources?: string[]): Promise<typeof messages.$inferSelect>;
  
  // Knowledge Base methods
  getKB(id: number): Promise<typeof knowledgeBase.$inferSelect | undefined>;
  getAllKB(): Promise<(typeof knowledgeBase.$inferSelect)[]>;
  createKB(kb: InsertKnowledgeBase): Promise<typeof knowledgeBase.$inferSelect>;
  updateKB(id: number, kb: Partial<InsertKnowledgeBase>): Promise<typeof knowledgeBase.$inferSelect>;
  deleteKB(id: number): Promise<void>;
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
};

