CREATE TABLE IF NOT EXISTS "knowledge_base_chunks" (
  "id" serial PRIMARY KEY NOT NULL,
  "knowledge_base_id" integer NOT NULL,
  "chunk_index" integer NOT NULL,
  "step_number" integer,
  "content" text NOT NULL,
  "embedding" real[],
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_base_chunks_knowledge_base_id_knowledge_base_id_fk"
    FOREIGN KEY ("knowledge_base_id")
    REFERENCES "public"."knowledge_base"("id")
    ON DELETE cascade
    ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "knowledge_base_chunks_kb_id_idx"
  ON "knowledge_base_chunks" ("knowledge_base_id");

CREATE INDEX IF NOT EXISTS "knowledge_base_chunks_step_idx"
  ON "knowledge_base_chunks" ("knowledge_base_id", "step_number");
