import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import multer from "multer";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
import { chatStorage } from "./storage";
import type { ConversationState } from "@shared/schema";
import {
  msCredentialsConfigured,
  parseOdUrl,
  listFolder,
  extractFileContent,
  isSharingLink,
  isSharingLinkFolder,
  listSharedFolder,
  getSharedItemMeta,
  extractSharedFileContent,
} from "./onedrive";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── Attachment in-memory store (transient, cleared after use) ────────────────
interface AttachmentData {
  id: string;
  filename: string;
  mimeType: string;
  kind: "image" | "text" | "video_frame";
  base64DataUrl?: string;  // images + video frames
  extractedText?: string;  // PDFs, Word, Excel
}
const attachmentStore = new Map<string, AttachmentData>();

const execFileAsync = promisify(execFile);

async function extractVideoFrame(buffer: Buffer): Promise<string | null> {
  const tmpIn = `/tmp/att_${Date.now()}.in`;
  const tmpOut = `/tmp/att_${Date.now()}.jpg`;
  try {
    await fs.writeFile(tmpIn, buffer);
    await execFileAsync("ffmpeg", ["-i", tmpIn, "-ss", "00:00:01", "-vframes", "1", "-y", tmpOut]);
    const frame = await fs.readFile(tmpOut);
    return `data:image/jpeg;base64,${frame.toString("base64")}`;
  } catch {
    return null;
  } finally {
    await Promise.all([fs.unlink(tmpIn).catch(() => {}), fs.unlink(tmpOut).catch(() => {})]);
  }
}

function excelToText(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  return wb.SheetNames.map((name: string) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    return `Sheet: ${name}\n${csv}`;
  }).join("\n\n");
}

// ── Search helpers ──────────────────────────────────────────────────────

