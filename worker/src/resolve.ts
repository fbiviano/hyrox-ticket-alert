// TypeScript port of monitor.py's resolution + status logic
// (resolve_via_static, extract_next_data_event, find_candidate_links,
//  checkout_url_for, get_event_data, ticket_status). Kept behaviourally
// identical so a ticket looks the same whether checked by the Python
// pipeline or here. The Playwright-fallback tier is intentionally not
// ported - it's rarely hit even in the Python pipeline.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export const HEADERS = { "User-Agent": USER_AGENT };
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

/** The site told us to slow down (429, or 503 while overloaded). That says nothing about
 * whether tickets are on sale, so callers must treat it as "couldn't check - try again
 * next round", never as "not on sale". hyrox.com rate-limits requests from Cloudflare's
 * network, so this happens in production; seen 2026-10-21. */
export class FetchBlocked extends Error {}

async function fetchHtml(url: string): Promise<string | null> {
  if (!isFetchableUrl(url)) return null;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: HEADERS });
  } catch {
    return null; // network error, timeout, etc. - treat as "couldn't fetch"
  }
  if (resp.status === 429 || resp.status === 503) throw new FetchBlocked(`${resp.status} from ${new URL(url).host}`);
  if (!resp.ok) return null;
  try {
    return await resp.text();
  } catch {
    return null;
  }
}

/** hyrox.com's own pages (other than the one being resolved) and the merch shop never hold
 * a ticket shop - following them only spends requests against hyrox.com's rate limit. */
function isDeadEndCandidate(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  if (host.endsWith("hyrox-shop.com")) return true;
  return (host === "hyrox.com" || host === "www.hyrox.com") && !u.pathname.toLowerCase().includes("/checkout");
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

  const page = new URL(baseUrl);
  page.hash = "";
  const seen = new Set<string>([page.toString()]); // links back to this same page ("#top", "#info") aren't candidates
  const scored: [number, string][] = [];
  for (const href of hrefs) {
    let abs: string;
    try {
      const u = new URL(href, baseUrl);
      u.hash = "";
      if (isDeadEndCandidate(u)) continue;
      abs = u.toString();
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

/** vivenu moved some shops (usa.hyrox.com so far) onto a newer storefront:
 * /event/<slug> now 307s to /events/<slug> and is rendered without the old
 * __NEXT_DATA__ blob, so extractNextDataEvent() sees nothing and a shop with
 * live stock looked "not on sale" - race watches on seven live US races never
 * fired and the homepage listed them as not on sale. The event's id is still
 * embedded in the page's serialized payload and /checkout/<id> still serves
 * the old shape, so recover the event that way. Gated on storefront-only
 * markers so ordinary marketing pages never trigger the extra fetches. */
async function eventViaCheckout(html: string, pageUrl: string): Promise<ResolvedEvent | null> {
  if (!/checkoutExpirationMinutes|checkoutSteps/.test(html)) return null;
  const origin = new URL(pageUrl).origin;
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  // The event's own id sits directly before its "name" key in the payload;
  // try those first so the usual case is one checkout fetch, not several.
  for (const m of html.matchAll(/(?<![0-9a-f])([0-9a-f]{24})(?![0-9a-f])[\\"',\s]{1,12}name[\\"']/g)) add(m[1]);
  for (const m of html.matchAll(/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g)) add(m[0]);
  for (const id of ids.slice(0, 6)) {
    const event = extractNextDataEvent(await fetchHtml(`${origin}/checkout/${id}`));
    if (event) return event;
  }
  return null;
}

async function resolveViaStatic(url: string): Promise<{ event: ResolvedEvent; shopUrl: string } | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  let event = extractNextDataEvent(html) || (await eventViaCheckout(html, url));
  if (event) return { event, shopUrl: url };
  for (const candidate of await findCandidateLinks(html, url)) {
    const candidateHtml = await fetchHtml(candidate);
    event = extractNextDataEvent(candidateHtml) || (candidateHtml ? await eventViaCheckout(candidateHtml, candidate) : null);
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
