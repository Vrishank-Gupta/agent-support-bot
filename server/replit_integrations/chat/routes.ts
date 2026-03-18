import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import { chatStorage } from "./storage";
import {
  msCredentialsConfigured,
  parseOdUrl,
  listFolder,
  extractFileContent,
} from "./onedrive";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Embedding helpers ──────────────────────────────────────────────────────

/** Generate a 1536-dim embedding using text-embedding-3-small */
async function generateEmbedding(text: string): Promise<number[]> {
  const input = text.slice(0, 8000); // stay well within token limits
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input });
  return res.data[0].embedding;
}

/** Cosine similarity between two equal-length vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Generate embedding for a KB entry and persist it (fire-and-forget safe) */
async function embedKB(id: number, title: string, content: string): Promise<void> {
  try {
    const embedding = await generateEmbedding(`${title}\n\n${content}`);
    await chatStorage.updateKBEmbedding(id, embedding);
  } catch (err: any) {
    console.error(`[embed] failed for KB ${id}:`, err.message);
  }
}

/** Find top-K most semantically similar KB entries to the query */
async function searchKB(query: string, topK = 5): Promise<(typeof import("@shared/schema").knowledgeBase.$inferSelect)[]> {
  const kbs = await chatStorage.getAllKB();
  const withEmbeddings = kbs.filter(k => k.embedding && k.embedding.length > 0);

  if (withEmbeddings.length === 0) {
    // Fallback: return all if nothing is embedded yet
    return kbs.slice(0, topK);
  }

  const queryEmbedding = await generateEmbedding(query);

  const scored = withEmbeddings.map(k => ({
    kb: k,
    score: cosineSimilarity(queryEmbedding, k.embedding as number[]),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.kb);
}

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
  // ONEDRIVE GRAPH API — BROWSE & IMPORT
  // ══════════════════════════════════════════════════

  // Check if MS credentials are configured
  app.get("/api/onedrive/status", (req: Request, res: Response) => {
    res.json({ configured: msCredentialsConfigured() });
  });

  // Browse a OneDrive folder URL — returns list of files
  app.post("/api/onedrive/browse", async (req: Request, res: Response) => {
    try {
      if (!msCredentialsConfigured()) {
        return res.status(503).json({ error: "Microsoft credentials not configured. Please set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET in Secrets." });
      }
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "URL required" });

      const parsed = parseOdUrl(url);
      const files = await listFolder(parsed);
      res.json({ files, parsed: { upn: parsed.upn, drivePath: parsed.drivePath } });
    } catch (err: any) {
      console.error("OneDrive browse error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Import a specific file from OneDrive into the KB
  app.post("/api/onedrive/import-file", async (req: Request, res: Response) => {
    try {
      if (!msCredentialsConfigured()) {
        return res.status(503).json({ error: "Microsoft credentials not configured." });
      }

      const { fileItem, upn, productCategories, modelNumbers } = req.body;
      if (!fileItem || !upn) return res.status(400).json({ error: "fileItem and upn required" });

      const content = await extractFileContent(fileItem, upn);
      if (!content.trim()) {
        return res.status(422).json({ error: "Could not extract text from file." });
      }

      const kb = await chatStorage.createKB({
        title: `OneDrive: ${fileItem.name}`,
        content: content.trim(),
        type: "onedrive",
        productCategories: productCategories || [],
        modelNumbers: modelNumbers || [],
      });

      embedKB(kb.id, kb.title, kb.content); // async, fire-and-forget
      res.status(201).json(kb);
    } catch (err: any) {
      console.error("OneDrive import error:", err.message);
      res.status(500).json({ error: err.message });
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
      embedKB(kb.id, kb.title, kb.content); // async, fire-and-forget
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
      embedKB(kb.id, kb.title, kb.content); // async, fire-and-forget
      res.status(201).json(kb);
    } catch (error) {
      res.status(500).json({ error: "Failed to create KB" });
    }
  });

  app.patch("/api/kb/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const kb = await chatStorage.updateKB(id, req.body);
      embedKB(kb.id, kb.title, kb.content); // re-embed on content change
      res.json(kb);
    } catch (error) {
      res.status(500).json({ error: "Failed to update KB" });
    }
  });

  // Admin: reindex all KB entries (regenerate embeddings)
  app.post("/api/kb/reindex", async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;
    try {
      const all = await chatStorage.getAllKB();
      res.json({ message: `Reindexing ${all.length} entries in background...` });
      // Process in background after responding
      (async () => {
        let done = 0;
        for (const kb of all) {
          await embedKB(kb.id, kb.title, kb.content);
          done++;
          console.log(`[reindex] ${done}/${all.length} — ${kb.title}`);
        }
        console.log("[reindex] Complete");
      })();
    } catch (error) {
      res.status(500).json({ error: "Failed to start reindex" });
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

      // Vector search: embed the query and retrieve the top-5 most relevant KB entries
      const relevantKBs = await searchKB(content, 5);
      const kbContext = relevantKBs.map(k => {
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
        content: `You are an internal support assistant for Hero Electronix. You help support agents resolve product issues quickly using the knowledge base.

CORE RULES
1. Always confirm product category, model number, and — where the doc requires it — firmware/software version BEFORE giving any steps.
2. Collect all missing context in one single question. Never ask across multiple turns.
3. Give short, numbered steps only. Max 5 steps. If more exist, summarize and link.
4. End every answer with: Source: [doc title]
5. If no KB doc matches, say: "No doc found. Please escalate."
6. Never guess. Never use information outside the KB.
7. Support both English and Hindi — respond in the same language the agent uses.

TOKEN RULES
- Do not restate the question.
- Do not repeat the doc header in your reply.
- Skip background context unless the agent asks.
- If the same doc is referenced again in the conversation, cite by name only.

KB DOCUMENT STRUCTURE
Every doc has a structured header:
  - Product Category
  - Model No
  - Issue
  - Firmware Required: [version] OR "Not applicable"

EXTRACTION FLOW
Step 1 — Collect mandatory context
  Check for: product category, model number.
  Also check the matched doc's "Firmware Required" field.
  If firmware version is required, include it in the same upfront question.
  Ask everything in one message — never split across turns.

Step 2 — Match the doc
  Match using: Product Category + Model No + Issue keywords.
  If firmware version is required and the agent's version doesn't meet minimum:
  → "This fix requires firmware v[X]+. Agent must update firmware first. [Link]"

Step 3 — Respond
  - Return only steps relevant to the reported issue.
  - Max 5 steps. If more exist: "Full steps in doc: [title]"
  - End with: Source: [doc title]

FIRMWARE SCAN RULE
On every KB doc match:
  - Check if "Firmware Required" ≠ "Not applicable"
  - If yes → collect firmware version before building any response
  - Do not begin troubleshooting until version is confirmed

YOUR KNOWLEDGE BASE:
${kbContext}`,
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

  // ── Startup: auto-embed any KB entries that are missing embeddings ────────
  (async () => {
    try {
      await new Promise(r => setTimeout(r, 3000)); // wait for server to settle
      const unindexed = await chatStorage.getKBsWithoutEmbedding();
      if (unindexed.length === 0) return;
      console.log(`[embed] Auto-indexing ${unindexed.length} KB entries without embeddings...`);
      for (const kb of unindexed) {
        await embedKB(kb.id, kb.title, kb.content);
      }
      console.log(`[embed] Auto-indexing complete.`);
    } catch (e: any) {
      console.error("[embed] Auto-index error:", e.message);
    }
  })();
}
