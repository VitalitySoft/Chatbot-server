import { Router } from "express";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { requireAdminSession } from "../middleware/requireAdminSession";
import { listUnanswered, resolveConversation } from "../data/conversationLogStore";

// Mounted at /api/admin/:websiteId/unanswered -- every question the
// chatbot couldn't answer lands here (backed by the conversation_logs
// table in Postgres, see conversationLogStore.ts) so the admin can see
// the real gaps in their knowledge base and act on them, instead of that
// signal just vanishing into a visitor's frustration.
export const adminUnansweredRouter = Router({ mergeParams: true });
adminUnansweredRouter.use(requireAdminSession);

adminUnansweredRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listUnanswered(req.params.websiteId));
  })
);

// Marks a question as handled -- called once the admin has added a
// knowledge article (or otherwise decided it doesn't need one). The row
// itself is never deleted, only flagged resolved -- it stays in the
// permanent conversation record either way.
adminUnansweredRouter.post(
  "/:id/resolve",
  asyncHandler(async (req, res) => {
    const ok = await resolveConversation(req.params.websiteId, req.params.id);
    if (!ok) throw new ApiError(404, "Question not found");
    res.status(204).send();
  })
);

// "Dismiss" -- same as resolve, just admin deciding no article is
// needed rather than having just added one. Kept as a DELETE route to
// match the existing admin UI's dismiss button without a frontend change,
// but it no longer deletes anything -- see resolveConversation.
adminUnansweredRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const ok = await resolveConversation(req.params.websiteId, req.params.id);
    if (!ok) throw new ApiError(404, "Question not found");
    res.status(204).send();
  })
);
