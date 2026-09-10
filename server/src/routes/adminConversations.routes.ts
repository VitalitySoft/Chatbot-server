import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAdminSession } from "../middleware/requireAdminSession";
import { listConversations } from "../data/conversationLogStore";

// Mounted at /api/admin/:websiteId/conversations -- the full transcript:
// every question a visitor asked and the exact answer they were given,
// who asked (a guest, or a logged-in customer by name), and whether it
// was actually answered. Separate from /unanswered, which is just the
// filtered view of this same table where was_answered = false.
export const adminConversationsRouter = Router({ mergeParams: true });
adminConversationsRouter.use(requireAdminSession);

adminConversationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listConversations(req.params.websiteId));
  })
);
