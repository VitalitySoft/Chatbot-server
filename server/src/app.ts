import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { chatRouter } from "./routes/chat.routes";
import { chatSemanticRouter } from "./routes/chatSemantic.routes";
import { websiteConfigRouter } from "./routes/websiteConfig.routes";
import { customerAuthRouter } from "./routes/customerAuth.routes";
import { adminAuthRouter } from "./routes/adminAuth.routes";
import { adminKnowledgeRouter } from "./routes/adminKnowledge.routes";
import { adminDocumentsRouter } from "./routes/adminDocuments.routes";
import { adminSettingsRouter } from "./routes/adminSettings.routes";
import { adminUnansweredRouter } from "./routes/adminUnanswered.routes";
import { adminConversationsRouter } from "./routes/adminConversations.routes";
import { registerRouter } from "./routes/register.routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(express.json({ limit: "256kb" }));

  // Open CORS everywhere: the widget is meant to be embedded on arbitrary
  // third-party sites, and isolation is enforced by websiteId lookup in
  // the chat engine, not by which origin is calling.
  app.use(cors());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/widget.js", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../../widget/dist/widget.js"));
  });

  // Shared static assets (logo, etc.) used by both /register and /admin.
  app.use("/assets", express.static(path.resolve(__dirname, "../public/assets")));

  // No public landing page -- the admin login is the front door. Visiting
  // the bare domain should land you somewhere useful, not a 404.
  app.get("/", (_req, res) => res.redirect("/admin/"));

  // The admin portal (see public/admin/).
  app.use("/admin", express.static(path.resolve(__dirname, "../public/admin")));

  // Self-service "install this on your website" sign-up page.
  app.use("/register", express.static(path.resolve(__dirname, "../public/register")));

  // A local-only dummy business site for manually verifying the register
  // -> install -> answer flow end to end. Not something a real deployment
  // would ship.
  app.use("/dummy-site", express.static(path.resolve(__dirname, "../public/dummy-site")));
  app.use("/dummy-site-hotel", express.static(path.resolve(__dirname, "../public/dummy-site-hotel")));

  app.use("/api/chat", chatRouter);
  app.use("/api/chat-semantic", chatSemanticRouter);
  app.use("/api/website-config", websiteConfigRouter);
  app.use("/api/login", customerAuthRouter);
  app.use("/api/register", registerRouter);
  app.use("/api/admin/login", adminAuthRouter);
  app.use("/api/admin/:websiteId/knowledge", adminKnowledgeRouter);
  app.use("/api/admin/:websiteId/documents", adminDocumentsRouter);
  app.use("/api/admin/:websiteId/settings", adminSettingsRouter);
  app.use("/api/admin/:websiteId/unanswered", adminUnansweredRouter);
  app.use("/api/admin/:websiteId/conversations", adminConversationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
