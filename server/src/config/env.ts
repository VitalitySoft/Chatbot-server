import "dotenv/config";

export const env = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
  isDev: (process.env.NODE_ENV ?? "development") !== "production",

  databaseUrl: process.env.DATABASE_URL ?? "./data/live-data.json",

  // A real Postgres connection string, for the conversation/question log
  // (see db/postgres.ts) -- deliberately a DIFFERENT env var from
  // DATABASE_URL above, which points at the small placeholder "live data"
  // JSON file and predates this. Undefined until someone sets it; the log
  // feature no-ops rather than crashing the rest of the app when unset.
  chatLogDatabaseUrl: process.env.CHAT_LOG_DATABASE_URL,

  // Alternative to the connection string above: for a Postgres that's
  // only reachable via SSH (no public endpoint), same pattern as the
  // Hotel Brinda project's own server/.env. Setting CHAT_LOG_SSH_HOST is
  // what switches db/postgres.ts to the tunneled path instead of the
  // direct connection string.
  chatLogSshHost: process.env.CHAT_LOG_SSH_HOST,
  chatLogSshPort: parseInt(process.env.CHAT_LOG_SSH_PORT ?? "22", 10),
  chatLogSshUser: process.env.CHAT_LOG_SSH_USER,
  chatLogSshPassword: process.env.CHAT_LOG_SSH_PASSWORD,
  // Where Postgres actually listens, AS SEEN FROM the SSH server (almost
  // always 127.0.0.1 -- the whole reason a tunnel is needed is that it's
  // not exposed on the SSH server's public interface).
  chatLogDbHost: process.env.CHAT_LOG_DB_HOST ?? "127.0.0.1",
  chatLogDbPort: parseInt(process.env.CHAT_LOG_DB_PORT ?? "5432", 10),
  chatLogDbName: process.env.CHAT_LOG_DB_NAME,
  chatLogDbUser: process.env.CHAT_LOG_DB_USER,
  chatLogDbPassword: process.env.CHAT_LOG_DB_PASSWORD,
};
