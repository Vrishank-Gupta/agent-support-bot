/**
 * kbSearch.ts
 * Hybrid KB search: semantic (pgvector) + keyword (BM25/ts_rank), merged and deduplicated.
 * Falls back to keyword-only if pgvector is not set up or embeddings are missing.
 */

import OpenAI from "openai";
import { db } from "../../db";
import { sql } from "drizzle-orm";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function embedQuery(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
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

export async function searchKB(
  query: string,
  options: SearchOptions = {}
): Promise<KBArticle[]> {
  const limit = options.limit ?? 3;
  const semanticWeight = options.semanticWeight ?? 0.7;
  const keywordWeight = 1 - semanticWeight;

  // ── Semantic search ──────────────────────────────────────────
  let semanticResults: KBArticle[] = [];
  try {
    const queryEmbedding = await embedQuery(query);
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;

    const rows = await db.execute(sql`
      SELECT
        id,
        title,
        content,
        category,
        source_url,
        1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM knowledge_base
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit * 2}
    `);

    semanticResults = (rows.rows as any[]).map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category ?? null,
      sourceUrl: r.source_url ?? null,
      score: parseFloat(r.similarity) * semanticWeight,
    }));
  } catch (err) {
    console.warn("[kbSearch] Semantic search unavailable, using keyword only:", (err as any)?.message);
  }

  // ── Keyword search (PostgreSQL ts_rank) ─────────────────────
  const keywordResults: KBArticle[] = [];
  try {
    const rows = await db.execute(sql`
      SELECT
        id,
        title,
        content,
        category,
        source_url,
        ts_rank(
          to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')),
          plainto_tsquery('english', ${query})
        ) AS rank
      FROM knowledge_base
      WHERE
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
        @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit * 2}
    `);

    for (const r of rows.rows as any[]) {
      keywordResults.push({
        id: r.id,
        title: r.title,
        content: r.content,
        category: r.category ?? null,
        sourceUrl: r.source_url ?? null,
        score: parseFloat(r.rank) * keywordWeight,
      });
    }
  } catch (err) {
    console.error("[kbSearch] Keyword search failed:", (err as any)?.message);
  }

  // ── Merge and deduplicate ────────────────────────────────────
  const merged = new Map<number, KBArticle>();

  for (const article of [...semanticResults, ...keywordResults]) {
    if (merged.has(article.id)) {
      merged.get(article.id)!.score += article.score;
    } else {
      merged.set(article.id, { ...article });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function embedKBArticle(
  articleId: number,
  title: string,
  content: string
): Promise<void> {
  const text = `${title}\n\n${content}`.slice(0, 8000);
  const embedding = await embedQuery(text);
  const vectorLiteral = `[${embedding.join(",")}]`;

  await db.execute(sql`
    UPDATE knowledge_base
    SET embedding = ${vectorLiteral}::vector
    WHERE id = ${articleId}
  `);
}

export async function backfillEmbeddings(): Promise<{ processed: number; errors: number }> {
  const rows = await db.execute(sql`
    SELECT id, title, content FROM knowledge_base WHERE embedding IS NULL
  `);

  let processed = 0;
  let errors = 0;

  for (const row of rows.rows as any[]) {
    try {
      await embedKBArticle(row.id, row.title, row.content);
      processed++;
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[backfill] Failed for article ${row.id}:`, (err as any)?.message);
      errors++;
    }
  }

  return { processed, errors };
}
