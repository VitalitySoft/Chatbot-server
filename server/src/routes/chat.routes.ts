import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { chatRateLimiter } from "../middleware/rateLimit";
import { sanitizePlainText } from "../lib/security/sanitize";
import { answerQuestion, WebsiteNotFoundError } from "../engine/answerEngine";
import { getWebsiteConfig } from "../config/websites";
import { env } from "../config/env";
import { logConversation } from "../data/conversationLogStore";
import { resolveAsker } from "../lib/resolveAsker";

export const chatRouter = Router();
chatRouter.use(chatRateLimiter);

const chatSchema = z.object({
  websiteId: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  sessionToken: z.string().max(200).optional(),
});

chatRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "Invalid request");
    const { websiteId, sessionToken } = parsed.data;
    const message = sanitizePlainText(parsed.data.message);
    if (!message) throw new ApiError(400, "Empty message");

    let result;
    try {
      result = await answerQuestion(websiteId, message, sessionToken);
    } catch (err) {
      if (err instanceof WebsiteNotFoundError) throw new ApiError(404, "Unknown website");
      // Never leak technical errors to the visitor -- log server-side, show the same safe fallback.
      console.error("[chat] answerQuestion failed:", err);
      const site = getWebsiteConfig(websiteId);
      return res.json({
        answer: "I'm unable to provide that information right now. Would you like to speak with our team?",
        humanFallback: true,
        requiresLogin: false,
        callPhone: site?.humanPhone ?? null,
      });
    }

    // Fire-and-forget: logging must never slow down or break a visitor's
    // answer. Every question and its answer are recorded, not just the
    // ones that failed -- see conversationLogStore.ts.
    const { askerType, askerId } = resolveAsker(sessionToken, websiteId);
    logConversation({
      websiteId,
      askerType,
      askerId,
      message,
      answer: result.answer,
      wasAnswered: !result.humanFallback,
      sources: result.sources,
    }).catch((err) => console.error("[chat] failed to log conversation:", err instanceof Error ? err.message : err));

    res.json({
      answer: result.answer,
      humanFallback: result.humanFallback,
      requiresLogin: result.requiresLogin,
      callPhone: result.callPhone,
      // Debug info is dev-only by design -- never sent to production visitors.
      ...(env.isDev ? { debug: { sources: result.sources } } : {}),
    });
  })
);
