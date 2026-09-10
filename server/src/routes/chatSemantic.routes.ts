import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { chatRateLimiter } from "../middleware/rateLimit";
import { sanitizePlainText } from "../lib/security/sanitize";
import { answerQuestionSemantic } from "../engine/answerEngineSemantic";
import { WebsiteNotFoundError } from "../engine/answerEngine";
import { getWebsiteConfig } from "../config/websites";
import { env } from "../config/env";
import { logConversation } from "../data/conversationLogStore";
import { resolveAsker } from "../lib/resolveAsker";

// Mirrors chat.routes.ts exactly, except it calls the semantic engine --
// see answerEngineSemantic.ts for why this is a parallel implementation
// rather than a shared one.
export const chatSemanticRouter = Router();
chatSemanticRouter.use(chatRateLimiter);

const chatSchema = z.object({
  websiteId: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  sessionToken: z.string().max(200).optional(),
});

chatSemanticRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "Invalid request");
    const { websiteId, sessionToken } = parsed.data;
    const message = sanitizePlainText(parsed.data.message);
    if (!message) throw new ApiError(400, "Empty message");

    let result;
    try {
      result = await answerQuestionSemantic(websiteId, message, sessionToken);
    } catch (err) {
      if (err instanceof WebsiteNotFoundError) throw new ApiError(404, "Unknown website");
      console.error("[chat-semantic] answerQuestionSemantic failed:", err);
      const site = getWebsiteConfig(websiteId);
      return res.json({
        answer: "I'm unable to provide that information right now. Would you like to speak with our team?",
        humanFallback: true,
        requiresLogin: false,
        callPhone: site?.humanPhone ?? null,
      });
    }

    // See chat.routes.ts for the rationale -- fire-and-forget, logs every
    // question and answer, never blocks or fails the visitor's response.
    const { askerType, askerId } = resolveAsker(sessionToken, websiteId);
    logConversation({
      websiteId,
      askerType,
      askerId,
      message,
      answer: result.answer,
      wasAnswered: !result.humanFallback,
      sources: result.sources,
    }).catch((err) => console.error("[chat-semantic] failed to log conversation:", err instanceof Error ? err.message : err));

    res.json({
      answer: result.answer,
      humanFallback: result.humanFallback,
      requiresLogin: result.requiresLogin,
      callPhone: result.callPhone,
      ...(env.isDev ? { debug: { sources: result.sources } } : {}),
    });
  })
);
