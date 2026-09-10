import { getPool, isChatLogEnabled } from "../db/postgres";
import { SourcesUsed } from "../engine/answerEngine";

export type AskerType = "guest" | "customer";

export interface ConversationLogEntry {
  id: string;
  websiteId: string;
  askerType: AskerType;
  askerId: string;
  message: string;
  answer: string;
  wasAnswered: boolean;
  sources: SourcesUsed | null;
  resolved: boolean;
  createdAt: string;
}

interface LogConversationInput {
  websiteId: string;
  askerType: AskerType;
  askerId: string;
  message: string;
  answer: string;
  wasAnswered: boolean;
  sources: SourcesUsed;
}

function rowToEntry(row: Record<string, unknown>): ConversationLogEntry {
  return {
    id: row.id as string,
    websiteId: row.website_id as string,
    askerType: row.asker_type as AskerType,
    askerId: row.asker_id as string,
    message: row.message as string,
    answer: row.answer as string,
    wasAnswered: row.was_answered as boolean,
    sources: (row.sources as SourcesUsed) ?? null,
    resolved: row.resolved as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// Fire-and-forget from the caller's perspective (see chat.routes.ts) --
// a visitor's answer should never wait on, or fail because of, the log
// write. No-ops silently when CHAT_LOG_DATABASE_URL isn't configured, so
// local dev without Postgres keeps working exactly as before.
export async function logConversation(input: LogConversationInput): Promise<void> {
  if (!isChatLogEnabled()) return;
  const pool = await getPool();
  await pool.query(
    `INSERT INTO conversation_logs (website_id, asker_type, asker_id, message, answer, was_answered, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.websiteId, input.askerType, input.askerId, input.message, input.answer, input.wasAnswered, JSON.stringify(input.sources)]
  );
}

export async function listUnanswered(websiteId: string): Promise<ConversationLogEntry[]> {
  if (!isChatLogEnabled()) return [];
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT * FROM conversation_logs
     WHERE website_id = $1 AND was_answered = FALSE AND resolved = FALSE
     ORDER BY created_at DESC
     LIMIT 200`,
    [websiteId]
  );
  return rows.map(rowToEntry);
}

// Used for both "Answer" (a knowledge article was added for it) and
// "Dismiss" (admin decided it doesn't need one) -- either way the
// question is handled, but the row itself is kept, not deleted, since
// the whole point of this table is a permanent record of what was asked.
export async function resolveConversation(websiteId: string, id: string): Promise<boolean> {
  if (!isChatLogEnabled()) return false;
  const pool = await getPool();
  const { rowCount } = await pool.query(`UPDATE conversation_logs SET resolved = TRUE WHERE id = $1 AND website_id = $2`, [id, websiteId]);
  return (rowCount ?? 0) > 0;
}

// The full transcript -- every question asked and every answer given,
// not just the ones that failed. Most recent first.
export async function listConversations(websiteId: string, limit = 100): Promise<ConversationLogEntry[]> {
  if (!isChatLogEnabled()) return [];
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT * FROM conversation_logs WHERE website_id = $1 ORDER BY created_at DESC LIMIT $2`, [websiteId, limit]);
  return rows.map(rowToEntry);
}
