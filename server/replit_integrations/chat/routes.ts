import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import multer from "multer";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { serializeSessionState } from "./sessionState";
import { trimConversationHistory } from "./trimConversationHistory";
import { searchKB as hybridSearchKB, buildKBQuery, embedKBArticle, indexKBArticleChunks, backfillEmbeddings } from "./kbSearch";
import type { KBArticle } from "./kbSearch";
import { extractDocumentText } from "./documentExtraction";
import type { FullSessionState } from "./sessionState";
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
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "missing-openai-key",
  baseURL: process.env.OPENAI_API_KEY ? undefined : process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

function hasOpenAIKey(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
}

function extractResponseText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

function toResponsesContent(content: any): any {
  if (!Array.isArray(content)) return content ?? "";
  return content.map((part) => {
    if (part?.type === "text") {
      return { type: "input_text", text: part.text ?? "" };
    }
    if (part?.type === "image_url") {
      return {
        type: "input_image",
        image_url: part.image_url?.url ?? part.image_url ?? "",
        detail: "auto",
      };
    }
    return part;
  });
}

function toResponsesInput(messages: Array<{ role: string; content: any }>): any[] {
  return messages.map((message) => ({
    role: message.role,
    content: toResponsesContent(message.content),
  }));
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(item => typeof item === "string" ? item.trim() : "")
      .filter(Boolean),
  ));
}

const KB_RESULT_LIMIT = Math.max(1, Math.floor(readNumberEnv("KB_RESULT_LIMIT", 3)));
const MIN_KB_RELEVANCE_SCORE = Math.max(0, readNumberEnv("MIN_KB_RELEVANCE_SCORE", 0.05));
const KB_FULL_DOC_CHAR_LIMIT = Math.max(1000, Math.floor(readNumberEnv("KB_FULL_DOC_CHAR_LIMIT", 3500)));
const KB_CHUNK_CHAR_LIMIT = Math.max(1200, Math.floor(readNumberEnv("KB_CHUNK_CHAR_LIMIT", 2400)));
const KB_CHUNKS_PER_ARTICLE = Math.max(1, Math.floor(readNumberEnv("KB_CHUNKS_PER_ARTICLE", 2)));
const KB_TOTAL_CHAR_BUDGET = Math.max(KB_CHUNK_CHAR_LIMIT, Math.floor(readNumberEnv("KB_TOTAL_CHAR_BUDGET", 9000)));
const PROMPT_CACHE_KEY = process.env.PROMPT_CACHE_KEY ?? "qubo-support-bot-v1";
const RESPONSE_STYLE_GUARD = `RESPONSE STYLE CONTRACT
- Match the agent's language and script for the ENTIRE reply including the check-in. If the agent writes Hinglish/Hindi in Roman script, every sentence including the check-in must be in Hinglish. If the agent writes English, reply in English. Never switch languages mid-reply.
- Do not echo, quote, or restate the agent's latest message.
- Start with the conclusion or next action. Avoid filler like "Since you said..." unless it adds new diagnostic value.
- Never say "stage", "phase", "workflow", "state", "advance", or "next stage" to the agent.
- If the issue could match multiple SOPs, ask focused clarifying questions — one at a time, up to 3 total — until you are confident about the right SOP. Once confident, move directly into the solution.
- Clarifying questions are not troubleshooting replies: do not end a clarifying question with a check-in.
- Clarifying questions must be question-only. Do not include action verbs such as "check", "try", "restart", "open", or "go to" before the question.
- Troubleshooting steps should read like a knowledgeable colleague talking — one clear action, then a brief natural check-in in the same language as the reply.
- Never contradict information you already asked for. If you asked for an SR number and received one, use it — never say "I don't need it" after asking.
- Never say "Step skipped" unless the exact skipped feature appears in the SESSION STATE disabledFeatures array.
- Keep replies confident and concise. No emoji headers, no numbered lists for individual steps.
- Never show internal stage names, state fields, retrieval details, or token/caching details.`;

const stageNameMap: Record<string, FullSessionState["currentStage"]> = {
  "device_context_collection": "device_settings_collection",
  "analyse_and_route": "commissioning_check",
  "firmware_signal_check": "kb_match",
  "kb_troubleshooting": "diagnose_troubleshoot",
  "session_close": "close",
};

const stageOrder: FullSessionState["currentStage"][] = [
  "issue_extraction",
  "identifier_collection",
  "commissioning_check",
  "kb_match",
  "device_settings_collection",
  "diagnose_troubleshoot",
  "close",
];

const kbActiveStages = new Set<FullSessionState["currentStage"]>([
  "commissioning_check",
  "kb_match",
  "device_settings_collection",
  "diagnose_troubleshoot",
  "close",
]);

function normalizeStage(stage: string | null | undefined): FullSessionState["currentStage"] {
  if (!stage) return "issue_extraction";
  const mapped = stageNameMap[stage];
  if (mapped) return mapped;
  return stageOrder.includes(stage as FullSessionState["currentStage"])
    ? stage as FullSessionState["currentStage"]
    : "issue_extraction";
}

function isKBActiveStage(stage: string | null | undefined, kbOnlyMode = false): boolean {
  return kbOnlyMode || kbActiveStages.has(normalizeStage(stage));
}

function stageTokenCap(stage: FullSessionState["currentStage"], kbOnlyMode: boolean): number {
  if (stage === "issue_extraction") return 250;
  if (stage === "identifier_collection") return 200;
  if (stage === "commissioning_check") return 300;
  if (stage === "kb_match" || stage === "device_settings_collection") return 400;
  if (stage === "diagnose_troubleshoot") return kbOnlyMode ? 350 : 700;
  return 250;
}

