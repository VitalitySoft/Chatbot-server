import { Pool } from "pg";
import { Client as SSHClient } from "ssh2";
import net from "node:net";
import { env } from "../config/env";

// The real database for the conversation/question log -- everything else
// in this app is deliberately file-backed JSON, but a permanent,
// queryable record of every question asked and every answer given is
// exactly what a real database is for, not a flat file.
//
// Lazy-initialized and allowed to be ABSENT: local dev and anyone who
// hasn't configured a database yet should still be able to run the rest
// of the app (register, admin, chat) without Postgres -- only the
// logging feature no-ops (see conversationLogStore.ts).
//
// Two ways to configure it:
// - CHAT_LOG_DATABASE_URL: a direct connection string (e.g. Neon, or any
//   Postgres reachable on the network as-is).
// - CHAT_LOG_SSH_HOST (+ the CHAT_LOG_SSH_*/CHAT_LOG_DB_* vars): for a
//   Postgres that's only reachable via SSH (no public endpoint) -- opens
//   a local port that forwards through the SSH connection to Postgres on
//   the remote host, same approach as the Hotel Brinda project's own
//   db.js, adapted to this app's env var naming and TypeScript.
let poolPromise: Promise<Pool> | null = null;
let schemaReady: Promise<void> | null = null;

export function isChatLogEnabled(): boolean {
  return !!env.chatLogDatabaseUrl || !!env.chatLogSshHost;
}

function createDirectPool(): Pool {
  return new Pool({
    connectionString: env.chatLogDatabaseUrl,
    // Neon and most managed Postgres providers require TLS; this accepts
    // their (valid, provider-issued) certs without needing the full CA
    // bundle configured locally.
    ssl: { rejectUnauthorized: false },
  });
}

// Opens a local TCP server that forwards every connection through the SSH
// client to Postgres on the remote host, then points a normal pg Pool at
// that local port. The SSH connection reconnects automatically if it
// drops; forwardOut throws synchronously when the SSH client isn't
// connected, so that path is guarded too instead of crashing the process.
function createTunneledPool(): Promise<Pool> {
  let ssh: SSHClient | null = null;
  let connecting: Promise<SSHClient> | null = null;

  function connectSsh(): Promise<SSHClient> {
    if (connecting) return connecting;
    const client = new SSHClient();
    connecting = new Promise<SSHClient>((resolve, reject) => {
      client.on("ready", () => {
        ssh = client;
        console.log(`[chat-log] SSH tunnel connected to ${env.chatLogSshHost}`);
        resolve(client);
      });
      client.on("error", (err) => {
        console.error("[chat-log] SSH tunnel error:", err.message);
        reject(err);
      });
      client.on("close", () => {
        if (ssh === client) ssh = null;
        connecting = null;
      });
      client.connect({
        host: env.chatLogSshHost,
        port: env.chatLogSshPort,
        username: env.chatLogSshUser,
        password: env.chatLogSshPassword,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
      });
    }).finally(() => {
      connecting = null;
    });
    return connecting;
  }

  return new Promise<Pool>((resolve, reject) => {
    connectSsh()
      .then(() => {
        const targetHost = env.chatLogDbHost;
        const targetPort = env.chatLogDbPort;

        const server = net.createServer((socket) => {
          socket.on("error", () => socket.destroy());
          const forward = (client: SSHClient) => {
            client.forwardOut(socket.remoteAddress || "127.0.0.1", socket.remotePort || 0, targetHost, targetPort, (err, stream) => {
              if (err) {
                socket.destroy();
                return;
              }
              stream.on("error", () => socket.destroy());
              socket.pipe(stream).pipe(socket);
            });
          };
          if (ssh) forward(ssh);
          else connectSsh().then(forward).catch(() => socket.destroy());
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const localPort = typeof address === "object" && address ? address.port : 0;
          console.log(`[chat-log] Postgres reachable via SSH tunnel at 127.0.0.1:${localPort} -> ${targetHost}:${targetPort}`);
          resolve(
            new Pool({
              host: "127.0.0.1",
              port: localPort,
              user: env.chatLogDbUser,
              password: env.chatLogDbPassword,
              database: env.chatLogDbName,
              ssl: false,
            })
          );
        });
      })
      .catch(reject);
  });
}

async function buildPool(): Promise<Pool> {
  const pool = env.chatLogSshHost ? await createTunneledPool() : createDirectPool();
  // Required by pg: idle pooled connections can be dropped by the server
  // and emit an 'error' event. Without a handler here, that's an
  // uncaught exception that crashes the whole process, not just the one
  // request using that connection.
  pool.on("error", (err) => console.error("[chat-log] unexpected error on idle database client:", err.message));
  return pool;
}

function getPoolPromise(): Promise<Pool> {
  if (!isChatLogEnabled()) {
    return Promise.reject(new Error("Chat log database is not configured"));
  }
  if (!poolPromise) poolPromise = buildPool();
  return poolPromise;
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

// Used by conversationLogStore.ts for every query -- awaits the pool
// (which may still be opening its SSH tunnel) rather than assuming it's
// already connected.
export async function getPool(): Promise<Pool> {
  return getPoolPromise();
}

// Called once at server startup. Safe to call even when the log is
// disabled (no env vars set) -- just resolves immediately and every
// logging call becomes a no-op (see conversationLogStore.ts).
export async function ensureChatLogSchema(): Promise<void> {
  if (!isChatLogEnabled()) return;
  if (!schemaReady) {
    schemaReady = getPoolPromise()
      .then((pool) => pool.query(SCHEMA_SQL))
      .then(() => {
        console.log("[chat-log] connected to Postgres, schema ready");
      })
      .catch((err) => {
        console.error("[chat-log] failed to set up schema -- conversation logging disabled:", err instanceof Error ? err.message : err);
        poolPromise = null;
        schemaReady = null;
      });
  }
  return schemaReady;
}
