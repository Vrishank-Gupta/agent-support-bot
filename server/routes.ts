import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerChatRoutes } from "./replit_integrations/chat";
import { chatStorage } from "./replit_integrations/chat/storage";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Call the integration chat routes (handles /api/conversations CRUD and messages with SSE)
  registerChatRoutes(app);

  // Auto-seed database if empty (run eagerly so the app looks populated immediately)
  (async () => {
    try {
      const convos = await chatStorage.getAllConversations();
      if (convos.length === 0) {
        const c = await chatStorage.createConversation("Customer Issue: Password Reset");
        await chatStorage.createMessage(c.id, "user", "How do I help a customer reset their password? They don't have access to their email.");
        await chatStorage.createMessage(c.id, "assistant", "Based on Zoho knowledge link ZK-492, if the customer cannot access their email, you need to verify their identity through security questions. Once verified, you can update their email address in the admin panel and send a reset link to the new address.");
      }
    } catch (e) {
      console.error("Failed to seed database:", e);
    }
  })();

  return httpServer;
}
