import { getWebsiteConfig } from "../config/websites";
import { getKnowledgeBase } from "../data/knowledgeStore";
import { getLiveData } from "../db/liveDataStore";
import { getBookingsForUser, Booking } from "../db/bookingStore";
import { getWebsiteContent } from "../content/websiteContentIngest";
import { scoreMatches, ScorableDoc } from "../lib/retrieval/search";
import { needsLiveData, hasAvailabilityWord } from "../intent/detectLiveDataIntent";
import { isBookingStatusQuestion } from "../intent/detectBookingStatusIntent";
import { extractBookingReference } from "../intent/extractBookingReference";
import { detectSmallTalk } from "../intent/detectSmallTalk";
import { getSession } from "../auth/session";
import { fetchBookingByReference, fetchLiveRoomTypes, formatBookingStatus, formatRoomTypeSummary, mentionsSpecificRoomType, findMentionedRoomType } from "../integrations/liveHotelApi";
import { fetchGenericBooking, fetchGenericInventory, formatInventoryItemSummary, findMentionedItem, mentionsSpecificItem, isBrowsingInventoryQuestion } from "../integrations/genericDataApi";

export const FALLBACK_ANSWER = "I'm sorry, I don't have enough information to answer that.";

export interface SourcesUsed {
  database: boolean;
  website: boolean;
  knowledgeBase: boolean;
  humanFallback: boolean;
}

export interface AnswerResult {
  answer: string;
  humanFallback: boolean;
  requiresLogin: boolean;
  callPhone: string | null;
  sources: SourcesUsed;
}

export class WebsiteNotFoundError extends Error {}

function formatBookings(bookings: Booking[]): string {
  if (bookings.length === 1) {
    const b = bookings[0];
    return `Your booking ${b.bookingId} (${b.roomType}, ${b.guests} guest${b.guests === 1 ? "" : "s"}) for ${b.checkIn} to ${b.checkOut} is currently: ${b.status}.`;
  }
  return bookings
    .map((b) => `Booking ${b.bookingId}: ${b.roomType}, ${b.checkIn} to ${b.checkOut}, status: ${b.status}.`)
    .join(" ");
}

// Formats a website's own small live-data snapshot. The field names are
// necessarily website-specific (a hotel tracks rooms, a studio tracks
// booking slots) -- this is formatting a known DATA SHAPE, not hardcoding
// an answer to any particular question wording.
function formatLiveData(liveData: Record<string, unknown>): string | null {
  if (liveData.rooms && typeof liveData.rooms === "object") {
    const r = liveData.rooms as { total: number; available: number };
    return `Currently, ${r.available} out of ${r.total} rooms are available.`;
  }
  if (liveData.bookingSlots && typeof liveData.bookingSlots === "object") {
    const b = liveData.bookingSlots as { nextAvailableDate: string; slotsOpenThisMonth: number };
    return `Our next available slot is ${b.nextAvailableDate}. We have ${b.slotsOpenThisMonth} open slots remaining this month.`;
  }
  return null;
}

