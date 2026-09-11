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

export interface UnansweredEntry {
  id: string;
  message: string;
  count: number;
  lastAskedAt: string;
}

// Grouped by exact message text -- the same question asked repeatedly
// (very common: "contact us" asked by many different visitors) collapses
// into one entry with a count, instead of cluttering the admin's to-do
// list with a separate row per occurrence.
export async function listUnanswered(websiteId: string): Promise<UnansweredEntry[]> {
  if (!isChatLogEnabled()) return [];
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT
       (array_agg(id ORDER BY created_at DESC))[1] AS id,
       message,
       COUNT(*)::int AS count,
       MAX(created_at) AS last_asked_at
     FROM conversation_logs
     WHERE website_id = $1 AND was_answered = FALSE AND resolved = FALSE
     GROUP BY message
     ORDER BY last_asked_at DESC
     LIMIT 200`,
    [websiteId]
  );
  return rows.map((row) => ({
    id: row.id as string,
    message: row.message as string,
    count: row.count as number,
    lastAskedAt: (row.last_asked_at as Date).toISOString(),
  }));
}

// Used for both "Answer" (a knowledge article was added for it) and
// "Dismiss" (admin decided it doesn't need one) -- either way the
// question is handled, but rows are kept, never deleted, since the whole
// point of this table is a permanent record of what was asked. Resolves
// every row with the SAME message text, not just the one `id` passed in
// (which is just one representative occurrence, per listUnanswered's
// grouping) -- otherwise a question asked 5 times would still show 4
// left after clicking Answer/Dismiss once.
export async function resolveConversation(websiteId: string, id: string): Promise<boolean> {
  if (!isChatLogEnabled()) return false;
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT message FROM conversation_logs WHERE id = $1 AND website_id = $2`, [id, websiteId]);
  if (rows.length === 0) return false;
  const { rowCount } = await pool.query(
    `UPDATE conversation_logs SET resolved = TRUE WHERE website_id = $1 AND message = $2 AND resolved = FALSE`,
    [websiteId, rows[0].message]
  );
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