function buildStageScopedPrompt(basePrompt: string, stage: FullSessionState["currentStage"]): string {
  const withoutState = basePrompt
    .replace(/#\s*SESSION STATE\s*\n+\s*\{\{SESSION_STATE\}\}/i, "")
    .replace(/\{\{SESSION_STATE\}\}/g, "")
    .trim();

  const stageHeading = `STAGE ${stageOrder.indexOf(stage) + 1}`;
  const nextStageNumber = stageOrder.indexOf(stage) + 2;
  const stageMatch = withoutState.match(new RegExp(
    `(^|\\n)#{1,3}\\s*${stageHeading}[^\\n]*[\\s\\S]*?(?=\\n#{1,3}\\s*STAGE ${nextStageNumber}(?:[A-Z])?\\b|$)`,
    "i",
  ));
  const beforeStages = withoutState.split(/\n#{1,3}\s*Stage Blocks/i)[0]?.trim() ?? withoutState;

  if (!stageMatch) return withoutState;
  return [
    beforeStages.replace(/\{\{STAGE_BLOCK\}\}/g, stageMatch[0].trim()),
  ].join("\n\n").trim();
}

function isNegativeConfirmation(text: string): boolean {
  return /\b(no|didn'?t|still|same|next|try next|not working|failed|issue remains|nahi chala|nhi chala)\b/i.test(text);
}

function isResolvedConfirmation(text: string): boolean {
  return /\b(resolved|fixed|working now|works now|done|yes it worked|issue solved)\b/i.test(text);
}

function extractDeterministicStateFromMessage(
  currentState: ConversationState | undefined,
  text: string,
): Partial<ConversationState> {
  const updates: Partial<ConversationState> = {};
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const sr = text.match(/\b(?:SR|ticket|case)[\s:#-]*([A-Z0-9-]{4,})\b/i)?.[1];
  const firmware = text.match(/\b[A-Z]{2,}[A-Z0-9]*[_-]\d{2}[_-]\d{2}[_-]\d{2,}(?:[_-][A-Z]+)?\b/i)?.[0];

  if (email && !currentState?.accountEmail) updates.accountEmail = email;
  if (sr && !currentState?.srNumber) updates.srNumber = sr;
  if (firmware && !currentState?.firmwareVersion) updates.firmwareVersion = firmware;
  if (!currentState?.productCategory) {
    if (/\b(camera|cam)\b/i.test(text)) updates.productCategory = "Camera";
    else if (/\b(doorbell|video\s*doorbell)\b/i.test(text)) updates.productCategory = "Video Doorbell";
    else if (/\b(lock|door\s*lock)\b/i.test(text)) updates.productCategory = "Door Lock";
    else if (/\b(purifier|air\s*purifier)\b/i.test(text)) updates.productCategory = "Air Purifier";
    else if (/\b(dashcam|dash\s*cam|dashplay)\b/i.test(text)) updates.productCategory = "Dashcam";
    else if (/\b(tracker|gps)\b/i.test(text)) updates.productCategory = "GPS Tracker";
  }
  if (/\bdecommissioned\b/i.test(text)) updates.appConnectionStatus = "decommissioned";
  else if (/\bcommissioned\b/i.test(text)) updates.appConnectionStatus = "commissioned";
  if (/\boffline\b/i.test(text)) updates.signalStatus = "offline";
  else if (/\bonline\b/i.test(text)) updates.signalStatus = "online";

  return updates;
}

interface KBPromptArticle extends KBArticle {
  injectedContent: string;
  chunkNote: string;
}

interface KBChunk {
  articleId: number;
  index: number;
  startLine: number;
  content: string;
  score: number;
}

function scoreTokens(text: string): string[] {
  const stopWords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "has",
    "are", "you", "your", "then", "than", "into", "onto", "will", "can",
    "device", "qubo", "step", "check", "please",
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(token => token.length > 2 && !stopWords.has(token));
}

function splitKBContent(articleId: number, content: string): KBChunk[] {
  if (content.length <= KB_FULL_DOC_CHAR_LIMIT) {
    return [{ articleId, index: 0, startLine: 1, content, score: 0 }];
  }

  const chunks: KBChunk[] = [];
  const lines = content.split(/\r?\n/);
  let buffer: string[] = [];
  let bufferStartLine = 1;

  const pushBuffer = () => {
    const chunkText = buffer.join("\n").trim();
    if (!chunkText) return;

    if (chunkText.length <= KB_CHUNK_CHAR_LIMIT) {
      chunks.push({ articleId, index: chunks.length, startLine: bufferStartLine, content: chunkText, score: 0 });
      buffer = [];
      return;
    }

    for (let offset = 0; offset < chunkText.length; offset += KB_CHUNK_CHAR_LIMIT) {
      chunks.push({
        articleId,
        index: chunks.length,
        startLine: bufferStartLine,
        content: chunkText.slice(offset, offset + KB_CHUNK_CHAR_LIMIT).trim(),
        score: 0,
      });
    }
    buffer = [];
  };

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    const isBoundary = /^(\d+\.|step\s+\d+|#{1,6}\s+|[-*]\s+step\s+\d+)/i.test(trimmed);
    const nextLength = buffer.join("\n").length + line.length + 1;

    if (buffer.length > 0 && (nextLength > KB_CHUNK_CHAR_LIMIT || (isBoundary && nextLength > KB_CHUNK_CHAR_LIMIT * 0.45))) {
      pushBuffer();
      bufferStartLine = lineIndex + 1;
    }

    if (buffer.length === 0) bufferStartLine = lineIndex + 1;
    buffer.push(line);
  });

  pushBuffer();
  return chunks;
}

function scoreKBChunk(chunk: KBChunk, query: string, sessionState: Partial<FullSessionState>): number {
  const queryTokens = new Set(scoreTokens([
    query,
    sessionState.issue,
    sessionState.productCategory,
    sessionState.modelNumber,
    sessionState.deviceStatus,
    sessionState.commissioningStatus,
    sessionState.softwareVersion,
    ...(sessionState.disabledFeatures ?? []),
  ].filter(Boolean).join(" ")));

  if (queryTokens.size === 0) return 0;

  const chunkTokens = scoreTokens(chunk.content);
  let score = 0;
  for (const token of chunkTokens) {
    if (queryTokens.has(token)) score += 1;
  }

  const expectedStep = (sessionState.currentKbStepIndex ?? 0) + 1;
  if (sessionState.currentStage === "diagnose_troubleshoot") {
    const stepPattern = new RegExp(`(^|\\n)\\s*(step\\s+${expectedStep}|${expectedStep}\\.)\\b`, "i");
    if (stepPattern.test(chunk.content)) score += 25;
    if (chunk.content.toLowerCase().includes("troubleshoot")) score += 3;
  }

  return score / Math.max(20, chunkTokens.length);
}

function buildChunkedKBArticles(
  articles: KBArticle[],
  query: string,
  sessionState: Partial<FullSessionState>,
): KBPromptArticle[] {
  let remainingBudget = KB_TOTAL_CHAR_BUDGET;

  return articles.map((article) => {
    if (remainingBudget <= 0) {
      return {
        ...article,
        injectedContent: "",
        chunkNote: "No content injected because KB prompt budget was exhausted.",
      };
    }

    if (article.content.length <= KB_FULL_DOC_CHAR_LIMIT) {
      const injectedContent = article.content.slice(0, remainingBudget);
      remainingBudget -= injectedContent.length;
      return {
        ...article,
        injectedContent,
        chunkNote: "Full article injected.",
      };
    }

    const chunks = splitKBContent(article.id, article.content)
      .map(chunk => ({ ...chunk, score: scoreKBChunk(chunk, query, sessionState) }));

    const selected = chunks
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, KB_CHUNKS_PER_ARTICLE)
      .sort((a, b) => a.index - b.index);

    const injectedParts: string[] = [];
    for (const chunk of selected) {
      if (remainingBudget <= 0) break;
      const available = Math.min(remainingBudget, KB_CHUNK_CHAR_LIMIT);
      const content = chunk.content.slice(0, available);
      injectedParts.push(`[Chunk ${chunk.index + 1}, starts near line ${chunk.startLine}]\n${content}`);
      remainingBudget -= content.length;
    }

    return {
      ...article,
      injectedContent: injectedParts.join("\n\n"),
      chunkNote: `Chunked article: injected ${injectedParts.length} of ${chunks.length} chunks.`,
    };
  }).filter(article => article.injectedContent.trim().length > 0);
}

function rerankKBArticlesForState(
  articles: KBArticle[],
  sessionState: Partial<FullSessionState>,
): KBArticle[] {
  const product = sessionState.productCategory?.toLowerCase() ?? "";
  const model = sessionState.modelNumber?.toLowerCase() ?? "";

  return articles
    .map(article => {
      const title = article.title.toLowerCase();
      const content = article.content.toLowerCase();
      const text = `${title}\n${content}`;
      let boost = 0;

      if (product && text.includes(product)) boost += 0.08;
      if (model && text.includes(model)) boost += 0.12;

      return { ...article, score: article.score + boost };
    })
    .sort((a, b) => b.score - a.score);
}

function sanitizeStateUpdates(
  currentState: ConversationState | undefined,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  const allowedKeys = new Set([
    "issue", "productCategory", "modelNumber", "srNumber", "accountEmail",
    "kbOnlyMode", "appConnectionStatus", "signalStatus", "firmwareVersion",
    "firmwareStatus", "featuresDisabled", "troubleshootingIndex", "currentStage",
  ]);

  for (const [key, value] of Object.entries(updates)) {
    if (allowedKeys.has(key)) clean[key] = value;
  }

  if (typeof clean.issue !== "string" && clean.issue !== null) delete clean.issue;
  if (typeof clean.productCategory !== "string" && clean.productCategory !== null) delete clean.productCategory;
  if (typeof clean.modelNumber !== "string" && clean.modelNumber !== null) delete clean.modelNumber;
  if (typeof clean.srNumber !== "string" && clean.srNumber !== null) delete clean.srNumber;
  if (typeof clean.accountEmail !== "string" && clean.accountEmail !== null) delete clean.accountEmail;
  if (typeof clean.kbOnlyMode !== "boolean") delete clean.kbOnlyMode;
  if (!["commissioned", "decommissioned", null].includes(clean.appConnectionStatus as any)) delete clean.appConnectionStatus;
  if (!["online", "offline", null].includes(clean.signalStatus as any)) delete clean.signalStatus;
  if (typeof clean.firmwareVersion !== "string" && clean.firmwareVersion !== null) delete clean.firmwareVersion;
  if (!["ok", "outdated", "unknown", null].includes(clean.firmwareStatus as any)) delete clean.firmwareStatus;
  if (!Array.isArray(clean.featuresDisabled)) delete clean.featuresDisabled;
  if (typeof clean.troubleshootingIndex !== "number") delete clean.troubleshootingIndex;

  for (const key of ["issue", "productCategory", "modelNumber", "srNumber", "accountEmail", "firmwareVersion"]) {
    if (typeof clean[key] === "string" && clean[key].trim().length === 0) {
      delete clean[key];
    }
  }

  const currentStage = normalizeStage(currentState?.currentStage);
  const requestedStage = clean.currentStage ? normalizeStage(String(clean.currentStage)) : currentStage;
  const currentIndex = stageOrder.indexOf(currentStage);
  const requestedIndex = stageOrder.indexOf(requestedStage);
  const nextStage = stageOrder[Math.min(currentIndex + 1, stageOrder.length - 1)];
  const hasIssue = typeof clean.issue === "string" || !!currentState?.issue;
  const kbOnlyMode = clean.kbOnlyMode === true || currentState?.kbOnlyMode === true;
  const canSkipToDiagnose =
    kbOnlyMode ||
    (currentStage === "commissioning_check" && clean.appConnectionStatus === "decommissioned");

  if (requestedIndex < currentIndex) {
    delete clean.currentStage;
  } else if (requestedStage === currentStage) {
    clean.currentStage = requestedStage;
  } else if (kbOnlyMode && requestedStage === "kb_match") {
    clean.currentStage = requestedStage;
  } else if (canSkipToDiagnose && requestedStage === "diagnose_troubleshoot") {
    clean.currentStage = requestedStage;
  } else if (currentStage === "issue_extraction" && requestedStage === "identifier_collection" && !hasIssue) {
    clean.currentStage = currentStage;
  } else if (requestedStage === nextStage) {
    clean.currentStage = requestedStage;
  } else {
    clean.currentStage = nextStage;
  }

  if (kbOnlyMode && ["commissioning_check", "device_settings_collection"].includes(clean.currentStage as string)) {
    clean.currentStage = "diagnose_troubleshoot";
  }

  return clean;
}

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

/** Embed a KB article — delegates to kbSearch.ts (non-fatal on failure) */
async function embedKB(id: number, title: string, content: string): Promise<void> {
  try {
    await embedKBArticle(id, title, content);
    await indexKBArticleChunks(id, content);
  } catch (err: any) {
    console.warn("[embedKB] Embedding failed (non-fatal):", err.message);
  }
}

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), "server/system-prompt.md");
/** Always reads from disk so a file change + reset takes effect without restarting the server */
export function getDefaultSystemPrompt(): string {
  return readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
}
/** Cached at startup — used as the ultimate fallback if disk read fails */
export const DEFAULT_SYSTEM_PROMPT = getDefaultSystemPrompt();

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
  activeStagePrompt: string,
  canAdvanceTroubleshootingIndex = false,
): Promise<void> {
  try {
    const stateSnapshot = JSON.stringify({
      currentStage: currentState?.currentStage ?? "issue_extraction",
      kbOnlyMode: currentState?.kbOnlyMode ?? false,
      issue: currentState?.issue ?? null,
      productCategory: currentState?.productCategory ?? null,
      modelNumber: currentState?.modelNumber ?? null,
      srNumber: currentState?.srNumber ?? null,
      accountEmail: currentState?.accountEmail ?? null,
      // appConnectionStatus stores commissioning status in DB
      appConnectionStatus: currentState?.appConnectionStatus ?? null,
      // signalStatus stores device online/offline status in DB
      signalStatus: currentState?.signalStatus ?? null,
      // firmwareVersion stores software version string in DB
      firmwareVersion: currentState?.firmwareVersion ?? null,
      firmwareStatus: currentState?.firmwareStatus ?? null,
      featuresDisabled: currentState?.featuresDisabled ?? [],
      troubleshootingIndex: currentState?.troubleshootingIndex ?? 0,
    });

    const extraction = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions: `You extract conversation state updates from a Hero Electronix support chat exchange.

The ACTIVE PROMPT supplied in the input is the sole authority for stage requirements and exceptions. Do not impose an identifier requirement or exception that is not present in that prompt.

Given the active prompt, current state, the agent's message, and the assistant's response, return ONLY a JSON object with fields that changed or were newly extracted. Omit unchanged fields.

Valid field names and types:
- issue: string | null  (the customer's problem description)
- productCategory: string | null  (e.g. "Camera", "Router")
- modelNumber: string | null  (e.g. "HCP06", "Q1")
- srNumber: string | null  (Zoho SR number)
- accountEmail: string | null
- kbOnlyMode: boolean  (set according to the active prompt's routing rules)
- appConnectionStatus: "commissioned" | "decommissioned" | null  (device commissioning status from Zoho CRM)
- signalStatus: "online" | "offline" | null  (device online/offline status)
- firmwareVersion: string | null  (software version string, e.g. "HCP06_01_01_93_SYSTEM")
- firmwareStatus: "ok" | "outdated" | "unknown" | null
- featuresDisabled: string[]  (list of disabled features from Device Settings)
- troubleshootingIndex: integer  (increment by 1 each time a KB troubleshooting step is completed)
- currentStage: one of the following stage identifiers:
    "issue_extraction"         → bot has not yet understood the issue
    "identifier_collection"    → bot understood the issue, now applying the active prompt's identifier rules
    "commissioning_check"      → bot has SR/email, now checking whether the device is commissioned
    "kb_match"                 → commissioned, now selecting a relevant KB article
    "device_settings_collection" → KB matched, now collecting only settings required by its steps
    "diagnose_troubleshoot"    → settings collected or unnecessary, now in diagnostic briefing + KB steps
    "close"                    → issue resolved, session closing

Rules:
- Advance currentStage only when the assistant has explicitly completed that stage's goal.
- Apply identifier requirements, exceptions, and routing exactly as written in the ACTIVE PROMPT.
- If the ACTIVE PROMPT says the issue does not require an identifier, mark the identifier stage complete and apply any routing or kbOnlyMode instruction stated there.
- If kbOnlyMode becomes true, set currentStage to "kb_match" first so the assistant can ask one clarifying question using retrieved SOP candidates.
- If kbOnlyMode is already true and currentStage is "kb_match", move to "diagnose_troubleshoot" only after the agent answers the clarifying question.
- If kbOnlyMode is already true, never set currentStage to commissioning_check or device_settings_collection.
- Never go backwards.
- If unsure whether a stage is complete, keep the current stage.

Return {} if nothing changed. Return ONLY valid JSON, no markdown, no explanation.`,
      input: `ACTIVE PROMPT:\n${activeStagePrompt}\n\nCurrent state:\n${stateSnapshot}\n\nAgent message:\n${userMessage}\n\nAssistant response:\n${assistantResponse}\n\nReturn JSON with only changed/new fields:`,
      temperature: 0,
      text: {
        format: {
          type: "json_schema",
          name: "conversation_state_updates",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              issue: { type: ["string", "null"] },
              productCategory: { type: ["string", "null"] },
              modelNumber: { type: ["string", "null"] },
              srNumber: { type: ["string", "null"] },
              accountEmail: { type: ["string", "null"] },
              kbOnlyMode: { type: ["boolean", "null"] },
              appConnectionStatus: { type: ["string", "null"], enum: ["commissioned", "decommissioned", null] },
              signalStatus: { type: ["string", "null"], enum: ["online", "offline", null] },
              firmwareVersion: { type: ["string", "null"] },
              firmwareStatus: { type: ["string", "null"], enum: ["ok", "outdated", "unknown", null] },
              featuresDisabled: { type: ["array", "null"], items: { type: "string" } },
              troubleshootingIndex: { type: ["integer", "null"] },
              currentStage: {
                type: ["string", "null"],
                enum: ["issue_extraction", "identifier_collection", "commissioning_check", "kb_match", "device_settings_collection", "diagnose_troubleshoot", "close", null],
              },
            },
            required: [
              "issue", "productCategory", "modelNumber", "srNumber", "accountEmail",
              "kbOnlyMode", "appConnectionStatus", "signalStatus", "firmwareVersion",
              "firmwareStatus", "featuresDisabled", "troubleshootingIndex", "currentStage",
            ],
          },
        },
      } as any,
      max_output_tokens: 400,
      store: false,
    });

    const raw = (extractResponseText(extraction) || "{}").trim()
      .replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    const parsed = JSON.parse(raw);
    const updates = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value !== null),
    );
    if (updates && typeof updates === "object" && Object.keys(updates).length > 0) {
      const safeUpdates = sanitizeStateUpdates(currentState, updates);
      if ("troubleshootingIndex" in safeUpdates && (!canAdvanceTroubleshootingIndex || !isNegativeConfirmation(userMessage))) {
        delete safeUpdates.troubleshootingIndex;
      }
      if (Object.keys(safeUpdates).length === 0) return;
      await chatStorage.upsertConversationState(conversationId, safeUpdates);
      console.log(`[state] conv ${conversationId} updated:`, JSON.stringify(safeUpdates));
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
      const id = parseInt(req.params.id as string);
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
      const id = parseInt(req.params.id as string);
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
      const freshPrompt = getDefaultSystemPrompt();
      await chatStorage.setSetting("system_prompt", freshPrompt);
      await chatStorage.setSetting("system_prompt_updated_at", new Date().toISOString());
      res.json({ ok: true, systemPrompt: freshPrompt });
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
      const id = parseInt(req.params.id as string);
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
      const id = parseInt(req.params.id as string);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  // Reset a stuck session back to issue_extraction without losing message history
  app.delete("/api/conversations/:id/state", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
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
          const extracted = await extractDocumentText(buffer, originalname, mimetype, 40000);
          attachment.extractedText = extracted.text;
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
      } catch (error: any) {
        console.error("Attachment upload error:", error);
        res.status(422).json({ error: error?.message ?? "Failed to extract readable text from attachment" });
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
      const title = `OneDrive: ${originalname}`;
      const extracted = await extractDocumentText(buffer, originalname, mimetype, 50000);
      const content = extracted.text;

      let productCategories: string[] = [];
      let modelNumbers: string[] = [];
      try {
        if (req.body.productCategories) productCategories = JSON.parse(req.body.productCategories);
        if (req.body.modelNumbers) modelNumbers = JSON.parse(req.body.modelNumbers);
      } catch {}

      const kb = await chatStorage.createKB({ title, content: content.trim(), type: "onedrive", productCategories, modelNumbers });
      embedKB(kb.id, kb.title, kb.content); // async, fire-and-forget
      res.status(201).json({
        ...kb,
        extraction: {
          method: extracted.method,
          originalLength: extracted.originalLength,
          truncated: extracted.truncated,
        },
      });
    } catch (error: any) {
      console.error("File upload error:", error);
      res.status(422).json({ error: error?.message ?? "Failed to extract readable text from file" });
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
      const id = parseInt(req.params.id as string);
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

  // ── Sync all KB entries from the stored SharePoint master link ──
  app.post("/api/kb/sync-sharepoint", async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const masterLink = await chatStorage.getSetting("sharepoint_master_link");
    if (!masterLink) return res.status(400).json({ error: "No SharePoint master link configured. Save one first." });
    const defaultProductCategories = normalizeStringArray(req.body?.productCategories);
    const defaultModelNumbers = normalizeStringArray(req.body?.modelNumbers);

    try {
      const files = await listSharedFolder(masterLink);
      const allKBs = await chatStorage.getAllKB();

      // Only consider SharePoint-sourced KB entries for removal
      const spKBs = allKBs.filter(kb => /^OneDrive:\s*/i.test(kb.title));
      const kbByFilename = new Map<string, typeof allKBs[0]>();
      for (const kb of spKBs) {
        const name = kb.title.replace(/^OneDrive:\s*/i, "").trim().toLowerCase();
        kbByFilename.set(name, kb);
      }

      // Build set of SharePoint filenames for removal detection
      const spFilenames = new Set(files.map(f => f.name.toLowerCase()));

      const results = { updated: 0, added: 0, removed: 0, addedFiles: [] as string[], removedFiles: [] as string[], errors: [] as string[] };

      // 1. Update existing + add new
      for (const file of files) {
        const normalised = file.name.toLowerCase();
        const existing = kbByFilename.get(normalised);
        try {
          const newContent = await extractSharedFileContent(file);
          if (!newContent.trim()) { results.errors.push(`${file.name}: empty content`); continue; }

          if (existing) {
            const metadataPatch = {
              ...(existing.productCategories.length === 0 && defaultProductCategories.length > 0
                ? { productCategories: defaultProductCategories }
                : {}),
              ...(existing.modelNumbers.length === 0 && defaultModelNumbers.length > 0
                ? { modelNumbers: defaultModelNumbers }
                : {}),
            };
            const updated = await chatStorage.updateKB(existing.id, { content: newContent.trim(), ...metadataPatch });
            embedKB(existing.id, updated.title, updated.content);
            results.updated++;
          } else {
            const kb = await chatStorage.createKB({
              title: `OneDrive: ${file.name}`,
              content: newContent.trim(),
              type: "onedrive",
              productCategories: defaultProductCategories,
              modelNumbers: defaultModelNumbers,
              sourceUrl: masterLink,
            });
            embedKB(kb.id, kb.title, kb.content);
            results.addedFiles.push(file.name);
            results.added++;
          }
        } catch (err: any) {
          results.errors.push(`${file.name}: ${err.message}`);
        }
      }

      // 2. Remove KB entries whose files no longer exist in SharePoint
      for (const [filename, kb] of Array.from(kbByFilename.entries())) {
        if (!spFilenames.has(filename)) {
          try {
            await chatStorage.deleteKB(kb.id);
            results.removedFiles.push(kb.title.replace(/^OneDrive:\s*/i, "").trim());
            results.removed++;
          } catch (err: any) {
            results.errors.push(`Delete ${kb.title}: ${err.message}`);
          }
        }
      }

      res.json({ ok: true, ...results, total: files.length });
    } catch (err: any) {
      const isExpired = err.message?.toLowerCase().includes("expired") || err.message?.toLowerCase().includes("fedauth");
      res.status(isExpired ? 503 : 500).json({
        error: err.message,
        code: isExpired ? "sharepoint_expired" : "sync_failed",
      });
    }
  });

  app.delete("/api/kb/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      await chatStorage.deleteKB(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete KB" });
    }
  });

  // Refresh a KB entry from its original OneDrive source URL
  app.post("/api/kb/:id/refresh", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
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
      const isExpired = err.message?.toLowerCase().includes("session expired") ||
                        err.message?.toLowerCase().includes("fedauth") ||
                        err.message?.toLowerCase().includes("expired");
      const status = isExpired ? 503 : 500;
      res.status(status).json({
        error: err.message,
        code: isExpired ? "sharepoint_expired" : "refresh_failed",
      });
    }
  });

  // ── SharePoint master link settings ──────────────────────────
  app.get("/api/settings/sharepoint-master-link", async (req: Request, res: Response) => {
    const link = await chatStorage.getSetting("sharepoint_master_link");
    const productCategories = JSON.parse(await chatStorage.getSetting("sharepoint_master_product_categories") ?? "[]");
    const modelNumbers = JSON.parse(await chatStorage.getSetting("sharepoint_master_model_numbers") ?? "[]");
    res.json({ link: link ?? "", productCategories, modelNumbers });
  });

  app.put("/api/settings/sharepoint-master-link", async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;
    const { link } = req.body;
    if (!link || typeof link !== "string") return res.status(400).json({ error: "link required" });
    await chatStorage.setSetting("sharepoint_master_link", link.trim());
    const productCategories = normalizeStringArray(req.body?.productCategories);
    const modelNumbers = normalizeStringArray(req.body?.modelNumbers);
    await chatStorage.setSetting("sharepoint_master_product_categories", JSON.stringify(productCategories));
    await chatStorage.setSetting("sharepoint_master_model_numbers", JSON.stringify(modelNumbers));
    res.json({ ok: true, link: link.trim(), productCategories, modelNumbers });
  });

  // ══════════════════════════════════════════════════
  // CHAT (SSE streaming)
  // ══════════════════════════════════════════════════

  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id as string);
      const { content, attachmentIds } = req.body;

      if (!hasOpenAIKey()) {
        return res.status(503).json({
          error: "OpenAI API key is not configured. Add OPENAI_API_KEY to .env and restart the server.",
          code: "openai_key_missing",
        });
      }

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
      const deterministicUpdates = sanitizeStateUpdates(state, extractDeterministicStateFromMessage(state, userDisplayContent));
      const effectiveState = { ...(state ?? {}), ...deterministicUpdates } as ConversationState;
      if (Object.keys(deterministicUpdates).length > 0) {
        await chatStorage.upsertConversationState(conversationId, deterministicUpdates as any);
      }
      const normalizedStage = normalizeStage(effectiveState.currentStage);
      const kbOnlyMode = effectiveState.kbOnlyMode ?? false;
      const inKBStage = isKBActiveStage(normalizedStage, kbOnlyMode);

      // 2. Device-state-aware hybrid KB search — marries SR/device data to KB articles
      let topArticles: Awaited<ReturnType<typeof hybridSearchKB>> = [];
      let kbSearchQuery = content || attachments.map(a => a.filename).join(" ");
      if (inKBStage) {
        const stateForSearch: Partial<FullSessionState> = {
          modelNumber: effectiveState.modelNumber ?? null,
          productCategory: effectiveState.productCategory ?? null,
          issue: effectiveState.issue ?? null,
          deviceStatus: (effectiveState.signalStatus as any) ?? null,
          commissioningStatus: (effectiveState.appConnectionStatus as any) ?? null,
          firmwareOutdated: effectiveState.firmwareStatus === "outdated" ? true : effectiveState.firmwareStatus === "ok" ? false : null,
          signalWeak: (effectiveState as any)?.signalWeak ?? null,
          disabledFeatures: effectiveState.featuresDisabled ?? [],
        };
        kbSearchQuery = buildKBQuery(stateForSearch, kbSearchQuery);
        const searchResults = await hybridSearchKB(kbSearchQuery, { limit: KB_RESULT_LIMIT });
        topArticles = rerankKBArticlesForState(searchResults, stateForSearch)
          .filter(article => Number.isFinite(article.score) && article.score >= MIN_KB_RELEVANCE_SCORE);
      }
      const kbArticlesFound = topArticles.length > 0;
      const kbStepTotal = kbArticlesFound
        ? (topArticles[0].content.match(/^\s*(\d+\.|step\s+\d+)/gim) ?? []).length
        : 0;

      const messages = await chatStorage.getMessagesByConversation(conversationId);

      // Auto-name conversation from first user message
      if (messages.length === 1 && messages[0].role === "user") {
        const raw = (content || attachments.map(a => a.filename).join(", ") || "").trim();
        if (raw) {
          const words = raw.replace(/\s+/g, " ").split(" ");
          let title = "";
          for (const w of words) {
            if ((title + " " + w).trim().length > 48) break;
            title = (title + " " + w).trim();
          }
          if (title.length < raw.length) title += "…";
          const conv = await chatStorage.getConversation(conversationId);
          if (conv && ["New Support Session", "New Chat"].includes(conv.title)) {
            await chatStorage.updateConversationTitle(conversationId, title.charAt(0).toUpperCase() + title.slice(1));
          }
        }
      }

      // Build chat messages — use multimodal content for the last user message if attachments exist
      let chatMessages: Array<{ role: "user" | "assistant" | "system"; content: any }> = messages.map((m, idx) => {
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
      const basePrompt = buildStageScopedPrompt(savedPrompt ?? DEFAULT_SYSTEM_PROMPT, normalizedStage);

      // Normalize old stage names → new stage names so the prompt always sees consistent values
      const sessionState = {
        currentStage: normalizedStage,
        kbOnlyMode,
        issue: effectiveState.issue ?? null,
        productCategory: effectiveState.productCategory ?? null,
        srNumber: effectiveState.srNumber ?? null,
        accountEmail: effectiveState.accountEmail ?? null,
        deviceStatus: effectiveState.signalStatus ?? null,
        commissioningStatus: effectiveState.appConnectionStatus ?? null,
        softwareVersion: effectiveState.firmwareVersion ?? null,
        lastOtaDate: (effectiveState as any)?.lastOtaDate ?? null,
        rssi: (effectiveState as any)?.rssi ?? null,
        disabledFeatures: effectiveState.featuresDisabled ?? [],
        modelNumber: effectiveState.modelNumber ?? null,
        firmwareOutdated: effectiveState.firmwareStatus === "outdated" ? true : effectiveState.firmwareStatus === "ok" ? false : null,
        signalWeak: (effectiveState as any)?.signalWeak ?? null,
        kbDocTitle: (effectiveState as any)?.kbDocTitle ?? null,
        kbDocLink: (effectiveState as any)?.kbDocLink ?? null,
        kbArticlesFound,
        kbStepTotal,
        currentKbStepIndex: effectiveState.troubleshootingIndex ?? 0,
        diagnosisBriefingDone: (effectiveState.troubleshootingIndex ?? 0) > 0,
      };
      const promptArticles = kbArticlesFound
        ? buildChunkedKBArticles(topArticles, kbSearchQuery, sessionState as Partial<FullSessionState>)
        : [];

      // Stage-gated KB injection — load KB once device data has arrived (Stage 3+)
      // device_context_collection included: commissioning/firmware checks need KB immediately after device data
      let kbSection: string;
      if (!inKBStage) {
        kbSection = `\n\n[KB articles are not loaded yet. Do NOT guess or provide troubleshooting steps. Follow your stage instructions first.]`;
      } else if (!kbArticlesFound || promptArticles.length === 0) {
        kbSection = `\n\nKNOWLEDGE BASE: No sufficiently relevant articles found for this query.\n(kbArticlesFound = false — do not guess or improvise troubleshooting. Ask for one useful clarifying detail and retry retrieval.)`;
      } else {
        kbSection = [
          `\n\nRETRIEVED KB ARTICLES — FOLLOW THESE EXACTLY IN ORDER`,
          `Do not use any knowledge outside these articles for troubleshooting steps.`,
          `Long articles may be chunked. Use only the injected article text; never invent missing steps.`,
          `Total articles retrieved: ${promptArticles.length}\n`,
          ...promptArticles.map((art, i) =>
            `--- KB ARTICLE ${i + 1} OF ${promptArticles.length} ---\n` +
            `Title: ${art.title}${art.sourceUrl ? `\nSource: ${art.sourceUrl}` : ""}\n` +
            `Injection: ${art.chunkNote}\n` +
            art.injectedContent
          ),
        ].join("\n");
      }

      // Stage-gated state serialization — only sends fields relevant to current stage (~30% token saving)
      const systemPromptWithState = [
        basePrompt,
        RESPONSE_STYLE_GUARD,
        `CURRENT SESSION STATE:\n${serializeSessionState(sessionState as Partial<FullSessionState>)}`,
        normalizedStage === "kb_match"
          ? `KB MATCH CLARIFICATION RULE:\nYou are narrowing down to the right SOP. Ask one focused clarifying question per reply — up to 3 questions total across this conversation — until you are confident which SOP fits. Do not include action verbs such as "check", "try", "restart", "open", or "go to" in the question. Do not give a root cause, diagnostic briefing, or troubleshooting step until you have picked the SOP. Once you are confident, move directly into the solution — no need to announce which SOP you chose. Match the agent's language and script.`
          : "",
        kbSection,
      ].filter(Boolean).join("\n\n");

      // Trim history to cap token growth on long sessions (keeps last 6 turns verbatim)
      chatMessages = trimConversationHistory(chatMessages as any) as typeof chatMessages;
      const responseInput = toResponsesInput(chatMessages as any);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream: any = await openai.responses.create({
        model: "gpt-4o-mini",
        instructions: systemPromptWithState,
        input: responseInput,
        stream: true,
        temperature: 0.4,
        max_output_tokens: stageTokenCap(normalizedStage, kbOnlyMode),
        prompt_cache_key: PROMPT_CACHE_KEY,
        prompt_cache_retention: "in_memory",
        store: false,
        truncation: "auto",
      } as any);

      let fullResponse = "";
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const event of stream) {
        if (event.type === "response.output_text.delta" && event.delta) {
          fullResponse += event.delta;
          res.write(`data: ${JSON.stringify({ content: event.delta })}\n\n`);
        } else if (event.type === "response.completed") {
          const usage = event.response?.usage;
          promptTokens = usage?.input_tokens ?? 0;
          completionTokens = usage?.output_tokens ?? 0;
        } else if (event.type === "response.failed") {
          throw new Error(event.response?.error?.message ?? "Responses API request failed");
        } else if (event.type === "error") {
          throw new Error(event.message ?? "Responses API stream error");
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
      extractAndSaveState(
        conversationId,
        effectiveState,
        content,
        fullResponse,
        basePrompt,
        normalizeStage(state?.currentStage) === "diagnose_troubleshoot",
      ).catch(() => {});

      // 5. Server-side KB step index increment — reliable counter independent of state extractor
      // Fires whenever the session was already in diagnose_troubleshoot at the START of this request
      if (normalizeStage(state?.currentStage) === "diagnose_troubleshoot") {
        const reply = String(content ?? "");
        if (isResolvedConfirmation(reply)) {
          chatStorage.upsertConversationState(conversationId, { currentStage: "close" }).catch(() => {});
        } else if (isNegativeConfirmation(reply)) {
          chatStorage.upsertConversationState(conversationId, {
            troubleshootingIndex: (effectiveState.troubleshootingIndex ?? 0) + 1,
          }).catch(() => {});
        }
      }

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

  // ── Backfill endpoint — generate embeddings for all KB articles missing one ──
  app.post("/api/kb/backfill", async (req: Request, res: Response) => {
    try {
      console.log("[backfill] Starting KB embedding backfill...");
      const result = await backfillEmbeddings();
      console.log(`[backfill] Done. Processed: ${result.processed}, Errors: ${result.errors}`);
      res.json({
        success: true,
        processed: result.processed,
        errors: result.errors,
        message: `Embedded ${result.processed} articles. ${result.errors} errors.`,
      });
    } catch (err) {
      console.error("[backfill] Fatal error:", err);
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── Startup: auto-embed any KB entries that are missing embeddings ────────
  // Probes one article first — if the embedding endpoint is unavailable, skips all to avoid log spam.
  (async () => {
    try {
      await new Promise(r => setTimeout(r, 3000)); // wait for server to settle
      const unindexed = await chatStorage.getKBsWithoutEmbedding();
      if (unindexed.length === 0) return;
      console.log(`[embed] Auto-indexing ${unindexed.length} KB entries without embeddings...`);
      // Probe with first article — bail out early if embeddings are unsupported
      try {
        await embedKBArticle(unindexed[0].id, unindexed[0].title, unindexed[0].content);
      } catch (probeErr: any) {
        console.log(`[embed] Embedding endpoint not available (${probeErr.message?.slice(0, 60)}). Skipping auto-index. Chat will use keyword search.`);
        return;
      }
      for (const kb of unindexed.slice(1)) {
        await embedKB(kb.id, kb.title, kb.content);
      }
      console.log(`[embed] Auto-indexing complete.`);
    } catch (e: any) {
      console.error("[embed] Auto-index error:", e.message);
    }
  })();
}