// THE single orchestration point for answering a visitor's question.
// Nothing in here calls an AI model -- every answer is either (a) a
// knowledge/website article returned verbatim, (b) a database value
// formatted deterministically, or (c) the fixed fallback message. Every
// lookup is scoped to the one `site`/`websiteId` resolved at the top.
export async function answerQuestion(websiteId: string, message: string, sessionToken?: string): Promise<AnswerResult> {
  const site = getWebsiteConfig(websiteId);
  if (!site) throw new WebsiteNotFoundError(`Unknown websiteId: ${websiteId}`);

  const sources: SourcesUsed = { database: false, website: false, knowledgeBase: false, humanFallback: false };

  // Priority 0: small talk (greetings/thanks/goodbyes) -- checked before
  // anything else since it's not a knowledge lookup at all, and answering
  // it costs nothing. Exact-match-after-normalization means a real
  // question that happens to start with "hi" still falls through below.
  const smallTalk = detectSmallTalk(message);
  if (smallTalk) {
    return { answer: smallTalk, humanFallback: false, requiresLogin: false, callPhone: null, sources };
  }

  // Priority 1a: personal booking status. Sites with a real backend
  // (`liveApiUrl`) use THAT hotel's own guest flow: lookup by booking
  // reference code (e.g. "HB-D7VDEZ"), which only the guest possesses --
  // no separate login exists on the real site, and this still guarantees
  // a stranger can never pull up someone else's booking by typing a name.
  // Sites without `liveApiUrl` keep the local login-gated placeholder flow.
  if (site.liveApiUrl) {
    const reference = extractBookingReference(message);
    if (reference) {
      const booking = await fetchBookingByReference(site.liveApiUrl, reference);
      sources.database = true;
      if (!booking) {
        return {
          answer: `I couldn't find a booking with reference "${reference}". Please double-check the code, or call us.`,
          humanFallback: false,
          requiresLogin: false,
          callPhone: site.humanPhone,
          sources,
        };
      }
      const answer = `Your booking ${booking.reference} (${booking.roomTypeName}, Room ${booking.roomNumber}) for ${booking.checkIn} to ${booking.checkOut} is currently: ${formatBookingStatus(booking.status)}.`;
      return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
    if (isBookingStatusQuestion(message)) {
      return {
        answer: "Please share your booking reference code (e.g. HB-XXXXXX from your confirmation) so I can look up your reservation.",
        humanFallback: false,
        requiresLogin: false,
        callPhone: null,
        sources,
      };
    }
  } else if (site.customApiUrl) {
    // Same reasoning as the liveApiUrl branch above, but for a self-service
    // customer's own backend speaking our documented generic contract
    // instead of a hand-built adapter -- see CUSTOMER_API_CONTRACT.md.
    const reference = extractBookingReference(message);
    if (reference) {
      const booking = await fetchGenericBooking(site.customApiUrl, reference);
      sources.database = true;
      if (!booking) {
        return {
          answer: `I couldn't find a booking with reference "${reference}". Please double-check the code, or call us.`,
          humanFallback: false,
          requiresLogin: false,
          callPhone: site.humanPhone,
          sources,
        };
      }
      const dateRange = booking.endDate ? `${booking.startDate} to ${booking.endDate}` : booking.startDate;
      const answer = `Your booking ${booking.reference} (${booking.label}) for ${dateRange} is currently: ${booking.status}.`;
      return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
    if (isBookingStatusQuestion(message)) {
      return {
        answer: "Please share your booking reference code so I can look up your reservation.",
        humanFallback: false,
        requiresLogin: false,
        callPhone: null,
        sources,
      };
    }
  } else if (isBookingStatusQuestion(message)) {
    const session = getSession(sessionToken, websiteId);
    if (!session || !session.userId) {
      return {
        answer: "Please log in to check your booking status.",
        humanFallback: false,
        requiresLogin: true,
        callPhone: null,
        sources,
      };
    }
    const bookings = getBookingsForUser(websiteId, session.userId as string);
    sources.database = true;
    const answer = bookings.length > 0 ? formatBookings(bookings) : "We couldn't find any bookings under your account.";
    return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
  }

  // Priority 1b: general live data (e.g. overall room availability) --
  // this one small, curated, website-scoped snapshot, never a data dump.
  // The customApiUrl OR-clause is needed because a self-service customer's
  // "subject" word (their own item names) can't be hardcoded like the
  // hotel-shaped SUBJECT_WORDS list -- see hasAvailabilityWord.
  if (needsLiveData(message) || (site.customApiUrl && hasAvailabilityWord(message))) {
    if (site.liveApiUrl) {
      const roomTypes = await fetchLiveRoomTypes(site.liveApiUrl);
      if (roomTypes.length > 0) {
        sources.database = true;
        // "is the deluxe room available today" asks about ONE type -- answer
        // that type's own count, not the whole property's total (which
        // answered a different question than the one asked).
        const specific = findMentionedRoomType(message, roomTypes);
        if (specific) {
          const answer =
            specific.availableCount > 0
              ? `Yes, we currently have ${specific.availableCount} ${specific.name}${specific.availableCount === 1 ? "" : "s"} available today.`
              : `Sorry, we don't have any ${specific.name} available today.`;
          return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
        }
        const total = roomTypes.reduce((sum, rt) => sum + rt.availableCount, 0);
        const byType = roomTypes.map((rt) => `${rt.name}: ${rt.availableCount} available`).join(", ");
        return { answer: `We currently have ${total} room(s) available in total (${byType}).`, humanFallback: false, requiresLogin: false, callPhone: null, sources };
      }
    } else if (site.customApiUrl) {
      // Only answer immediately when a SPECIFIC real item is named --
      // that's unambiguous. If the availability word fired but nothing
      // named matches an actual item (e.g. "is lock room available" on a
      // fitness studio with no such class), don't assume "total
      // availability" was meant -- fall through to content scoring
      // instead, since a knowledge article or website section is often
      // the real answer (e.g. "Is there a shower or locker room?").
      // The last-resort inventory listing below (see hasOtherContent)
      // still catches this for a tenant with nothing else configured.
      const items = await fetchGenericInventory(site.customApiUrl);
      const withCounts = items.filter((i) => i.availableCount !== null);
      const specific = findMentionedItem(message, withCounts);
      if (specific) {
        sources.database = true;
        const answer =
          (specific.availableCount as number) > 0
            ? `Yes, we currently have ${specific.availableCount} ${specific.name}${specific.availableCount === 1 ? "" : "s"} available.`
            : `Sorry, we don't have any ${specific.name} available right now.`;
        return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
      }
    } else {
      const liveData = getLiveData(websiteId);
      const formatted = liveData ? formatLiveData(liveData) : null;
      if (formatted) {
        sources.database = true;
        return { answer: formatted, humanFallback: false, requiresLogin: false, callPhone: null, sources };
      }
    }
  }

  // Priority 1c: browsing all room types ("what rooms do you have") vs.
  // asking about one specific type ("deluxe room amenities"). Keyword/
  // semantic scoring below only ever surfaces the SINGLE best-matching
  // section, which is right for one distinct FAQ topic but wrong here --
  // a generic "rooms" query is genuinely relevant to every room type, and
  // the visitor is browsing options, not asking about just one.
  if (site.liveApiUrl && /\broom/i.test(message)) {
    const roomTypes = await fetchLiveRoomTypes(site.liveApiUrl);
    if (roomTypes.length > 0 && !mentionsSpecificRoomType(message, roomTypes)) {
      sources.website = true;
      const answer = roomTypes.map(formatRoomTypeSummary).join("\n\n");
      return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
  }

  // Same idea for a self-service customer's own inventory, but keyed off
  // the QUESTION FORM ("what * do you have/offer") instead of a hardcoded
  // noun like "room" -- their items could be classes, services, products,
  // anything. Checked here, before content scoring, so a browsing
  // question can't get hijacked by an unrelated section that just happens
  // to share a word (e.g. a "Class Policies" FAQ for "what classes do you have").
  if (site.customApiUrl && isBrowsingInventoryQuestion(message)) {
    const items = await fetchGenericInventory(site.customApiUrl);
    if (items.length > 0 && !mentionsSpecificItem(message, items)) {
      sources.website = true;
      const answer = items.map(formatInventoryItemSummary).join("\n\n");
      return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
  }

  // Priority 2 & 3: website content and knowledge base -- pure keyword
  // relevance matching, the winning article's content returned verbatim
  // (never rewritten or summarized, since there's no AI to do that).
  const contentSections = await getWebsiteContent(site.websiteUrl, site.websiteId, site.liveApiUrl, site.customApiUrl);
  const knowledgeItems = getKnowledgeBase(site.websiteId);

  const websiteMatches = scoreMatches(message, contentSections);
  const knowledgeMatches = scoreMatches(message, knowledgeItems);

  const bestWebsite = websiteMatches[0];
  const bestKnowledge = knowledgeMatches[0];

  let best: { content: string; from: "website" | "knowledgeBase" } | null = null;
  if (bestWebsite && bestKnowledge) {
    best = bestWebsite.score >= bestKnowledge.score ? { content: bestWebsite.doc.content, from: "website" } : { content: bestKnowledge.doc.content, from: "knowledgeBase" };
  } else if (bestWebsite) {
    best = { content: bestWebsite.doc.content, from: "website" };
  } else if (bestKnowledge) {
    best = { content: bestKnowledge.doc.content, from: "knowledgeBase" };
  }

  if (best) {
    sources[best.from] = true;
    return { answer: best.content, humanFallback: false, requiresLogin: false, callPhone: null, sources };
  }

  // Priority 3.5: nothing matched a specific topic. If this tenant has NO
  // other content at all (no knowledge articles, no readable website) but
  // DOES have a connected database, list its inventory rather than giving
  // up on real, available data -- this is what makes a database-only
  // tenant (nothing else configured) still answer "what do you have"
  // style questions. But if real knowledge articles or website content
  // exist, a near-miss here should fall through to the honest fallback
  // (and get logged as unanswered) instead of dumping an unrelated
  // inventory list that has nothing to do with what was actually asked.
  const hasOtherContent =
    knowledgeItems.length > 0 || contentSections.some((s) => !s.id.startsWith("custom-inventory-") && !s.id.startsWith("live-room-type-"));
  if (site.customApiUrl && !hasOtherContent) {
    const items = await fetchGenericInventory(site.customApiUrl);
    if (items.length > 0) {
      sources.website = true;
      return { answer: items.map(formatInventoryItemSummary).join("\n\n"), humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
  }

  // Priority 4 / nothing found anywhere: never guess. The caller (see
  // chat.routes.ts) logs this to the conversation log, same as every
  // other answer -- humanFallback is what marks it "unanswered" there.
  sources.humanFallback = true;
  return { answer: FALLBACK_ANSWER, humanFallback: true, requiresLogin: false, callPhone: site.humanPhone, sources };
}

export type { ScorableDoc };
