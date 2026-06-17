import OpenAI from "openai";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import type { FullSessionState } from "./sessionState";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "missing-openai-key",
  baseURL: process.env.OPENAI_API_KEY ? undefined : process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

function hasOpenAIKey(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
}

export interface KBArticle {
  id: number;
  title: string;
  content: string;
  category: string | null;
  sourceUrl: string | null;
  score: number;
}

interface SearchOptions {
  limit?: number;
  semanticWeight?: number;
}

const INDEX_CHUNK_CHAR_LIMIT = 2200;

export function buildKBQuery(
  state: Partial<FullSessionState>,
  userMessage: string,
): string {
  const parts: string[] = [];
  if (state.modelNumber) parts.push(state.modelNumber);
  if (state.productCategory) parts.push(state.productCategory);
  if (state.issue) parts.push(state.issue);
  if (state.deviceStatus) parts.push(state.deviceStatus);
  if (state.commissioningStatus) parts.push(state.commissioningStatus);
  if (state.firmwareOutdated === true) parts.push("firmware outdated");
  if (state.firmwareOutdated === false) parts.push("firmware current");
  if (state.signalWeak === true) parts.push("weak signal poor RSSI");
  if (state.disabledFeatures?.length) parts.push(...state.disabledFeatures);
  if (userMessage) parts.push(userMessage.slice(0, 120));
  return parts.filter(Boolean).join(" ");
}

async function embedQuery(text: string): Promise<number[]> {
  if (!hasOpenAIKey()) throw new Error("OpenAI API key is not configured");
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

function detectStepNumber(text: string): number | null {
  const match = text.match(/^\s*(?:step\s+)?(\d+)[.)]/im);
  return match ? Number.parseInt(match[1], 10) : null;
}

function splitContentForIndexing(content: string): Array<{ chunkIndex: number; stepNumber: number | null; content: string }> {
  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  let buffer: string[] = [];

  const push = () => {
    const text = buffer.join("\n").trim();
    if (text) chunks.push(text);
    buffer = [];
  };

  for (const line of lines) {
    const nextLength = buffer.join("\n").length + line.length + 1;
    const startsStep = /^\s*(?:step\s+)?\d+[.)]/i.test(line.trim());
    if (buffer.length > 0 && (nextLength > INDEX_CHUNK_CHAR_LIMIT || (startsStep && nextLength > INDEX_CHUNK_CHAR_LIMIT * 0.35))) {
      push();
    }
    buffer.push(line);
  }
  push();

  const sourceChunks = chunks.length > 0 ? chunks : [content.slice(0, INDEX_CHUNK_CHAR_LIMIT)];
  const finalChunks: Array<{ chunkIndex: number; stepNumber: number | null; content: string }> = [];
  for (const chunk of sourceChunks) {
    if (chunk.length <= INDEX_CHUNK_CHAR_LIMIT) {
      finalChunks.push({ chunkIndex: finalChunks.length, stepNumber: detectStepNumber(chunk), content: chunk });
      continue;
    }
    for (let offset = 0; offset < chunk.length; offset += INDEX_CHUNK_CHAR_LIMIT) {
      const contentPart = chunk.slice(offset, offset + INDEX_CHUNK_CHAR_LIMIT).trim();
      finalChunks.push({ chunkIndex: finalChunks.length, stepNumber: detectStepNumber(contentPart), content: contentPart });
    }
  }
  return finalChunks;
}

