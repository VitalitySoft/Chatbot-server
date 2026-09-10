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
};
