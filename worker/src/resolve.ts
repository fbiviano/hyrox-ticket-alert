// TypeScript port of monitor.py's resolution + status logic
// (resolve_via_static, extract_next_data_event, find_candidate_links,
//  checkout_url_for, get_event_data, ticket_status). Kept behaviourally
// identical so a ticket looks the same whether checked by the Python
// pipeline or here. The Playwright-fallback tier is intentionally not
// ported - it's rarely hit even in the Python pipeline.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEADERS = { "User-Agent": USER_AGENT };
const LINK_KEYWORDS = ["ticket", "shop", "buy", "vivenu", "useembed", "checkout", "register", "event"];

export interface ResolvedTicket {
  name: string;
  active: boolean;
  v?: number;
  minAmountPerOrderRule?: number;
  minAmountPerOrder?: number;
  [key: string]: unknown;
}

export interface ResolvedEvent {
  _id: string;
  name: string;
  tickets: ResolvedTicket[];
}

export function ticketStatus(t: ResolvedTicket): "available" | "sold_out" {
  if (!t.active) return "sold_out";
  let remaining = t.v || 0;
  const minRule = t.minAmountPerOrderRule || 0;
  const minPerOrder = t.minAmountPerOrder || 0;
  if (minRule <= 1 && remaining < minPerOrder) remaining = 0;
  return remaining > 0 ? "available" : "sold_out";
}

export function isFetchableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  if (!isFetchableUrl(url)) return null;
  try {
    const resp = await fetch(url, { headers: HEADERS });
    if (resp.ok) return await resp.text();
  } catch {
    // network error, timeout, etc. - treat as "couldn't fetch"
  }
  return null;
}

function extractNextDataEvent(html: string | null): ResolvedEvent | null {
  if (!html) return null;
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    const event = data?.props?.pageProps?.event;
    if (event && event._id && Array.isArray(event.tickets)) return event as ResolvedEvent;
  } catch {
    // malformed JSON - not a vivenu page shaped the way we expect
  }
  return null;
}

async function findCandidateLinks(html: string, baseUrl: string, limit = 15): Promise<string[]> {
  const hrefs: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("a", {
      element(el) {
        const href = el.getAttribute("href");
        if (href) hrefs.push(href);
      },
    })
    .on("iframe", {
      element(el) {
        const src = el.getAttribute("src");
        if (src) hrefs.push(src);
      },
    });
  await rewriter.transform(new Response(html)).text();

  const seen = new Set<string>();
  const scored: [number, string][] = [];
  for (const href of hrefs) {
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!abs.toLowerCase().startsWith("http") || seen.has(abs)) continue;
    seen.add(abs);
    const lower = abs.toLowerCase();
    const score = LINK_KEYWORDS.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0);
    if (score > 0) scored.push([score, abs]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, url]) => url);
}

export function checkoutUrlFor(shopUrl: string, eventId: string): string {
  const u = new URL(shopUrl);
  return `${u.protocol}//${u.host}/checkout/${eventId}`;
}

export async function getEventData(eventId: string, shopUrl: string): Promise<ResolvedEvent | null> {
  return extractNextDataEvent(await fetchHtml(checkoutUrlFor(shopUrl, eventId)));
}

async function resolveViaStatic(url: string): Promise<{ event: ResolvedEvent; shopUrl: string } | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  let event = extractNextDataEvent(html);
  if (event) return { event, shopUrl: url };
  for (const candidate of await findCandidateLinks(html, url)) {
    event = extractNextDataEvent(await fetchHtml(candidate));
    if (event) return { event, shopUrl: candidate };
  }
  return null;
}

/** Resolve any HYROX/vivenu page into its event + shop URL, with fresh
 * (live-stock) ticket data pulled from the checkout page. */
export async function resolveEvent(url: string): Promise<{ event: ResolvedEvent; shopUrl: string } | null> {
  const found = await resolveViaStatic(url);
  if (!found) return null;
  const live = await getEventData(found.event._id, found.shopUrl);
  return live ? { event: live, shopUrl: found.shopUrl } : found;
}
