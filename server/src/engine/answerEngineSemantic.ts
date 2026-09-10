import { getWebsiteConfig } from "../config/websites";
import { getKnowledgeBase } from "../data/knowledgeStore";
import { getLiveData } from "../db/liveDataStore";
import { getBookingsForUser, Booking } from "../db/bookingStore";
import { getWebsiteContent } from "../content/websiteContentIngest";
import { scoreMatchesSemantic } from "../lib/retrieval/semanticSearch";
import { ScorableDoc, ScoredDoc } from "../lib/retrieval/search";
import { needsLiveData, hasAvailabilityWord } from "../intent/detectLiveDataIntent";
import { isBookingStatusQuestion } from "../intent/detectBookingStatusIntent";
import { extractBookingReference } from "../intent/extractBookingReference";
import { detectSmallTalk } from "../intent/detectSmallTalk";
import { getSession } from "../auth/session";
import { fetchBookingByReference, fetchLiveRoomTypes, formatBookingStatus, formatRoomTypeSummary, mentionsSpecificRoomType, findMentionedRoomType } from "../integrations/liveHotelApi";
import { fetchGenericBooking, fetchGenericInventory, formatInventoryItemSummary, findMentionedItem, mentionsSpecificItem, isBrowsingInventoryQuestion } from "../integrations/genericDataApi";
import { AnswerResult, SourcesUsed, FALLBACK_ANSWER, WebsiteNotFoundError } from "./answerEngine";

// This is a DELIBERATE near-duplicate of answerEngine.ts, not a refactor
// into shared code -- the point is to hold everything except the
// website/knowledge-base matching step identical (small talk, booking
// login, live-data intent, formatting, fallback) so that a comparison
// between the two engines isolates exactly one variable: keyword overlap
// (search.ts) vs. semantic similarity (semanticSearch.ts). See
// routes/chatSemantic.routes.ts and public/compare.html.

function pickBest<T extends ScorableDoc>(
  websiteMatches: ScoredDoc<T>[],
  knowledgeMatches: ScoredDoc<T>[]
): { content: string; from: "website" | "knowledgeBase" } | null {
  const bestWebsite = websiteMatches[0];
  const bestKnowledge = knowledgeMatches[0];
  if (bestWebsite && bestKnowledge) {
    return bestWebsite.score >= bestKnowledge.score ? { content: bestWebsite.doc.content, from: "website" } : { content: bestKnowledge.doc.content, from: "knowledgeBase" };
  }
  if (bestWebsite) return { content: bestWebsite.doc.content, from: "website" };
  if (bestKnowledge) return { content: bestKnowledge.doc.content, from: "knowledgeBase" };
  return null;
}

function formatBookings(bookings: Booking[]): string {
  if (bookings.length === 1) {
    const b = bookings[0];
    return `Your booking ${b.bookingId} (${b.roomType}, ${b.guests} guest${b.guests === 1 ? "" : "s"}) for ${b.checkIn} to ${b.checkOut} is currently: ${b.status}.`;
  }
  return bookings
    .map((b) => `Booking ${b.bookingId}: ${b.roomType}, ${b.checkIn} to ${b.checkOut}, status: ${b.status}.`)
    .join(" ");
}

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

export async function answerQuestionSemantic(websiteId: string, message: string, sessionToken?: string): Promise<AnswerResult> {
  const site = getWebsiteConfig(websiteId);
  if (!site) throw new WebsiteNotFoundError(`Unknown websiteId: ${websiteId}`);

  const sources: SourcesUsed = { database: false, website: false, knowledgeBase: false, humanFallback: false };

  const smallTalk = detectSmallTalk(message);
  if (smallTalk) {
    return { answer: smallTalk, humanFallback: false, requiresLogin: false, callPhone: null, sources };
  }

  // See answerEngine.ts for the rationale: sites with a real backend
  // (`liveApiUrl`) use reference-code lookup against THAT hotel's own API;
  // sites without one keep the local login-gated placeholder flow.
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

  if (needsLiveData(message) || (site.customApiUrl && hasAvailabilityWord(message))) {
    if (site.liveApiUrl) {
      const roomTypes = await fetchLiveRoomTypes(site.liveApiUrl);
      if (roomTypes.length > 0) {
        sources.database = true;
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
      // See answerEngine.ts -- only answer immediately when a SPECIFIC
      // real item is named. Otherwise fall through to content scoring
      // rather than assuming "total availability" was meant.
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

  // Priority 1c: see answerEngine.ts -- browsing all room types vs. asking
  // about one specific type. Kept identical between both engines since it
  // bypasses retrieval scoring entirely (deterministic on real API data).
  if (site.liveApiUrl && /\broom/i.test(message)) {
    const roomTypes = await fetchLiveRoomTypes(site.liveApiUrl);
    if (roomTypes.length > 0 && !mentionsSpecificRoomType(message, roomTypes)) {
      sources.website = true;
      const answer = roomTypes.map(formatRoomTypeSummary).join("\n\n");
      return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
  }

  // See answerEngine.ts -- same browsing-intent check for a self-service
  // customer's own inventory, keyed off question form rather than a noun.
  if (site.customApiUrl && isBrowsingInventoryQuestion(message)) {
    const items = await fetchGenericInventory(site.customApiUrl);
    if (items.length > 0 && !mentionsSpecificItem(message, items)) {
      sources.website = true;
      const answer = items.map(formatInventoryItemSummary).join("\n\n");
      return { answer, humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
  }

  // The one line that differs from answerEngine.ts: semantic similarity
  // instead of keyword overlap. Everything else about the priority order
  // and verbatim-answer behavior is identical.
  const contentSections = await getWebsiteContent(site.websiteUrl, site.websiteId, site.liveApiUrl, site.customApiUrl);
  const knowledgeItems = getKnowledgeBase(site.websiteId);

  const [websiteMatches, knowledgeMatches] = await Promise.all([
    scoreMatchesSemantic(message, contentSections),
    scoreMatchesSemantic(message, knowledgeItems),
  ]);

  const best = pickBest(websiteMatches, knowledgeMatches);
  if (best) {
    sources[best.from] = true;
    return { answer: best.content, humanFallback: false, requiresLogin: false, callPhone: null, sources };
  }

  // See answerEngine.ts Priority 3.5 -- list all inventory as a last
  // resort ONLY when there's no other real content for this tenant at
  // all, so a near-miss on an actual knowledge article doesn't get
  // buried under an unrelated inventory dump.
  const hasOtherContent =
    knowledgeItems.length > 0 || contentSections.some((s) => !s.id.startsWith("custom-inventory-") && !s.id.startsWith("live-room-type-"));
  if (site.customApiUrl && !hasOtherContent) {
    const items = await fetchGenericInventory(site.customApiUrl);
    if (items.length > 0) {
      sources.website = true;
      return { answer: items.map(formatInventoryItemSummary).join("\n\n"), humanFallback: false, requiresLogin: false, callPhone: null, sources };
    }
  }

  // See answerEngine.ts -- the caller logs this to the conversation log.
  sources.humanFallback = true;
  return { answer: FALLBACK_ANSWER, humanFallback: true, requiresLogin: false, callPhone: site.humanPhone, sources };
}
