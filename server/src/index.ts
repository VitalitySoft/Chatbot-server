import { createApp } from "./app";
import { env } from "./config/env";
import { ensureChatLogSchema } from "./db/postgres";

const app = createApp();

ensureChatLogSchema().finally(() => {
  app.listen(env.port, () => {
    console.log(`Chatbot server listening on port ${env.port}`);
  });
});
