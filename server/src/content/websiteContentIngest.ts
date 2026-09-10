import * as cheerio from "cheerio";
import { fetchLiveRoomTypes, formatRoomTypeSummary } from "../integrations/liveHotelApi";
import { fetchGenericInventory, formatInventoryItemSummary } from "../integrations/genericDataApi";
import { renderPageHtml } from "./headlessRender";

export interface ContentSection {
  id: string;
  title: string;
  content: string;
}

interface CacheEntry {
  sections: ContentSection[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // long enough to avoid refetching on every message, short enough to pick up edits reasonably soon
const cache = new Map<string, CacheEntry>();

const MAX_SECTION_CHARS = 2000;
const MIN_SECTION_CHARS = 40;
const CHUNK_WORD_TARGET = 150;

function cleanDoc($: cheerio.CheerioAPI): void {
  // NOT footer: plenty of real-world sites (like ours) keep their only
  // copy of contact details -- phone, email, address -- in the footer,
  // nowhere else on the page. Stripping it made "contact us" / "location"
  // questions unanswerable even when the info was right there on the site.
  $("script, style, noscript, iframe, svg, nav, header, form, [aria-hidden='true']").remove();
}

function pickMainContainer($: cheerio.CheerioAPI) {
  const candidates = ["main", "[role='main']", "#main", "#content", ".content", "article", "body"];
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) return el;
  }
  return $("body");
}

// Strategy 1: explicit <section id="..."> blocks, e.g. our own demo pages
// author their HTML this way deliberately. Best signal when present.
function extractExplicitSections($: cheerio.CheerioAPI): ContentSection[] {
  const sections: ContentSection[] = [];
  $("section[id]").each((_, el) => {
    const $el = $(el);
    const id = $el.attr("id") ?? "";
    const heading = $el.find("h1, h2, h3").first().text().trim();
    const text = $el.clone().find("h1, h2, h3").remove().end().text().replace(/\s+/g, " ").trim();
    if (text.length >= MIN_SECTION_CHARS) sections.push({ id, title: heading || id, content: text.slice(0, MAX_SECTION_CHARS) });
  });
  return sections;
}

// Strategy 2: most real-world business sites have NO explicit <section id>
// structure at all, but do have headings. Walk the main content area in
// document order, treat each heading as starting a new section, and
// collect the text of everything under it until the next heading.
function extractByHeadings($: cheerio.CheerioAPI, container: ReturnType<cheerio.CheerioAPI>): ContentSection[] {
  const sections: ContentSection[] = [];
  let currentTitle = "";
  let buffer: string[] = [];
  let idx = 0;

  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (text.length >= MIN_SECTION_CHARS) {
      sections.push({ id: `section-${idx++}`, title: currentTitle || `Page section ${idx}`, content: text.slice(0, MAX_SECTION_CHARS) });
    }
    buffer = [];
  };

  // Includes "a": contact details are very often links, not plain text --
  // <a href="tel:...">, <a href="mailto:...">, e.g. in a footer -- and were
  // silently invisible to retrieval when only block-level text tags were read.
  container.find("h1, h2, h3, h4, p, li, td, blockquote, a").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    const $el = $(el);
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
      flush();
      currentTitle = $el.text().trim();
    } else {
      const t = $el.text().trim();
      if (t) buffer.push(t);
    }
  });
  flush();
  return sections;
}

// Strategy 3: last resort for pages with no headings at all -- chunk the
// raw visible text into paragraph-sized pieces so there's still SOMETHING
// for retrieval to search over, rather than nothing.
function extractByChunking(container: ReturnType<cheerio.CheerioAPI>): ContentSection[] {
  const text = container.text().replace(/\s+/g, " ").trim();
  if (text.length < MIN_SECTION_CHARS) return [];

  const words = text.split(" ");
  const sections: ContentSection[] = [];
  for (let i = 0, part = 1; i < words.length; i += CHUNK_WORD_TARGET, part++) {
    const chunk = words.slice(i, i + CHUNK_WORD_TARGET).join(" ");
    if (chunk.length >= MIN_SECTION_CHARS) {
      sections.push({ id: `chunk-${part}`, title: `Page content (part ${part})`, content: chunk.slice(0, MAX_SECTION_CHARS) });
    }
  }
  return sections;
}