function mergeResults(results: KBArticle[], limit: number): KBArticle[] {
  const merged = new Map<string, KBArticle>();
  for (const article of results) {
    const key = `${article.id}:${article.content.slice(0, 120)}`;
    if (merged.has(key)) merged.get(key)!.score += article.score;
    else merged.set(key, { ...article });
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

function toPgRealArrayLiteral(values: number[]): any {
  return sql.raw(`ARRAY[${values.map((value) => Number.isFinite(value) ? value : 0).join(",")}]::real[]`);
}

function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === "string") {
    return value
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map(Number)
      .filter(Number.isFinite);
  }
  return [];
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function searchKB(query: string, options: SearchOptions = {}): Promise<KBArticle[]> {
  const limit = options.limit ?? 3;
  const semanticWeight = options.semanticWeight ?? 0.7;
  const keywordWeight = 1 - semanticWeight;
  const results: KBArticle[] = [];

  try {
    const queryEmbedding = await embedQuery(query);
    const rows = await db.execute(sql`
      SELECT kb.id, kb.title, chunk.content, kb.type as category, kb.source_url, chunk.embedding
      FROM knowledge_base_chunks chunk
      JOIN knowledge_base kb ON kb.id = chunk.knowledge_base_id
      WHERE chunk.embedding IS NOT NULL
    `);

    results.push(...(rows.rows as any[])
      .map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        category: r.category ?? null,
        sourceUrl: r.source_url ?? null,
        score: cosineSimilarity(queryEmbedding, parseEmbedding(r.embedding)) * semanticWeight,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 4));
  } catch (err) {
    console.warn("[kbSearch] Chunk semantic search unavailable:", (err as any)?.message);
  }

  try {
    const rows = await db.execute(sql`
      SELECT kb.id, kb.title, chunk.content, kb.type as category, kb.source_url,
        ts_rank(
          to_tsvector('english', coalesce(kb.title, '') || ' ' || coalesce(chunk.content, '')),
          plainto_tsquery('english', ${query})
        ) AS rank
      FROM knowledge_base_chunks chunk
      JOIN knowledge_base kb ON kb.id = chunk.knowledge_base_id
      WHERE to_tsvector('english', coalesce(kb.title, '') || ' ' || coalesce(chunk.content, ''))
        @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit * 4}
    `);

    results.push(...(rows.rows as any[]).map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category ?? null,
      sourceUrl: r.source_url ?? null,
      score: parseFloat(r.rank) * keywordWeight,
    })));
  } catch (err) {
    console.error("[kbSearch] Chunk keyword search failed:", (err as any)?.message);
  }

  const chunkResults = mergeResults(results, limit);
  return chunkResults.length > 0
    ? chunkResults
    : searchKBArticles(query, limit, semanticWeight, keywordWeight);
}

async function searchKBArticles(
  query: string,
  limit: number,
  semanticWeight: number,
  keywordWeight: number,
): Promise<KBArticle[]> {
  const results: KBArticle[] = [];
  try {
    const queryEmbedding = await embedQuery(query);
    const rows = await db.execute(sql`
      SELECT id, title, content, type as category, source_url, embedding
      FROM knowledge_base
      WHERE embedding IS NOT NULL
    `);
    results.push(...(rows.rows as any[])
      .map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        category: r.category ?? null,
        sourceUrl: r.source_url ?? null,
        score: cosineSimilarity(queryEmbedding, parseEmbedding(r.embedding)) * semanticWeight,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2));
  } catch {
    // Fall back to article keyword only.
  }

  try {
    const rows = await db.execute(sql`
      SELECT id, title, content, type as category, source_url,
        ts_rank(
          to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')),
          plainto_tsquery('english', ${query})
        ) AS rank
      FROM knowledge_base
      WHERE to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
        @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit * 2}
    `);
    results.push(...(rows.rows as any[]).map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category ?? null,
      sourceUrl: r.source_url ?? null,
      score: parseFloat(r.rank) * keywordWeight,
    })));
  } catch {
    // No-op.
  }

  const merged = new Map<number, KBArticle>();
  for (const article of results) {
    if (merged.has(article.id)) merged.get(article.id)!.score += article.score;
    else merged.set(article.id, { ...article });
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function embedKBArticle(articleId: number, title: string, content: string): Promise<void> {
  const embedding = await embedQuery(`${title}\n\n${content}`.slice(0, 8000));
  await db.execute(sql`
    UPDATE knowledge_base
    SET embedding = ${toPgRealArrayLiteral(embedding)}
    WHERE id = ${articleId}
  `);
}

export async function indexKBArticleChunks(articleId: number, content: string): Promise<void> {
  await db.execute(sql`DELETE FROM knowledge_base_chunks WHERE knowledge_base_id = ${articleId}`);
  for (const chunk of splitContentForIndexing(content)) {
    const embedding = await embedQuery(chunk.content);
    await db.execute(sql`
      INSERT INTO knowledge_base_chunks (knowledge_base_id, chunk_index, step_number, content, embedding)
      VALUES (${articleId}, ${chunk.chunkIndex}, ${chunk.stepNumber}, ${chunk.content}, ${toPgRealArrayLiteral(embedding)})
    `);
  }
}

export async function backfillEmbeddings(): Promise<{ processed: number; errors: number }> {
  const rows = await db.execute(sql`SELECT id, title, content FROM knowledge_base`);
  let processed = 0;
  let errors = 0;

  for (const row of rows.rows as any[]) {
    try {
      await embedKBArticle(row.id, row.title, row.content);
      await indexKBArticleChunks(row.id, row.content);
      processed++;
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[backfill] Failed for article ${row.id}:`, (err as any)?.message);
      errors++;
    }
  }

  return { processed, errors };
}
