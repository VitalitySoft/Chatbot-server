import { getSession } from "../auth/session";
import { AskerType } from "../data/conversationLogStore";

// Who asked this question, for the conversation log. A visitor who never
// logged in has no way to be told apart from any other visitor without
// building real anonymous-visitor tracking (cookies/fingerprinting),
// which wasn't asked for -- so every guest is logged under one constant
// id. A visitor with a valid customer session (see auth/customerAuth.ts,
// used today for personal booking-status lookups) is identified by their
// real name instead, since that's exactly the case where knowing WHO
// asked actually matters.
const GUEST_ASKER_ID = "guest";

export function resolveAsker(sessionToken: string | undefined, websiteId: string): { askerType: AskerType; askerId: string } {
  const session = getSession(sessionToken, websiteId);
  if (session && typeof session.userId === "string") {
    const name = typeof session.name === "string" && session.name.trim() ? session.name : session.userId;
    return { askerType: "customer", askerId: name };
  }
  return { askerType: "guest", askerId: GUEST_ASKER_ID };
}