// Some real-world sites (client-rendered SPAs -- React/Vue/Angular dev
// servers) return near-empty HTML to a plain fetch(), since content only
// appears after JavaScript runs. We don't run a headless browser for that;
// instead, when the tenant has a `liveApiUrl` (their own backend API), we
// build content sections directly from its structured data (room types,
// descriptions, amenities, pricing) -- which is actually MORE reliable
// than scraped text, and always reflects real current availability.
async function buildLiveApiSections(liveApiUrl: string): Promise<ContentSection[]> {
  const roomTypes = await fetchLiveRoomTypes(liveApiUrl);
  return roomTypes.map((rt) => ({
    id: `live-room-type-${rt.id}`,
    title: rt.name,
    content: formatRoomTypeSummary(rt),
  }));
}

// Same idea as buildLiveApiSections, but for any self-service customer
// who connected their own backend via the documented generic contract
// (see CUSTOMER_API_CONTRACT.md) instead of a hand-built adapter.
async function buildCustomApiSections(customApiUrl: string): Promise<ContentSection[]> {
  const items = await fetchGenericInventory(customApiUrl);
  return items.map((item) => ({
    id: `custom-inventory-${item.id}`,
    title: item.name,
    content: formatInventoryItemSummary(item),
  }));
}

// Shared by both the plain fetch() path and the headless-render fallback
// below -- same three strategies in order of signal quality, whichever
// HTML they're handed.
function extractSections(html: string): ContentSection[] {
  const $ = cheerio.load(html);
  cleanDoc($);

  let sections = extractExplicitSections($);
  if (sections.length === 0) {
    const container = pickMainContainer($);
    sections = extractByHeadings($, container);
    if (sections.length === 0) sections = extractByChunking(container);
  }

  // pickMainContainer() picks ONE container (<main>, #content, etc) --  on
  // most real sites <footer> is a sibling of that container, not a
  // descendant, so contact/address details living only in the footer (very
  // common) would otherwise never be read no matter which strategy above
  // ran. Extracted separately here so it's covered either way.
  const footer = $("footer").first();
  if (footer.length) {
    const footerSections = extractByHeadings($, footer);
    sections = sections.concat(footerSections.length ? footerSections : extractByChunking(footer));
  }

  return sections;
}

// A plain fetch() against a client-rendered SPA (React/Vue/Angular) comes
// back as basically an empty shell -- the real content only exists after
// the page's JavaScript runs. This is the signal that a headless-browser
// render is worth the extra cost, rather than running one for every site.
const WEAK_CONTENT_CHAR_THRESHOLD = 100;

function isWeak(sections: ContentSection[]): boolean {
  const totalChars = sections.reduce((sum, s) => sum + s.content.length, 0);
  return totalChars < WEAK_CONTENT_CHAR_THRESHOLD;
}

// Real "ingestion" of the current website's own content -- not a hardcoded
// data file, and not limited to sites we authored ourselves. Tries three
// text-extraction strategies in order of signal quality against a plain
// fetch() first (fast, works for the vast majority of sites); if that
// comes back essentially empty, retries by actually rendering the page in
// a browser (see headlessRender.ts) so JavaScript-built content becomes
// visible too. Fails soft (empty sections) on network/parse errors --
// website content is one of several sources, not a hard dependency.
export async function getWebsiteContent(websiteUrl: string, websiteId: string, liveApiUrl?: string, customApiUrl?: string): Promise<ContentSection[]> {
  const cached = cache.get(websiteId);
  let sections: ContentSection[];

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    sections = cached.sections;
  } else {
    try {
      const resp = await fetch(websiteUrl, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "ChatbotContentIngest/1.0" } });
      if (!resp.ok) throw new Error(`Website responded with ${resp.status}`);
      const html = await resp.text();
      sections = extractSections(html);

      if (isWeak(sections)) {
        const renderedHtml = await renderPageHtml(websiteUrl);
        if (renderedHtml) {
          const renderedSections = extractSections(renderedHtml);
          if (!isWeak(renderedSections)) sections = renderedSections;
        }
      }

      cache.set(websiteId, { sections, fetchedAt: Date.now() });
    } catch (err) {
      console.error(`[website-content] failed to ingest ${websiteUrl}:`, err instanceof Error ? err.message : err);
      sections = cached?.sections ?? [];
    }
  }

  if (liveApiUrl) {
    const liveSections = await buildLiveApiSections(liveApiUrl);
    return [...liveSections, ...sections];
  }
  if (customApiUrl) {
    const customSections = await buildCustomApiSections(customApiUrl);
    return [...customSections, ...sections];
  }
  return sections;
}