/** Tokenize text into normalized lowercase words, stripping common stop words */
function tokenize(text: string): string[] {
  const stopWords = new Set([
    'the','is','at','which','on','a','an','and','or','to','in','it','of',
    'for','with','this','that','are','was','be','if','not','can','do','go',
    'use','from','by','as','you','your','will','may','tip','pro','also',
    'all','any','has','have','been','then','they','their','its','our',
    'but','so','when','than','into','after','before','here','there',
  ]);
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

/** BM25-inspired keyword search — returns top-K most relevant KB entries */
function searchKBKeyword(
  query: string,
  kbs: Awaited<ReturnType<typeof chatStorage.getAllKB>>,
  topK = 5
): Awaited<ReturnType<typeof chatStorage.getAllKB>> {
  if (kbs.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return kbs.slice(0, topK);

  const N = kbs.length;

  // Pre-compute token sets and document frequency
  const docTokenSets = kbs.map(kb => new Set(tokenize(`${kb.title} ${kb.content}`)));
  const docFreq = new Map<string, number>();
  docTokenSets.forEach(ts => ts.forEach(t => docFreq.set(t, (docFreq.get(t) || 0) + 1)));

  const queryLower = query.toLowerCase();

  const scored = kbs.map((kb, i) => {
    const docTokens = docTokenSets[i];
    let score = 0;

    // IDF-weighted token match
    queryTokens.forEach(token => {
      if (docTokens.has(token)) {
        const df = docFreq.get(token) || 1;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        score += idf;
      }
    });

    // Phrase match bonuses (strong signal for exact keywords)
    const titleLower = kb.title.toLowerCase();
    const contentLower = kb.content.toLowerCase();
    if (titleLower.includes(queryLower)) score += 10;
    if (contentLower.includes(queryLower)) score += 3;

    // Partial word matches in title (e.g. "offline" matches "DeviceOffline")
    queryTokens.forEach(token => {
      if (titleLower.includes(token) && !docTokens.has(token)) score += 1;
    });

    return { kb, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.kb);
}

/** No-op kept for call-site compatibility — embeddings not supported by current AI proxy */
async function embedKB(_id: number, _title: string, _content: string): Promise<void> {}

/** Find top-K most relevant KB entries to the query using keyword search */
async function searchKB(query: string, topK = 5): Promise<Awaited<ReturnType<typeof chatStorage.getAllKB>>> {
  const kbs = await chatStorage.getAllKB();
  if (kbs.length === 0) return [];
  return searchKBKeyword(query, kbs, topK);
}

export const DEFAULT_SYSTEM_PROMPT = `You are a friendly, patient support assistant for Hero Electronix agents. You help agents resolve customer product issues step by step.

LANGUAGE RULE: Detect the language the agent writes in (English or Hindi) and always reply in the same language.

PERSONALITY:
- Warm and clear — like a helpful colleague, not a robot.
- Never dump all steps at once. Give ONE step at a time.
- After each troubleshooting step ask: "Did that work, or shall we try the next step?"
- Use simple language. Avoid jargon.
- Always end a resolved session with a brief summary and:
  📄 Source: [doc title] — [link]

YOU OPERATE IN STAGES. Always check the CURRENT SESSION STATE before responding. Never skip a stage or revisit a completed one.

STAGE 1 — UNDERSTAND THE ISSUE
- Listen to the agent's description of the customer's problem.
- In one sentence, confirm what you understood: the product and what's going wrong.
- Then immediately move to STAGE 2.

STAGE 2 — GUIDE THE AGENT TO GATHER DEVICE CONTEXT
- Do NOT ask one question at a time. Guide the agent in a single message to collect everything needed.
- Tell the agent exactly where to look and what to note, like this:

  "To get you the right steps, please check the following in Zoho CRM:
   1. Open the customer's SR or search by their email/phone.
   2. Go to the Device Health tab and note:
      - App connection status (connected / disconnected / decommissioned)
      - Signal status (online / offline)
      - Current firmware version
      - Which features are enabled and which are disabled
   Share all of this with me in one message and I'll take it from there."

- If the agent says they don't have a Zoho record or SR number:
  → Ask: "No problem — what is the product category and model number?"
  → Set kbOnlyMode = true and move to STAGE 4 directly.

STAGE 3 — ANALYSE AND ROUTE (runs as soon as device data is received)
Once the agent shares the Zoho device data, silently analyse it and pick the right path:

  PATH A — App is disconnected or decommissioned:
  → Tell the agent: "The device isn't paired to the Qubo app yet — we need to get it connected before troubleshooting the actual issue."
  → Pull the setup/commissioning KB doc for this product and model.
  → Follow STAGE 4 using that doc.

  PATH B — Signal is OFFLINE:
  → Tell the agent the device is offline and guide through the offline troubleshooting KB steps one at a time.
  → After each step ask: "Is the device showing online now?"
  → If device comes online: check firmware (see PATH C/D below).
  → If still offline after all steps: "We've tried everything available. Please transfer to a live agent."

  PATH C — Signal is ONLINE, firmware is outdated:
  → Tell the agent: "The firmware is out of date. Please raise a 'Software Update Needed' ticket in Zoho with subject: '[Model] — Firmware Update Required — [SR No.]'. Inform the customer it will be resolved within 48 hours."
  → Close the session once the ticket is raised.

  PATH D — Signal ONLINE, firmware current, app connected:
  → Move straight to STAGE 4 with the issue-specific KB doc.

STAGE 4 — STEP-BY-STEP KB TROUBLESHOOTING
- Find the most relevant KB doc for: product category + model + issue description.
- Before each step, silently check: does this step need a feature that is in featuresDisabled? If yes, skip it without mentioning it.
- Give ONE step at a time.
- After each step ask: "Did that work, or shall we try the next step?"
- If resolved: go to STAGE 5.
- If all steps exhausted: "We've gone through all available steps. I'll transfer you to a live agent now." End session.

STAGE 5 — CLOSE THE SESSION
- 2-line summary of what was found and what fixed it.
- Confirm the issue is resolved.
- End with: 📄 Source: [KB doc title] — [link]
- Thank the agent.

TOKEN RULES:
- Never restate the question.
- Never repeat device data the agent already shared.
- Never repeat a step already done.
- If the same KB doc is cited again, refer to it by name only.`;

/** Stage-aware KB search — enhances query with state context and boosts matching category/model docs */
async function searchKBWithState(
  userMessage: string,
  state: ConversationState | undefined,
  topK = 5,
): Promise<Awaited<ReturnType<typeof chatStorage.getAllKB>>> {
  const kbs = await chatStorage.getAllKB();
  if (kbs.length === 0) return [];

  const stage = state?.currentStage ?? "issue_extraction";

  // Build an enriched query combining user message, known issue, product context, and stage hints
  const parts: string[] = [userMessage];
  if (state?.issue) parts.push(state.issue);
  if (state?.productCategory) parts.push(state.productCategory);
  if (state?.modelNumber) parts.push(state.modelNumber);

  // Stage-specific keyword boosts
  if (stage === "analyse_and_route" && state?.appConnectionStatus && state.appConnectionStatus !== "connected") parts.push("setup commissioning pairing");
  if (stage === "analyse_and_route" && state?.signalStatus === "offline") parts.push("offline disconnected signal");
  if (stage === "kb_troubleshooting" && state?.kbOnlyMode) parts.push(state?.issue ?? "");

  const enrichedQuery = parts.filter(Boolean).join(" ");

  let results = searchKBKeyword(enrichedQuery, kbs, topK * 3); // fetch wider set first

  // If product category or model is known, keep only matching docs (or fall back to all)
  if (state?.productCategory || state?.modelNumber) {
    const cat = state?.productCategory?.toLowerCase() ?? "";
    const model = state?.modelNumber?.toLowerCase() ?? "";
    const filtered = results.filter(kb => {
      const catMatch = !cat || kb.productCategories?.some(c => c.toLowerCase().includes(cat) || cat.includes(c.toLowerCase()));
      const modelMatch = !model || kb.modelNumbers?.some(m => m.toLowerCase().includes(model) || model.includes(m.toLowerCase()));
      return catMatch || modelMatch;
    });
    if (filtered.length >= 2) results = filtered;
  }

  return results.slice(0, topK);
}

/** After the stream ends, use a cheap LLM call to extract state changes from the exchange */
async function extractAndSaveState(
  conversationId: number,
  currentState: ConversationState | undefined,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  try {
    const stateSnapshot = JSON.stringify({
      issue: currentState?.issue ?? null,
      productCategory: currentState?.productCategory ?? null,
      modelNumber: currentState?.modelNumber ?? null,
      srNumber: currentState?.srNumber ?? null,
      accountEmail: currentState?.accountEmail ?? null,
      identifierAvailable: currentState?.identifierAvailable ?? false,
      appConnectionStatus: currentState?.appConnectionStatus ?? null,
      signalStatus: currentState?.signalStatus ?? null,
      firmwareVersion: currentState?.firmwareVersion ?? null,
      firmwareStatus: currentState?.firmwareStatus ?? null,
      featuresEnabled: currentState?.featuresEnabled ?? [],
      featuresDisabled: currentState?.featuresDisabled ?? [],
      currentStage: currentState?.currentStage ?? "issue_extraction",
      troubleshootingIndex: currentState?.troubleshootingIndex ?? 0,
      kbOnlyMode: currentState?.kbOnlyMode ?? false,
    });

    const extraction = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        {
          role: "system",
          content: `You extract conversation state updates from a Hero Electronix support chat exchange.

Given the current state, the agent's message, and the assistant's response, return ONLY a JSON object containing fields that changed or were newly extracted. Omit fields that didn't change.

Valid field names and types:
- issue: string | null
- productCategory: string | null
- modelNumber: string | null
- srNumber: string | null
- accountEmail: string | null
- identifierAvailable: boolean
- appConnectionStatus: "connected" | "disconnected" | "decommissioned" | null
- signalStatus: "online" | "offline" | null
- firmwareVersion: string | null
- firmwareStatus: "ok" | "outdated" | "unknown" | null
- featuresEnabled: string[]
- featuresDisabled: string[]
- currentStage: "issue_extraction" | "device_context_collection" | "analyse_and_route" | "kb_troubleshooting" | "session_close"
- troubleshootingIndex: integer (increment when a KB step is completed)
- kbOnlyMode: boolean

Return {} if nothing changed. Return ONLY valid JSON, no markdown, no explanation.`,
        },
        {
          role: "user",
          content: `Current state:\n${stateSnapshot}\n\nAgent message:\n${userMessage}\n\nAssistant response:\n${assistantResponse}\n\nReturn JSON with only changed/new fields:`,
        },
      ],
      max_completion_tokens: 400,
    });

    const raw = (extraction.choices[0]?.message?.content ?? "{}").trim()
      .replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    const updates = JSON.parse(raw);
    if (updates && typeof updates === "object" && Object.keys(updates).length > 0) {
      await chatStorage.upsertConversationState(conversationId, updates);
      console.log(`[state] conv ${conversationId} updated:`, JSON.stringify(updates));
    }
  } catch (e: any) {
    console.error("[state-extract] Error:", e.message);
  }
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

  // ── Bot Settings ───────────────────────────────────
  app.get("/api/settings", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      const systemPrompt = await chatStorage.getSetting("system_prompt");
      const updatedAt = await chatStorage.getSetting("system_prompt_updated_at");
      res.json({ systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT, updatedAt });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.put("/api/settings", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      const { systemPrompt } = req.body;
      if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
        return res.status(400).json({ error: "systemPrompt is required" });
      }
      await chatStorage.setSetting("system_prompt", systemPrompt.trim());
      await chatStorage.setSetting("system_prompt_updated_at", new Date().toISOString());
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  app.post("/api/settings/reset", async (req: Request, res: Response) => {
    if (!await requireAdmin(req, res)) return;
    try {
      await chatStorage.setSetting("system_prompt", DEFAULT_SYSTEM_PROMPT);
      await chatStorage.setSetting("system_prompt_updated_at", new Date().toISOString());
      res.json({ ok: true, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    } catch (error) {
      res.status(500).json({ error: "Failed to reset settings" });
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
      // Initialise a clean state row so every new session starts at issue_extraction
      await chatStorage.resetConversationState(conversation.id);
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

  // Reset a stuck session back to issue_extraction without losing message history
  app.delete("/api/conversations/:id/state", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const conversation = await chatStorage.getConversation(id);
      if (!conversation) return res.status(404).json({ error: "Conversation not found" });
      await chatStorage.resetConversationState(id);
      res.json({ ok: true, message: "Session state reset to issue_extraction. Message history preserved." });
    } catch (error) {
      res.status(500).json({ error: "Failed to reset session state" });
    }
  });

  // ══════════════════════════════════════════════════
  // ATTACHMENT UPLOAD
  // ══════════════════════════════════════════════════

  app.post(
    "/api/conversations/:id/attachments",
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const { originalname, mimetype, buffer } = req.file;
        const id = randomUUID();
        const attachment: AttachmentData = { id, filename: originalname, mimeType: mimetype, kind: "text" };

        if (mimetype.startsWith("image/")) {
          attachment.kind = "image";
          attachment.base64DataUrl = `data:${mimetype};base64,${buffer.toString("base64")}`;

        } else if (mimetype === "application/pdf") {
          const parsed = await pdf(buffer);
          attachment.extractedText = parsed.text?.slice(0, 40000) ?? "";

        } else if (
          mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
          mimetype === "application/msword"
        ) {
          const result = await mammoth.extractRawText({ buffer });
          attachment.extractedText = result.value?.slice(0, 40000) ?? "";

        } else if (
          mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          mimetype === "application/vnd.ms-excel"
        ) {
          attachment.extractedText = excelToText(buffer).slice(0, 40000);

        } else if (mimetype.startsWith("video/")) {
          attachment.kind = "video_frame";
          const frame = await extractVideoFrame(buffer);
          if (frame) {
            attachment.base64DataUrl = frame;
          } else {
            // Fallback: just note the video was attached
            attachment.kind = "text";
            attachment.extractedText = `[Video file attached: ${originalname}. Frame extraction was not possible.]`;
          }

        } else {
          return res.status(415).json({ error: `Unsupported file type: ${mimetype}` });
        }

        attachmentStore.set(id, attachment);

        // Auto-purge after 30 minutes (server memory guard)
        setTimeout(() => attachmentStore.delete(id), 30 * 60 * 1000);

        res.json({
          id,
          filename: originalname,
          mimeType: mimetype,
          kind: attachment.kind,
          hasPreview: !!attachment.base64DataUrl,
        });
      } catch (error) {
        console.error("Attachment upload error:", error);
        res.status(500).json({ error: "Failed to process attachment" });
      }
    }
  );

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
        sourceUrl: fileItem.webUrl || null,
      });

      embedKB(kb.id, kb.title, kb.content); // async, fire-and-forget
      res.status(201).json(kb);
    } catch (err: any) {
      console.error("OneDrive import error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── "Anyone" sharing link routes (no Azure credentials needed) ──────────────

  // Detect what kind of URL was pasted and return routing info
  app.post("/api/onedrive/detect", (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });
    if (isSharingLink(url)) {
      res.json({ type: isSharingLinkFolder(url) ? "sharing-folder" : "sharing-file" });
    } else {
      res.json({ type: "folder-url" }); // original flow (needs credentials)
    }
  });

  // Browse a publicly shared folder — no credentials
  app.post("/api/onedrive/browse-shared", async (req: Request, res: Response) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "URL required" });
      if (!isSharingLinkFolder(url)) return res.status(400).json({ error: "URL must be a shared folder link (/:f:/)" });
      const files = await listSharedFolder(url);
      res.json({ files });
    } catch (err: any) {
      console.error("Shared folder browse error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Import a single publicly shared file — no credentials
  app.post("/api/onedrive/import-shared-file", async (req: Request, res: Response) => {
    try {
      const { url, productCategories, modelNumbers } = req.body;
      if (!url) return res.status(400).json({ error: "URL required" });

      // Get file metadata first (name, etc.)
      const meta = await getSharedItemMeta(url);
      if (meta.isFolder) return res.status(400).json({ error: "URL points to a folder. Use the folder browsing flow." });

      const content = await extractSharedFileContent(meta);
      if (!content.trim()) return res.status(422).json({ error: "Could not extract text from file." });

      const kb = await chatStorage.createKB({
        title: `OneDrive: ${meta.name}`,
        content: content.trim(),
        type: "onedrive",
        productCategories: productCategories || [],
        modelNumbers: modelNumbers || [],
        sourceUrl: url,
      });

      embedKB(kb.id, kb.title, kb.content); // async
      res.status(201).json(kb);
    } catch (err: any) {
      console.error("Shared file import error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Import selected files from a publicly shared folder — no credentials
  app.post("/api/onedrive/import-shared-folder-file", async (req: Request, res: Response) => {
    try {
      const { fileItem, productCategories, modelNumbers, folderUrl } = req.body;
      if (!fileItem) return res.status(400).json({ error: "fileItem required" });

      const content = await extractSharedFileContent(fileItem);
      if (!content.trim()) return res.status(422).json({ error: "Could not extract text from file." });

      // sourceUrl: prefer the folder sharing URL (re-browsable), fall back to file webUrl
      const sourceUrl = folderUrl || fileItem.sharingUrl || fileItem.webUrl || null;

      const kb = await chatStorage.createKB({
        title: `OneDrive: ${fileItem.name}`,
        content: content.trim(),
        type: "onedrive",
        productCategories: productCategories || [],
        modelNumbers: modelNumbers || [],
        sourceUrl,
      });

      embedKB(kb.id, kb.title, kb.content); // async
      res.status(201).json(kb);
    } catch (err: any) {
      console.error("Shared folder file import error:", err.message);
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

  // Refresh a KB entry from its original OneDrive source URL
  app.post("/api/kb/:id/refresh", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const kb = await chatStorage.getKB(id);
      if (!kb) return res.status(404).json({ error: "KB entry not found" });
      if (!kb.sourceUrl) return res.status(400).json({ error: "No source URL stored for this entry. Only OneDrive-imported entries can be refreshed." });

      const sourceUrl = kb.sourceUrl;
      let newContent = "";

      if (isSharingLink(sourceUrl) && !isSharingLinkFolder(sourceUrl)) {
        // Single "Anyone" shared file — re-download directly
        const meta = await getSharedItemMeta(sourceUrl);
        newContent = await extractSharedFileContent(meta);
      } else if (isSharingLink(sourceUrl) && isSharingLinkFolder(sourceUrl)) {
        // File was imported from a shared folder — re-list folder and find by filename
        const fileName = kb.title.replace(/^OneDrive:\s*/i, "").trim();
        const files = await listSharedFolder(sourceUrl);
        const match = files.find(f => f.name === fileName);
        if (!match) return res.status(404).json({ error: `File "${fileName}" not found in shared folder. It may have been renamed or moved.` });
        newContent = await extractSharedFileContent(match);
      } else {
        return res.status(400).json({ error: "This entry was imported via Azure credentials. Manual refresh is not supported yet — please re-import from the OneDrive tab." });
      }

      if (!newContent.trim()) return res.status(422).json({ error: "Could not extract text from the file." });

      const updated = await chatStorage.updateKB(id, { content: newContent.trim() });
      embedKB(id, updated.title, updated.content); // re-embed async
      res.json({ ...updated, refreshed: true });
    } catch (err: any) {
      console.error("KB refresh error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════
  // CHAT (SSE streaming)
  // ══════════════════════════════════════════════════

  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id);
      const { content, attachmentIds } = req.body;

      // Resolve any uploaded attachments
      const attachments: AttachmentData[] = ((attachmentIds ?? []) as string[])
        .map(id => attachmentStore.get(id))
        .filter(Boolean) as AttachmentData[];

      // Build the display text saved to DB (attachment labels appended so history is readable)
      const attachmentLabels = attachments
        .map(a => `[Attached: ${a.filename}${a.kind === "video_frame" ? " (video frame)" : ""}]`)
        .join(" ");
      const userDisplayContent = [content, attachmentLabels].filter(Boolean).join("\n");

      await chatStorage.createMessage(conversationId, "user", userDisplayContent);

      // 1. Load conversation state — drives stage-aware search and prompt injection
      const state = await chatStorage.getConversationState(conversationId);

      // 2. State-aware KB search: enriches query with known issue/product/stage context
      const relevantKBs = await searchKBWithState(content || attachments.map(a => a.filename).join(" "), state, 5);
      const kbContext = relevantKBs.map(k => {
        const tags: string[] = [];
        if (k.productCategories?.length) tags.push(`Product: ${k.productCategories.join(", ")}`);
        if (k.modelNumbers?.length) tags.push(`Model: ${k.modelNumbers.join(", ")}`);
        if (k.firmwareRequired && k.firmwareRequired !== "not_applicable") tags.push(`Firmware: ${k.firmwareRequired}+`);
        if (k.appVersionRequired && k.appVersionRequired !== "not_applicable") tags.push(`App: ${k.appVersionRequired}+`);
        const tagStr = tags.length ? ` [${tags.join(" | ")}]` : "";
        const sourceLink = k.sourceUrl ? ` (${k.sourceUrl})` : "";
        return `[Source: ${k.title}${sourceLink}]${tagStr}\n${k.content}`;
      }).join("\n\n");

      const messages = await chatStorage.getMessagesByConversation(conversationId);
      // Build chat messages — use multimodal content for the last user message if attachments exist
      const chatMessages: Array<{ role: "user" | "assistant" | "system"; content: any }> = messages.map((m, idx) => {
        const isLastUserMsg = idx === messages.length - 1 && m.role === "user" && attachments.length > 0;
        if (!isLastUserMsg) {
          return { role: m.role as "user" | "assistant", content: m.content };
        }

        // Build multimodal content array
        const textParts: string[] = [];
        if (content) textParts.push(content);
        const contentParts: any[] = [];

        for (const att of attachments) {
          if ((att.kind === "image" || att.kind === "video_frame") && att.base64DataUrl) {
            if (att.kind === "video_frame") {
              textParts.push(`[Frame extracted from video: ${att.filename}. Analyse what is visible.]`);
            }
            contentParts.push({ type: "image_url", image_url: { url: att.base64DataUrl } });
          } else if (att.extractedText) {
            textParts.push(`[Attached document: ${att.filename}]\n${att.extractedText}`);
          }
          attachmentStore.delete(att.id); // clean up after use
        }

        if (textParts.length > 0) {
          contentParts.unshift({ type: "text", text: textParts.join("\n\n") });
        }

        return { role: "user" as const, content: contentParts.length > 0 ? contentParts : m.content };
      });

      // 3. Build system prompt — inject CURRENT SESSION STATE block at the top
      const savedPrompt = await chatStorage.getSetting("system_prompt");
      const basePrompt = savedPrompt ?? DEFAULT_SYSTEM_PROMPT;

      const sessionState = {
        currentStage: state?.currentStage ?? "issue_extraction",
        issue: state?.issue ?? null,
        productCategory: state?.productCategory ?? null,
        modelNumber: state?.modelNumber ?? null,
        srNumber: state?.srNumber ?? null,
        accountEmail: state?.accountEmail ?? null,
        identifierAvailable: state?.identifierAvailable ?? false,
        appConnectionStatus: state?.appConnectionStatus ?? null,
        signalStatus: state?.signalStatus ?? null,
        firmwareVersion: state?.firmwareVersion ?? null,
        firmwareStatus: state?.firmwareStatus ?? null,
        featuresEnabled: state?.featuresEnabled ?? [],
        featuresDisabled: state?.featuresDisabled ?? [],
        troubleshootingIndex: state?.troubleshootingIndex ?? 0,
        kbOnlyMode: state?.kbOnlyMode ?? false,
      };

      const systemPromptWithState =
        `CURRENT SESSION STATE:\n${JSON.stringify(sessionState, null, 2)}\n\n` +
        `${basePrompt}\n\nYOUR KNOWLEDGE BASE:\n${kbContext}`;

      chatMessages.unshift({
        role: "system",
        content: systemPromptWithState,
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
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      const sourceMatches = fullResponse.match(/\[Source: [^\]]+\]/g) || [];
      const sources = Array.from(new Set(sourceMatches));

      const savedMsg = await chatStorage.createMessage(conversationId, "assistant", fullResponse, sources);

      if (promptTokens > 0 || completionTokens > 0) {
        await chatStorage.recordTokenUsage(conversationId, savedMsg.id, promptTokens, completionTokens);
      }

      res.write(`data: ${JSON.stringify({ done: true, sources, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } })}\n\n`);
      res.end();

      // 4. Fire-and-forget state extraction — runs after response is sent, zero client latency impact
      extractAndSaveState(conversationId, state, content, fullResponse).catch(() => {});

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
