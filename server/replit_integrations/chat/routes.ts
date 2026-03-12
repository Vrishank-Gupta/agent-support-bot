import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import { chatStorage } from "./storage";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export function registerChatRoutes(app: Express): void {

  // ══════════════════════════════════════════════════
  // AUTH / WHITELIST CHECK
  // ══════════════════════════════════════════════════

  // Check if an email is whitelisted and return user info
  app.post("/api/auth/check-email", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      // If whitelist is empty, the first user becomes admin
      const isEmpty = await chatStorage.isWhitelistEmpty();
      if (isEmpty) {
        const adminUser = await chatStorage.createUser({
          email,
          role: "admin",
          canAddKB: true,
          name: null,
        });
        return res.json({ allowed: true, user: adminUser, isFirstAdmin: true });
      }

      const user = await chatStorage.getUserByEmail(email);
      if (!user) return res.json({ allowed: false });
      return res.json({ allowed: true, user });
    } catch (error) {
      console.error("Email check error:", error);
      res.status(500).json({ error: "Failed to check email" });
    }
  });

  // ══════════════════════════════════════════════════
  // ADMIN ROUTES (protected by admin email header)
  // ══════════════════════════════════════════════════

  async function requireAdmin(req: Request, res: Response): Promise<boolean> {
    const email = req.headers["x-user-email"] as string;
    if (!email) { res.status(401).json({ error: "Unauthorized" }); return false; }
    const user = await chatStorage.getUserByEmail(email);
    if (!user || user.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return false; }
    return true;
  }

  // List all users
  app.get("/api/admin/users", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      const users = await chatStorage.getAllUsers();
      res.json(users);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Add a user to whitelist
  app.post("/api/admin/users", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      const { email, name, role, canAddKB } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      const existing = await chatStorage.getUserByEmail(email);
      if (existing) return res.status(409).json({ error: "Email already whitelisted" });

      const user = await chatStorage.createUser({ email, name: name || null, role: role || "agent", canAddKB: !!canAddKB });
      res.status(201).json(user);
    } catch (error) {
      res.status(500).json({ error: "Failed to add user" });
    }
  });

  // Update user
  app.patch("/api/admin/users/:id", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id);
      const { name, role, canAddKB } = req.body;
      const user = await chatStorage.updateUser(id, { name, role, canAddKB });
      res.json(user);
    } catch (error) {
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // Delete user
  app.delete("/api/admin/users/:id", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id);
      await chatStorage.deleteUser(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // Token usage stats
  app.get("/api/admin/tokens", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      const stats = await chatStorage.getTokenStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch token stats" });
    }
  });

  // ══════════════════════════════════════════════════
  // CONVERSATIONS
  // ══════════════════════════════════════════════════

  app.get("/api/conversations", async (req: Request, res: Response) => {
    try {
      const conversations = await chatStorage.getAllConversations();
      res.json(conversations);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  app.get("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const conversation = await chatStorage.getConversation(id);
      if (!conversation) return res.status(404).json({ error: "Conversation not found" });
      const messages = await chatStorage.getMessagesByConversation(id);
      res.json({ ...conversation, messages });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  });

  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const { title } = req.body;
      const conversation = await chatStorage.createConversation(title || "New Chat");
      res.status(201).json(conversation);
    } catch (error) {
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  // ══════════════════════════════════════════════════
  // FILE UPLOAD TO KB
  // ══════════════════════════════════════════════════

  app.post("/api/kb/upload", upload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const { originalname, mimetype, buffer } = req.file;
      let content = "";
      const title = `OneDrive: ${originalname}`;

      if (mimetype === "application/pdf" || originalname.endsWith(".pdf")) {
        const parsed = await pdf(buffer);
        content = parsed.text.slice(0, 50000);
      } else if (mimetype === "text/plain" || originalname.endsWith(".txt") || originalname.endsWith(".md")) {
        content = buffer.toString("utf-8").slice(0, 50000);
      } else {
        content = buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").slice(0, 50000);
      }

      if (!content.trim()) {
        return res.status(422).json({ error: "Could not extract text from file. Please try a .txt or .pdf file." });
      }

      let productCategories: string[] = [];
      let modelNumbers: string[] = [];
      try {
        if (req.body.productCategories) productCategories = JSON.parse(req.body.productCategories);
        if (req.body.modelNumbers) modelNumbers = JSON.parse(req.body.modelNumbers);
      } catch {}

      const kb = await chatStorage.createKB({ title, content: content.trim(), type: "onedrive", productCategories, modelNumbers });
      res.status(201).json(kb);
    } catch (error) {
      console.error("File upload error:", error);
      res.status(500).json({ error: "Failed to process file" });
    }
  });

  // ══════════════════════════════════════════════════
  // KB CRUD
  // ══════════════════════════════════════════════════

  app.get("/api/kb", async (req: Request, res: Response) => {
    try {
      const kbs = await chatStorage.getAllKB();
      res.json(kbs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch KB" });
    }
  });

  app.post("/api/kb", async (req: Request, res: Response) => {
    try {
      const kb = await chatStorage.createKB(req.body);
      res.status(201).json(kb);
    } catch (error) {
      res.status(500).json({ error: "Failed to create KB" });
    }
  });

  app.patch("/api/kb/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const kb = await chatStorage.updateKB(id, req.body);
      res.json(kb);
    } catch (error) {
      res.status(500).json({ error: "Failed to update KB" });
    }
  });

  app.delete("/api/kb/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      await chatStorage.deleteKB(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete KB" });
    }
  });

  // ══════════════════════════════════════════════════
  // CHAT (SSE streaming)
  // ══════════════════════════════════════════════════

  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id);
      const { content } = req.body;

      await chatStorage.createMessage(conversationId, "user", content);

      const kbs = await chatStorage.getAllKB();
      const kbContext = kbs.map(k => {
        const tags: string[] = [];
        if (k.productCategories?.length) tags.push(`Product: ${k.productCategories.join(", ")}`);
        if (k.modelNumbers?.length) tags.push(`Model: ${k.modelNumbers.join(", ")}`);
        const tagStr = tags.length ? ` [${tags.join(" | ")}]` : "";
        return `[Source: ${k.title}]${tagStr}\n${k.content}`;
      }).join("\n\n");

      const messages = await chatStorage.getMessagesByConversation(conversationId);
      const chatMessages = messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      chatMessages.unshift({
        role: "system",
        content: `You are an AI assistant designed to train and assist customer support agents handling escalations.
Act as a human-like trainer. Guide the agent step-by-step to solve the customer's issue.
Support both English and Hindi languages based on the agent's query.

YOUR KNOWLEDGE BASE:
${kbContext}

IMPORTANT: When answering, you MUST mention which source from the knowledge base you are using. 
Reference them as [Source: Title].`,
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: chatMessages as any,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 8192,
      });

      let fullResponse = "";
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
        // Capture usage from final chunk
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      const sourceMatches = fullResponse.match(/\[Source: [^\]]+\]/g) || [];
      const sources = Array.from(new Set(sourceMatches));

      const savedMsg = await chatStorage.createMessage(conversationId, "assistant", fullResponse, sources);

      // Record token usage
      if (promptTokens > 0 || completionTokens > 0) {
        await chatStorage.recordTokenUsage(conversationId, savedMsg.id, promptTokens, completionTokens);
      }

      res.write(`data: ${JSON.stringify({ done: true, sources, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Error sending message:", error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Failed to send message" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to send message" });
      }
    }
  });
}
