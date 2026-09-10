// Self-service counterpart to liveHotelApi.ts. liveHotelApi.ts is a
// hand-built adapter for ONE tenant's existing, hotel-shaped API --
// nothing a new customer could set up themselves without us writing
// custom code. This module instead calls a small, DOCUMENTED, generic
// contract (see /CUSTOMER_API_CONTRACT.md) that any customer's own
// backend can implement on its own, then just paste the base URL into
// the admin portal -- no code on our side per customer.

export interface GenericBooking {
  reference: string;
  label: string;
  startDate: string;
  endDate: string | null;
  status: string;
  quantity: number | null;
}

export interface GenericInventoryItem {
  id: string;
  name: string;
  description: string;
  price: string | null;
  tags: string[];
  availableCount: number | null;
}

const FETCH_TIMEOUT_MS = 5000;
const INVENTORY_CACHE_TTL_MS = 60 * 1000;
const inventoryCache = new Map<string, { data: GenericInventoryItem[]; fetchedAt: number }>();

export async function fetchGenericBooking(baseUrl: string, reference: string): Promise<GenericBooking | null> {
  try {
    const resp = await fetch(`${baseUrl}/booking/${encodeURIComponent(reference)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const b = (await resp.json()) as Record<string, unknown>;
    if (!b.reference || !b.label || !b.startDate || !b.status) return null;
    return {
      reference: b.reference as string,
      label: b.label as string,
      startDate: b.startDate as string,
      endDate: (b.endDate as string) ?? null,
      status: b.status as string,
      quantity: (b.quantity as number) ?? null,
    };
  } catch (err) {
    console.error(`[generic-data-api] booking lookup failed for ${baseUrl}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function fetchGenericInventory(baseUrl: string): Promise<GenericInventoryItem[]> {
  const cached = inventoryCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < INVENTORY_CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const resp = await fetch(`${baseUrl}/inventory`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`inventory responded with ${resp.status}`);
    const rows = (await resp.json()) as Record<string, unknown>[];
    const data: GenericInventoryItem[] = rows
      .filter((r) => r.id && r.name)
      .map((r) => ({
        id: String(r.id),
        name: r.name as string,
        description: (r.description as string) ?? "",
        price: (r.price as string) ?? null,
        tags: (r.tags as string[]) ?? [],
        availableCount: typeof r.availableCount === "number" ? (r.availableCount as number) : null,
      }));
    inventoryCache.set(baseUrl, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.error(`[generic-data-api] inventory fetch failed for ${baseUrl}:`, err instanceof Error ? err.message : err);
    return cached?.data ?? [];
  }
}

export function formatInventoryItemSummary(item: GenericInventoryItem): string {
  const parts = [item.description || item.name];
  if (item.tags.length > 0) parts.push(`Features: ${item.tags.join(", ")}.`);
  if (item.price) parts.push(`Price: ${item.price}.`);
  if (item.availableCount !== null) parts.push(`Currently ${item.availableCount} available.`);
  return `${item.name}: ${parts.join(" ")}`;
}

// See liveHotelApi.ts's mentionsSpecificRoomType/findMentionedRoomType for
// the same reasoning -- checked against the customer's OWN real inventory
// names, not a hardcoded list, so it stays correct as they add/rename items.
export function findMentionedItem(message: string, items: GenericInventoryItem[]): GenericInventoryItem | null {
  const lower = message.toLowerCase();
  return (
    items.find((item) => {
      const firstWord = item.name.split(/\s+/)[0]?.toLowerCase();
      return !!firstWord && firstWord.length > 2 && lower.includes(firstWord);
    }) ?? null
  );
}

export function mentionsSpecificItem(message: string, items: GenericInventoryItem[]): boolean {
  return findMentionedItem(message, items) !== null;
}

// A customer's inventory could be rooms, classes, services, products --
// no single collective noun to key off, unlike the hotel-specific "room"
// check. So this keys off the QUESTION FORM instead ("what * do you
// have/offer", "show me your ...", "what options"), which holds regardless
// of what the items are actually called. Needed because plain keyword or
// semantic scoring can accidentally match an unrelated section that just
// happens to share a word (e.g. "Class Policies" for "what classes do you
// have") instead of recognizing this as a browse-everything question.
const BROWSING_PATTERNS = [
  /\bwhat\b.{0,30}\b(do you have|do you offer|is available|are available)\b/i,
  /\bwhat\b.{0,20}\boptions\b/i,
  /\bshow me\b/i,
  /\bwhat.{0,15}\bdo you (sell|provide|do)\b/i,
];

export function isBrowsingInventoryQuestion(message: string): boolean {
  return BROWSING_PATTERNS.some((p) => p.test(message));
}
