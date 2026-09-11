// Client-rendered sites (React/Vue/Angular) return near-empty HTML to a
// plain fetch() -- the page's real content only exists after its
// JavaScript runs in a browser. This module is the actual fix for that:
// launch a browser, let the page's JS run, and read back the DOM it
// produced. Uses the full `puppeteer` package (not `puppeteer-core`), which
// downloads and manages its own private copy of Chromium -- so this works
// on any server out of the box, with no OS-level Chrome/Chromium install
// required. Trades ~300MB of disk for not depending on server setup.

const RENDER_TIMEOUT_MS = 15000;

// Renders a URL in a real browser and returns the resulting HTML (after
// JavaScript has run), or null if rendering fails for any reason --
// callers fall back to the plain-fetch path.
export async function renderPageHtml(url: string): Promise<string | null> {
  let puppeteer: typeof import("puppeteer");
  try {
    puppeteer = await import("puppeteer");
  } catch {
    console.error("[headless-render] puppeteer not installed -- skipping JS rendering for", url);
    return null;
  }

  let browser: import("puppeteer").Browser | null = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("ChatbotContentIngest/1.0 (+headless)");
    await page.goto(url, { waitUntil: "networkidle2", timeout: RENDER_TIMEOUT_MS });
    // A brief settle beyond "network idle" -- some apps paint their real
    // content a moment after their last network request resolves.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const html = await page.content();
    return html;
  } catch (err) {
    console.error(`[headless-render] failed to render ${url}:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => void 0);
  }
}
