import { Pool } from "pg";
import { env } from "../config/env";

// The real database for the conversation/question log -- everything else
// in this app is deliberately file-backed JSON, but a permanent,
// queryable record of every question asked and every answer given is
// exactly what a real database is for, not a flat file.
//
// Lazy-initialized and allowed to be ABSENT: local dev and anyone who
// hasn't set CHAT_LOG_DATABASE_URL yet should still be able to run the
// rest of the app (register, admin, chat) without a Postgres instance --
// only the logging feature no-ops (see conversationLogStore.ts).
let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function isChatLogEnabled(): boolean {
  return !!env.chatLogDatabaseUrl;
}

export function getPool(): Pool {
  if (!env.chatLogDatabaseUrl) {
    throw new Error("CHAT_LOG_DATABASE_URL is not set");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: env.chatLogDatabaseUrl,
      // Neon and most managed Postgres providers require TLS; this
      // accepts their (valid, provider-issued) certs without needing the
      // full CA bundle configured locally.
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    website_id TEXT NOT NULL,
    asker_type TEXT NOT NULL CHECK (asker_type IN ('guest', 'customer')),
    asker_id TEXT NOT NULL,
    message TEXT NOT NULL,
    answer TEXT NOT NULL,
    was_answered BOOLEAN NOT NULL,
    sources JSONB,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_logs_website_created
    ON conversation_logs (website_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversation_logs_unanswered
    ON conversation_logs (website_id, was_answered, resolved)
    WHERE was_answered = FALSE;
`;

// Called once at server startup. Safe to call even when the log is
// disabled (env var unset) -- just resolves immediately and every
// logging call becomes a no-op (see conversationLogStore.ts).
export async function ensureChatLogSchema(): Promise<void> {
  if (!isChatLogEnabled()) return;
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA_SQL)
      .then(() => {
        console.log("[chat-log] connected to Postgres, schema ready");
      })
      .catch((err) => {
        console.error("[chat-log] failed to set up schema -- conversation logging disabled:", err instanceof Error ? err.message : err);
        pool = null;
        schemaReady = null;
      });
  }
  return schemaReady;
}
