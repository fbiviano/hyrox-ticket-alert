import { resolveEvent, getEventData, ticketStatus, isFetchableUrl, HEADERS } from "./resolve";

const SITEMAP_URL = "https://hyrox.com/event-sitemap.xml";
const INDEX_BATCH_SIZE = 30;
const INDEX_STALE_DAYS = 7;
// The real constraint turned out to be the Workers *Free plan's 10ms CPU
// time per invocation* (discovered via wrangler tail showing "outcome":
// "exceededCpu" on nearly every 2-minute tick), not the 50-subrequest cap -
// resolveEvent() does 2-3 fetches + HTML/JSON parses each, and parsing
// hyrox.com's large marketing pages is the expensive part (fetch() I/O
// wait is free, but parsing large pages three times per event isn't).
// A batch of 10 (worse, up to 20 with the retry below) reliably blew the
// budget and got silently killed mid-batch, so most 2-minute ticks did
// nothing at all. Kept small so a tick reliably finishes.
const SALE_STATUS_BATCH_SIZE = 4;

export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  WEBHOOK_SECRET: string;
  APIFY_API_TOKEN: string;
  SEND_FROM: string;
  SITE_URL: string;
  ADMIN_EMAIL: string;
}

interface TrackedTicket {
  event_name: string;
  ticket_name: string;
  shop_url: string;
  event_id: string;
  status: "available" | "sold_out";
  event_date?: string | null;
}

const SESSION_COOKIE = "rra_session";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function encodeTicket(t: TrackedTicket): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(t))));
}

function decodeTicket(s: string): TrackedTicket | null {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("Cookie") || "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key) cookies[key] = part.slice(idx + 1).trim();
  }
  return cookies;
}

/** The session cookie is just the subscriber's existing unsubscribe_token -
 * same access level a clicked email link already grants (view/edit which
 * free ticket alerts an email is subscribed to). No separate session store. */
async function getSessionSubscriber(req: Request, env: Env): Promise<any | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return (
    (await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>()) || null
  );
}

function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function sendEmail(env: Env, to: string, subject: string, html: string, text: string) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: env.SEND_FROM, to: [to], subject, html, text }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend send failed: ${resp.status} ${body}`);
  }
}

/** Email every verified subscriber watching this exact (event_name, ticket_name). */
async function notifySubscribers(env: Env, eventName: string, ticketName: string, link: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token FROM subscribers s
     JOIN subscriptions sub ON sub.subscriber_id = s.id
     WHERE s.verified = 1 AND sub.event_name = ? AND sub.ticket_name = ?`
  )
    .bind(eventName, ticketName)
    .all<any>();

  let sent = 0;
  for (const row of results || []) {
    const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${row.unsubscribe_token}`;
    const unsubLink = `${env.SITE_URL}/unsubscribe?token=${row.unsubscribe_token}`;
    try {
      await sendEmail(
        env,
        row.email,
        `Ticket available: ${ticketName}`,
        `<p><b>${escapeHtml(eventName)}</b><br>${escapeHtml(ticketName)} is now available.</p><p><a href="${link}">${link}</a></p><p><small><a href="${myAlertsLink}">Manage my alerts</a> &middot; <a href="${unsubLink}">Unsubscribe from everything</a></small></p>`,
        `${eventName}\n${ticketName} is now available.\n${link}\n\nManage my alerts: ${myAlertsLink}\nUnsubscribe from everything: ${unsubLink}`
      );
      sent++;
    } catch (e) {
      console.error(`Failed to email ${row.email}:`, e);
    }
  }
  return sent;
}

function page(title: string, body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1a1a1a;background:#fafafa}
h1{font-size:1.5rem}
h2{font-size:1.1rem;margin-top:0}
.card{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:24px;margin-top:16px}
label{display:block;margin:10px 0;font-size:0.95rem}
input[type=email],input[type=text]{width:100%;padding:10px;font-size:1rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin-top:6px}
button{background:#111;color:#fff;border:0;border-radius:6px;padding:12px 20px;font-size:1rem;cursor:pointer;margin-top:16px}
button:hover{background:#333}
.row{display:flex;gap:8px;align-items:flex-start}
.row input{margin-top:0}
.row button{margin-top:0;white-space:nowrap}
small{color:#666}
a{color:#111}
.consent{font-size:0.85rem;color:#555;margin-top:14px}
#resolveResult{margin-top:12px}
#resolveResult p{color:#666;font-size:0.9rem}
.urlWrap{position:relative;flex:1}
.suggestions{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #ccc;border-top:0;border-radius:0 0 6px 6px;max-height:220px;overflow-y:auto;z-index:10}
.suggestions div{padding:8px 10px;cursor:pointer;font-size:0.9rem}
.suggestions div:hover{background:#f0f0f0}
.ticket-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee}
.ticket-row:last-child{border-bottom:0}
.ticket-row form{margin:0}
.ticket-row button{margin:0;background:#fff;color:#b00;border:1px solid #e2b3b3;padding:6px 12px;font-size:0.85rem}
.ticket-row button:hover{background:#fee}
details.browse{margin-top:16px}
details.browse summary{cursor:pointer;list-style:none}
details.browse summary::-webkit-details-marker{display:none}
.browse-toggle{display:flex;justify-content:space-between;align-items:center;background:#f5f5f5;border:1px solid #ddd;border-radius:8px;padding:14px 16px;font-size:1rem;font-weight:600}
.browse-toggle:hover{background:#eee}
.browse-toggle .chev{transition:transform 0.15s}
details.browse[open] .browse-toggle .chev{transform:rotate(90deg)}
.event-list{margin-top:10px}
.event-group h3{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.03em;color:#555;margin:16px 0 4px}
.event-group:first-child h3{margin-top:6px}
.event-group-rows{max-height:280px;overflow-y:auto;border:1px solid #eee;border-radius:8px}
.event-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #eee;cursor:pointer;font-size:0.9rem}
.event-row:last-child{border-bottom:0}
.event-row:hover{background:#f7f7f7}
.event-badge{font-size:0.75rem;padding:2px 8px;border-radius:10px;white-space:nowrap}
.event-badge.on{background:#e6f4ea;color:#1e7e34}
.event-badge.off{background:#f1f1f1;color:#777}
</style></head>
<body><h1>RoxRaceAlerts</h1>${body}
<p><small>Independent HYROX ticket-availability alerts. Not affiliated with HYROX or vivenu.</small></p>
</body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Every page can vary by session cookie or contain another
        // subscriber's email/tickets (e.g. after /verify, /my-alerts) -
        // must never be cached at the edge or shared across visitors.
        "cache-control": "private, no-store",
        ...extraHeaders,
      },
    }
  );
}

const RESOLVE_SCRIPT = `<script>
(function() {
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  var input = document.getElementById('urlInput');
  var out = document.getElementById('resolveResult');
  var suggestions = document.getElementById('suggestions');

  async function doFind(url) {
    url = url.trim();
    if (!url) return;
    suggestions.innerHTML = '';
    out.innerHTML = '<p>Looking...</p>';
    try {
      var resp = await fetch('/resolve?url=' + encodeURIComponent(url));
      var data = await resp.json();
      if (!resp.ok || !data.tickets || !data.tickets.length) {
        if (data.not_on_sale) {
          // Not a native <form> here - this already lives inside the page's
          // main <form>, and HTML forms can't nest. Submitted via fetch()
          // instead, from the click handler wired up right below.
          out.innerHTML = '<p><b>' + esc(data.event_title) + '</b>: tickets aren\\'t on sale yet.</p>' +
            '<div class="row">' +
            '<input type="email" id="saleEmail" placeholder="you@example.com">' +
            '<button type="button" id="saleBtn">Notify me when on sale</button>' +
            '</div>';
          document.getElementById('saleBtn').addEventListener('click', async function() {
            var emailInput = document.getElementById('saleEmail');
            var email = emailInput.value.trim();
            if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
              out.innerHTML = '<p>Please enter a valid email address.</p>';
              return;
            }
            out.innerHTML = '<p>Submitting...</p>';
            try {
              var fd = new FormData();
              fd.set('event_url', url);
              fd.set('event_title', data.event_title);
              fd.set('event_date', data.event_date || '');
              fd.set('email', email);
              var subResp = await fetch('/watch-sale', { method: 'POST', body: fd });
              if (subResp.redirected) {
                // Already-verified subscriber - server set the session
                // cookie and redirected home; follow it for real so the
                // page actually shows "Signed in as ...".
                window.location.href = subResp.url;
              } else if (subResp.ok) {
                out.innerHTML = '<p>Almost done - we\\'ve sent a confirmation link to your email. Click it to start receiving alerts.</p>';
              } else {
                out.innerHTML = '<p>Something went wrong. Try again.</p>';
              }
            } catch (e) {
              out.innerHTML = '<p>Something went wrong. Try again.</p>';
            }
          });
        } else {
          out.innerHTML = '<p>' + esc(data.error || 'Could not find tickets for that page. Double check the URL.') + '</p>';
        }
        return;
      }
      var html = '<p><b>' + esc(data.event_name) + '</b></p>';
      for (var i = 0; i < data.tickets.length; i++) {
        var t = data.tickets[i];
        html += '<label><input type="checkbox" name="ticket" value="' + esc(t.encoded) + '"> [' + esc(t.status.toUpperCase()) + '] ' + esc(t.name) + '</label>';
      }
      out.innerHTML = html;
    } catch (e) {
      out.innerHTML = '<p>Something went wrong. Try again.</p>';
    }
  }

  document.getElementById('findBtn').addEventListener('click', function() {
    doFind(input.value);
  });

  var debounceTimer;
  input.addEventListener('input', function() {
    clearTimeout(debounceTimer);
    var q = input.value.trim();
    if (q.length < 2 || /^https?:\\/\\//i.test(q)) {
      suggestions.innerHTML = '';
      return;
    }
    debounceTimer = setTimeout(async function() {
      try {
        var resp = await fetch('/search-events?q=' + encodeURIComponent(q));
        var data = await resp.json();
        if (!data.results || !data.results.length) {
          suggestions.innerHTML = '';
          return;
        }
        var html = '';
        for (var i = 0; i < data.results.length; i++) {
          html += '<div data-url="' + esc(data.results[i].url) + '">' + esc(data.results[i].title) + '</div>';
        }
        suggestions.innerHTML = html;
      } catch (e) {
        suggestions.innerHTML = '';
      }
    }, 250);
  });

  suggestions.addEventListener('click', function(e) {
    var url = e.target.getAttribute('data-url');
    if (!url) return;
    input.value = url;
    suggestions.innerHTML = '';
    doFind(url);
  });

  document.addEventListener('click', function(e) {
    if (e.target !== input) suggestions.innerHTML = '';
  });

  var browseDetails = document.getElementById('browseEvents');
  var eventList = document.getElementById('eventList');
  var eventsLoaded = false;
  if (browseDetails && eventList) {
    async function loadEvents() {
      if (eventsLoaded) return;
      eventsLoaded = true;
      try {
        var resp = await fetch('/events');
        var data = await resp.json();
        if (!data.results || !data.results.length) {
          eventList.innerHTML = '<p>No events found.</p>';
          return;
        }
        function rowHtml(ev) {
          var dateLabel = ev.event_date || 'Date TBA';
          var badge = ev.on_sale
            ? '<span class="event-badge on">On sale</span>'
            : '<span class="event-badge off">Not on sale</span>';
          return '<div class="event-row" data-url="' + esc(ev.url) + '"><span>' + esc(dateLabel) + ' &mdash; ' + esc(ev.title) + '</span>' + badge + '</div>';
        }
        function groupHtml(title, rows) {
          if (!rows.length) return '';
          return '<div class="event-group"><h3>' + esc(title) + ' (' + rows.length + ')</h3>' +
            '<div class="event-group-rows">' + rows.map(rowHtml).join('') + '</div></div>';
        }
        var onSale = data.results.filter(function(ev) { return ev.on_sale; });
        var notOnSale = data.results.filter(function(ev) { return !ev.on_sale; });
        eventList.innerHTML = groupHtml('On sale now', onSale) + groupHtml('Not on sale yet', notOnSale);
      } catch (e) {
        eventList.innerHTML = '<p>Something went wrong loading events.</p>';
      }
    }
    if (browseDetails.open) loadEvents();
    browseDetails.addEventListener('toggle', function() {
      if (browseDetails.open) loadEvents();
    });
    eventList.addEventListener('click', function(e) {
      var row = e.target.closest ? e.target.closest('.event-row') : null;
      if (!row) return;
      var url = row.getAttribute('data-url');
      if (!url) return;
      input.value = url;
      browseDetails.open = false;
      doFind(url);
    });
  }
})();
</script>`;

interface ActivePast {
  active: string;
  past: string;
}

function splitByEventDate<T extends { event_date?: string | null }>(rows: T[]): { active: T[]; past: T[] } {
  const today = todayIso();
  const active: T[] = [];
  const past: T[] = [];
  for (const r of rows) {
    (r.event_date && r.event_date < today ? past : active).push(r);
  }
  return { active, past };
}

function pastEventsSection(pastTickets: string, pastSales: string): string {
  if (!pastTickets && !pastSales) return "";
  return `<div class="card">
    <h2>Past events</h2>
    ${pastTickets}
    ${pastSales}
  </div>`;
}

async function renderTicketRows(subscriberId: number, token: string, env: Env): Promise<ActivePast> {
  const { results } = await env.DB.prepare(
    "SELECT id, event_name, ticket_name, event_date FROM subscriptions WHERE subscriber_id = ? ORDER BY event_date IS NULL, event_date, event_name, ticket_name"
  )
    .bind(subscriberId)
    .all<any>();
  const { active, past } = splitByEventDate(results || []);
  const render = (rows: any[], emptyMsg?: string) => {
    const html = rows
      .map(
        (r: any) => `<div class="ticket-row">
      <span>${escapeHtml(r.event_name)} &mdash; ${escapeHtml(r.ticket_name)}</span>
      <form method="POST" action="/remove-subscription">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="hidden" name="subscription_id" value="${r.id}">
        <button type="submit">Remove</button>
      </form>
    </div>`
      )
      .join("");
    return html || (emptyMsg ? `<p>${emptyMsg}</p>` : "");
  };
  return { active: render(active, "No active subscriptions yet."), past: render(past) };
}

async function renderSaleWatchRows(subscriberId: number, token: string, env: Env): Promise<ActivePast> {
  const { results } = await env.DB.prepare(
    `SELECT w.id, sw.event_title, sw.resolved, sw.event_date FROM sale_watchers w
     JOIN sale_watch sw ON sw.event_url = w.event_url
     WHERE w.subscriber_id = ? ORDER BY sw.event_date IS NULL, sw.event_date, sw.event_title`
  )
    .bind(subscriberId)
    .all<any>();
  const { active, past } = splitByEventDate(results || []);
  const render = (rows: any[], emptyMsg?: string) => {
    const html = rows
      .map(
        (r: any) => `<div class="ticket-row">
      <span>${escapeHtml(r.event_title)} - ${r.resolved ? "on sale, alert sent" : "not yet on sale"}</span>
      <form method="POST" action="/remove-sale-watch">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="hidden" name="watcher_id" value="${r.id}">
        <button type="submit">Remove</button>
      </form>
    </div>`
      )
      .join("");
    return html || (emptyMsg ? `<p>${emptyMsg}</p>` : "");
  };
  return { active: render(active, "None yet."), past: render(past) };
}

async function handleSignupPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const announcements = await renderAnnouncementsBanner(env);

  const findForm = `<div class="row">
      <div class="urlWrap">
        <input type="text" id="urlInput" placeholder="Type a city (e.g. Geneva) or paste an event URL" autocomplete="off">
        <div id="suggestions" class="suggestions"></div>
      </div>
      <button type="button" id="findBtn">Find tickets</button>
    </div>
    <div id="resolveResult"></div>
    <details class="browse" id="browseEvents" open>
      <summary class="browse-toggle">All HYROX races &mdash; on sale and upcoming <span class="chev">&#9656;</span></summary>
      <div id="eventList" class="event-list"><p>Loading...</p></div>
    </details>`;

  if (subscriber) {
    const rows = await renderTicketRows(subscriber.id, subscriber.unsubscribe_token, env);
    const saleRows = await renderSaleWatchRows(subscriber.id, subscriber.unsubscribe_token, env);
    return page(
      "RoxRaceAlerts",
      `${announcements}
      <div class="card">
        <p>Signed in as <b>${escapeHtml(subscriber.email)}</b> &middot; <a href="/sign-out">Not you? Sign out</a></p>
        <h2>Your watched tickets</h2>
        ${rows.active}
        <h2>Waiting for tickets to go on sale</h2>
        ${saleRows.active}
      </div>
      ${pastEventsSection(rows.past, saleRows.past)}
      <div class="card">
        <h2>Add another ticket</h2>
        <form method="POST" action="/subscribe" id="signupForm">
          ${findForm}
          <button type="submit">Add selected ticket(s)</button>
        </form>
      </div>
      ${RESOLVE_SCRIPT}`
    );
  }

  return page(
    "Get notified when sold-out HYROX tickets become available",
    `${announcements}
    <div class="card">
      <p>Free alerts the moment a sold-out ticket type becomes available again. Paste the HYROX event page you care about, pick your ticket(s), enter your email, confirm it, done.</p>
      <form method="POST" action="/subscribe" id="signupForm">
        ${findForm}
        <label>Your email
          <input type="email" name="email" required placeholder="you@example.com">
        </label>
        <p class="consent">By subscribing you agree to receive ticket-availability emails for the event(s) selected above. You can unsubscribe at any time, or manage exactly what you're watching, via the links in every email. We don't share your email with anyone.</p>
        <button type="submit">Subscribe</button>
      </form>
    </div>
    <div class="card">
      <p>Already subscribed? <a href="#" id="showLogin">Email me a sign-in link</a></p>
      <form method="POST" action="/login" id="loginForm" style="display:none">
        <div class="row">
          <input type="email" name="email" required placeholder="you@example.com">
          <button type="submit">Send link</button>
        </div>
      </form>
    </div>
    <script>
    document.getElementById('showLogin').addEventListener('click', function(e) {
      e.preventDefault();
      this.style.display = 'none';
      document.getElementById('loginForm').style.display = 'block';
    });
    </script>
    ${RESOLVE_SCRIPT}`
  );
}

/** All JSON API responses go through here - ticket/event status can change
 * from one check to the next, so none of it may ever be cached at the edge
 * (the same lesson as page()'s Cache-Control, applied to the JSON side). */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}

async function handleResolve(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url).searchParams.get("url") || "";
  if (!isFetchableUrl(url)) {
    return jsonResponse({ error: "Please enter a valid http(s) URL." }, 400);
  }
  // Looked up by the original marketing URL (event_directory's key), not the
  // vivenu shop URL resolveEvent() finds - carried along so a subscriber's
  // watches can later tell whether their event's date has passed.
  const known = await env.DB.prepare("SELECT title, event_date FROM event_directory WHERE url = ?").bind(url).first<any>();

  const found = await resolveEvent(url);
  if (!found) {
    // Page loaded fine, just no vivenu shop live yet - most likely tickets
    // simply haven't gone on sale, not a broken URL.
    return jsonResponse(
      {
        error: "Could not find an active vivenu shop on that page - tickets may not be on sale yet.",
        not_on_sale: true,
        event_title: known ? known.title : url,
        event_date: known ? known.event_date : null,
      },
      404
    );
  }
  const tickets = found.event.tickets.map((t) => {
    const status = ticketStatus(t);
    const encoded = encodeTicket({
      event_name: found.event.name,
      ticket_name: t.name,
      shop_url: found.shopUrl,
      event_id: found.event._id,
      status,
      event_date: known ? known.event_date : null,
    });
    return { name: t.name, status, encoded };
  });
  return jsonResponse({ event_name: found.event.name, tickets });
}

interface SubscriberLookup {
  subscriber: any;
  needsVerification: boolean;
  verifyToken: string;
}

/** Shared by handleSubscribe and handleWatchSale: use the session if there
 * is one, otherwise look up/create a subscriber by the submitted email,
 * same verification-gating either way. Returns a Response directly if the
 * email was missing/invalid, so callers can just `return` it. */
async function getOrCreateSubscriber(req: Request, env: Env, form: FormData): Promise<SubscriberLookup | Response> {
  let subscriber = await getSessionSubscriber(req, env);
  let needsVerification = false;
  let verifyToken = "";

  if (!subscriber) {
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return page("Invalid email", `<div class="card"><p>That doesn't look like a valid email address. <a href="/">Go back</a></p></div>`);
    }
    subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<any>();
    verifyToken = randomToken();
    const unsubToken = subscriber ? subscriber.unsubscribe_token : randomToken();

    if (!subscriber) {
      await env.DB.prepare(
        "INSERT INTO subscribers (email, verified, verify_token, unsubscribe_token) VALUES (?, 0, ?, ?)"
      )
        .bind(email, verifyToken, unsubToken)
        .run();
      subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<any>();
      needsVerification = true;
    } else if (!subscriber.verified) {
      await env.DB.prepare("UPDATE subscribers SET verify_token = ? WHERE id = ?").bind(verifyToken, subscriber.id).run();
      needsVerification = true;
    }
  }

  return { subscriber, needsVerification, verifyToken };
}

async function sendVerificationEmail(env: Env, subscriber: any, verifyToken: string): Promise<Response> {
  const link = `${env.SITE_URL}/verify?token=${verifyToken}`;
  await sendEmail(
    env,
    subscriber.email,
    "Confirm your RoxRaceAlerts subscription",
    `<p>Click to confirm you want ticket-availability alerts:</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
    `Confirm your subscription: ${link}\n\nIf you didn't request this, ignore this email.`
  );
  return page(
    "Check your email",
    `<div class="card"><p>Almost done — we've sent a confirmation link to <b>${escapeHtml(
      subscriber.email
    )}</b>. Click it to start receiving alerts.</p></div>`
  );
}

/** Redirect to the homepage with the session cookie set - used whenever an
 * action completes for an already-verified subscriber, so the browser lands
 * on the personalized "Signed in as ..." view instead of a static
 * confirmation page that doesn't visibly reflect being logged in. */
function redirectHome(env: Env, unsubscribeToken: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${env.SITE_URL}/`, "Set-Cookie": sessionCookieHeader(unsubscribeToken) },
  });
}

async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const ticketValues = form.getAll("ticket").map(String);
  if (ticketValues.length === 0) {
    return page("Pick a ticket", `<div class="card"><p>Please select at least one ticket to watch. <a href="/">Go back</a></p></div>`);
  }

  const result = await getOrCreateSubscriber(req, env, form);
  if (result instanceof Response) return result;
  const { subscriber, needsVerification, verifyToken } = result;

  for (const val of ticketValues) {
    const t = decodeTicket(val);
    if (!t) continue;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO subscriptions (subscriber_id, event_name, ticket_name, shop_url, event_date) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(subscriber.id, t.event_name, t.ticket_name, t.shop_url, t.event_date || null)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO community_tickets (event_id, event_name, ticket_name, shop_url, last_status, event_date) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(t.event_id, t.event_name, t.ticket_name, t.shop_url, t.status || "sold_out", t.event_date || null)
      .run();
  }

  if (needsVerification) {
    return sendVerificationEmail(env, subscriber, verifyToken);
  }

  return redirectHome(env, subscriber.unsubscribe_token);
}

async function handleWatchSale(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const eventUrl = String(form.get("event_url") || "").trim();
  const eventTitle = String(form.get("event_title") || eventUrl).trim();
  const eventDate = String(form.get("event_date") || "").trim() || null;
  if (!isFetchableUrl(eventUrl)) {
    return page("Something went wrong", `<div class="card"><p>That didn't work - go back and try again.</p></div>`);
  }

  const result = await getOrCreateSubscriber(req, env, form);
  if (result instanceof Response) return result;
  const { subscriber, needsVerification, verifyToken } = result;

  await env.DB.prepare("INSERT OR IGNORE INTO sale_watch (event_url, event_title, event_date) VALUES (?, ?, ?)")
    .bind(eventUrl, eventTitle, eventDate)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO sale_watchers (subscriber_id, event_url) VALUES (?, ?)")
    .bind(subscriber.id, eventUrl)
    .run();

  if (needsVerification) {
    return sendVerificationEmail(env, subscriber, verifyToken);
  }

  return redirectHome(env, subscriber.unsubscribe_token);
}

async function handleVerify(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE verify_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Invalid or expired link", `<div class="card"><p>This confirmation link is invalid or already used.</p></div>`);
  }
  await env.DB.prepare("UPDATE subscribers SET verified = 1, verify_token = NULL WHERE id = ?").bind(subscriber.id).run();
  return page(
    "Confirmed",
    `<div class="card"><p>You're confirmed! You'll get an email the moment your selected ticket(s) become available.</p><p><a href="/">Manage my alerts</a></p></div>`,
    { "Set-Cookie": sessionCookieHeader(subscriber.unsubscribe_token) }
  );
}

async function handleUnsubscribe(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This unsubscribe link is invalid.</p></div>`);
  }
  await env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(subscriber.id).run();
  return page(
    "Unsubscribed",
    `<div class="card"><p>You've been unsubscribed from all alerts. Sorry to see you go.</p></div>`,
    { "Set-Cookie": clearSessionCookieHeader() }
  );
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ? AND verified = 1")
      .bind(email)
      .first<any>();
    if (subscriber) {
      const link = `${env.SITE_URL}/my-alerts?token=${subscriber.unsubscribe_token}`;
      await sendEmail(
        env,
        email,
        "Your RoxRaceAlerts sign-in link",
        `<p>Click to sign in and manage your alerts:</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
        `Sign in: ${link}\n\nIf you didn't request this, ignore this email.`
      );
    }
  }

  // Same response whether or not the email is registered - don't leak who's subscribed.
  return page(
    "Check your email",
    `<div class="card"><p>If that email is subscribed, we've sent a sign-in link to it.</p></div>`
  );
}

async function handleMyAlerts(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  }
  const rows = await renderTicketRows(subscriber.id, token, env);
  const saleRows = await renderSaleWatchRows(subscriber.id, token, env);
  return page(
    "My alerts",
    `<div class="card">
      <p>Signed in as <b>${escapeHtml(subscriber.email)}</b> &middot; <a href="/sign-out">Not you? Sign out</a></p>
      <h2>Your watched tickets</h2>
      ${rows.active}
      <h2>Waiting for tickets to go on sale</h2>
      ${saleRows.active}
    </div>
    ${pastEventsSection(rows.past, saleRows.past)}
    <div class="card">
      <p><a href="/">Home</a> &middot; <a href="/">Add another ticket</a> &middot; <a href="/unsubscribe?token=${escapeHtml(token)}">Unsubscribe from everything</a></p>
    </div>`,
    { "Set-Cookie": sessionCookieHeader(token) }
  );
}

async function handleRemoveSubscription(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const subscriptionId = String(form.get("subscription_id") || "");

  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  }
  await env.DB.prepare("DELETE FROM subscriptions WHERE id = ? AND subscriber_id = ?")
    .bind(subscriptionId, subscriber.id)
    .run();

  return new Response(null, {
    status: 303,
    headers: { Location: `${env.SITE_URL}/my-alerts?token=${token}`, "Set-Cookie": sessionCookieHeader(token) },
  });
}

async function handleRemoveSaleWatch(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const watcherId = String(form.get("watcher_id") || "");

  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  }
  await env.DB.prepare("DELETE FROM sale_watchers WHERE id = ? AND subscriber_id = ?")
    .bind(watcherId, subscriber.id)
    .run();

  return new Response(null, {
    status: 303,
    headers: { Location: `${env.SITE_URL}/my-alerts?token=${token}`, "Set-Cookie": sessionCookieHeader(token) },
  });
}

function handleSignOut(env: Env): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${env.SITE_URL}/`, "Set-Cookie": clearSessionCookieHeader() },
  });
}

async function handleNotify(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { event_name, ticket_name, link } = await req.json<any>();
  if (!event_name || !ticket_name) {
    return new Response("Missing event_name/ticket_name", { status: 400 });
  }
  const sent = await notifySubscribers(env, event_name, ticket_name, link);
  return jsonResponse({ sent });
}

/** Cron Trigger entry point: re-check every community-requested ticket and
 * fan out alerts on sold_out -> available. Every subscription flows through
 * here (there's no separate curated list on the public site). */
async function checkCommunityTickets(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM community_tickets WHERE event_date IS NULL OR event_date >= ?"
  )
    .bind(todayIso())
    .all<any>();
  for (const row of results || []) {
    const event = await getEventData(row.event_id, row.shop_url);
    if (!event) continue;
    const ticket = event.tickets.find((t) => t.name === row.ticket_name);
    if (!ticket) continue;
    const newStatus = ticketStatus(ticket);

    if (row.last_status === "sold_out" && newStatus === "available") {
      await notifySubscribers(env, row.event_name, row.ticket_name, row.shop_url);
    }
    if (newStatus !== row.last_status) {
      await env.DB.prepare("UPDATE community_tickets SET last_status = ? WHERE id = ?").bind(newStatus, row.id).run();
    }
  }
}

/** Checked alongside checkCommunityTickets in the same 2-minute cron -
 * the number of not-yet-on-sale events being watched at once is expected to
 * be small, well under the 50-subrequest cap (unlike the 116-event sitemap
 * crawl, which needs its own batched daily job). */
async function checkSaleWatches(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM sale_watch WHERE resolved = 0 AND (event_date IS NULL OR event_date >= ?)"
  )
    .bind(todayIso())
    .all<any>();
  for (const row of results || []) {
    const found = await resolveEvent(row.event_url);
    if (!found) continue; // still not on sale

    await env.DB.prepare("UPDATE sale_watch SET resolved = 1, updated_at = datetime('now') WHERE event_url = ?")
      .bind(row.event_url)
      .run();

    const { results: watchers } = await env.DB.prepare(
      `SELECT s.email, s.unsubscribe_token FROM subscribers s
       JOIN sale_watchers w ON w.subscriber_id = s.id
       WHERE s.verified = 1 AND w.event_url = ?`
    )
      .bind(row.event_url)
      .all<any>();

    for (const watcher of watchers || []) {
      const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${watcher.unsubscribe_token}`;
      try {
        await sendEmail(
          env,
          watcher.email,
          `Tickets on sale now: ${row.event_title}`,
          `<p><b>${escapeHtml(row.event_title)}</b> tickets are now on sale!</p><p><a href="${row.event_url}">${row.event_url}</a></p><p>Come back to RoxRaceAlerts to pick specific tickets to watch for sold-out alerts too.</p><p><small><a href="${myAlertsLink}">Manage my alerts</a></small></p>`,
          `${row.event_title} tickets are now on sale!\n${row.event_url}\n\nCome back to RoxRaceAlerts to pick specific tickets to watch for sold-out alerts too.\n\nManage my alerts: ${myAlertsLink}`
        );
      } catch (e) {
        console.error(`Failed to email ${watcher.email}:`, e);
      }
    }
  }
}

/** Keeps the browsable homepage list's on-sale status fresh for *every*
 * known event, not just ones someone explicitly asked to be notified
 * about (that's sale_watch, unchanged, above). Once on_sale flips to true
 * it essentially never needs to flip back (a live shop doesn't disappear),
 * so unconfirmed (on_sale=0) events are checked first, soonest race date
 * first within that group - the ones someone's most likely checking on
 * roxracealerts.com right now. Confirmed on_sale=1 events only get
 * re-checked once the unconfirmed backlog is empty. */
async function refreshEventDirectorySaleStatus(env: Env): Promise<void> {
  const today = todayIso();
  const { results } = await env.DB.prepare(
    `SELECT url FROM event_directory
     WHERE (event_date IS NULL OR event_date >= ?)
     ORDER BY on_sale ASC, event_date IS NULL, event_date ASC, last_sale_check IS NOT NULL, last_sale_check ASC
     LIMIT ?`
  )
    .bind(today, SALE_STATUS_BATCH_SIZE)
    .all<any>();

  for (const row of results || []) {
    // resolveEvent() failing can mean "genuinely no shop live yet" or just a
    // transient fetch hiccup against hyrox.com/vivenu - retry once before
    // concluding "not on sale", since a false negative here persists until
    // this event's next rotation (~16 min) rather than self-correcting.
    let found = await resolveEvent(row.url);
    if (!found) found = await resolveEvent(row.url);
    await env.DB.prepare("UPDATE event_directory SET on_sale = ?, last_sale_check = datetime('now') WHERE url = ?")
      .bind(found ? 1 : 0, row.url)
      .run();
  }
}

// HYROX country/region Instagram accounts - tickets are usually announced
// here days to weeks before hyrox.com's own marketing pages get updated,
// so this catches the heads-up hyrox.com alone can't provide. Hardcoded
// rather than DB-managed since it changes rarely - edit and redeploy to
// add/remove an account.
const IG_HANDLES = [
  "hyroxworld", "hyroxamerica", "hyroxanz", "hyroxger", "hyroxbenelux",
  "hyroxbrasil", "hyroxca", "hyroxchina", "hyroxnordic", "hyroxme",
  "hyroxbaltics", "hyrox.france", "hyroxgreece", "hyroxhk", "hyroxindia",
  "hyroxuk", "hyroxitalia", "hyroxjapan", "hyroxkor", "hyroxmx",
  "hyroxpoland", "hyroxesp", "hyroxsg", "hyroxsa", "hyroxsui", "hyroxtw",
  "hyroxtha", "hyroxegp",
];

const IG_SALE_KEYWORDS = [
  "ticket sale", "tickets are live", "tickets on sale", "on sale now",
  "sales are live", "secret shop", "pre-sale", "presale", "ticket launch",
  "tickets are now live", "registration is live", "registration opens",
];

interface ApifyPost {
  ownerUsername?: string;
  // Instagram's "Collab" feature makes one post appear on multiple
  // profiles at once - ownerUsername is just the primary author, everyone
  // else who co-posted shows up here instead. A tracked account's latest
  // post is often a collab it didn't "own", so both fields need checking.
  coauthorProducers?: { username?: string }[];
  id?: string;
  shortCode?: string;
  url?: string;
  caption?: string;
  timestamp?: string;
}

/** Asks Apify's Instagram Post Scraper (a paid third-party scraping service,
 * not something we run ourselves - Instagram aggressively blocks direct
 * automated access) for each tracked account's single latest post, in one
 * HTTP call covering all handles. All the actual scraping/anti-bot work
 * happens on Apify's infrastructure - this Worker just parses a small JSON
 * response, so it's cheap CPU-wise (unlike resolveEvent()'s HTML parsing). */
async function fetchLatestInstagramPosts(env: Env): Promise<ApifyPost[]> {
  const resp = await fetch(
    "https://api.apify.com/v2/acts/apify~instagram-post-scraper/run-sync-get-dataset-items?token=" +
      encodeURIComponent(env.APIFY_API_TOKEN),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: IG_HANDLES,
        // "1 = the single latest post" turned out not to be reliable -
        // verified live that consecutive calls can return an older post
        // Apify still had cached instead of the true latest, with no
        // isPinned flag to explain it. Pulling a few and picking the
        // numerically highest post id (see checkInstagramAnnouncements)
        // is immune to that instead of trusting result order.
        resultsLimit: 3,
        dataDetailLevel: "basicData",
      }),
    }
  );
  if (!resp.ok) {
    console.error(`Apify request failed: ${resp.status} ${await resp.text()}`);
    return [];
  }
  return (await resp.json()) as ApifyPost[];
}

/** Daily check (see the "0 8 * * *" cron below) - flags new posts whose
 * caption mentions a ticket sale for admin review at /admin/ig-posts.
 * Never auto-publishes: keyword matching alone isn't reliable enough (a
 * caption could mention "tickets" for something unrelated), so a human
 * approves before anything shows up publicly. */
const IG_HANDLES_LOWER = new Set(IG_HANDLES.map((h) => h.toLowerCase()));

/** Instagram media ids are monotonically increasing numeric strings (newer
 * posts always have a bigger id), which is a much more reliable "is this
 * actually new" check than trusting which post the API handed back first -
 * verified live that a repeat call can resurface an older post with no
 * explanation. Falls back to simple inequality for the rare non-numeric id
 * (e.g. a shortCode used because `id` was missing). */
function isPostIdNewer(candidateId: string, knownId: string | null): boolean {
  if (knownId === null) return true;
  if (/^\d+$/.test(candidateId) && /^\d+$/.test(knownId)) return BigInt(candidateId) > BigInt(knownId);
  return candidateId !== knownId;
}

async function checkInstagramAnnouncements(env: Env): Promise<void> {
  const posts = await fetchLatestInstagramPosts(env);
  let flaggedCount = 0;

  // Snapshot existing watch state once, upfront - otherwise, since Apify
  // now returns a few recent posts per profile instead of just one, the
  // "have we ever checked this handle" determination could flip mid-run as
  // soon as the first post for a brand-new handle gets recorded.
  const { results: existingRows } = await env.DB.prepare("SELECT handle, last_post_id FROM ig_watch").all<any>();
  const knownLastPostId = new Map<string, string>((existingRows || []).map((r: any) => [r.handle, r.last_post_id]));
  // Highest post id seen per handle *this run* - persisted once at the end
  // rather than as we go, so out-of-order results within the same batch
  // (or duplicate handle matches via Collab coauthors) can't clobber a
  // newer id already found earlier in the loop.
  const maxSeenThisRun = new Map<string, string>();

  for (const post of posts) {
    const postId = post.id || post.shortCode;
    if (!postId) continue;

    // A post can legitimately belong to more than one tracked account at
    // once (a Collab between two country pages), and Apify doesn't tell us
    // which of our input usernames produced this result - so match against
    // our known list via owner + coauthors rather than trusting response
    // order. Anything not in our list is ignored outright (Apify has
    // occasionally returned an untracked account via fuzzy-match fallback).
    const candidates = [post.ownerUsername, ...(post.coauthorProducers || []).map((c) => c.username)].filter(
      (u): u is string => !!u
    );
    const matchedHandles = candidates.filter((u) => IG_HANDLES_LOWER.has(u.toLowerCase()));

    for (const handle of matchedHandles) {
      const isFirstCheck = !knownLastPostId.has(handle);
      const priorBest = maxSeenThisRun.get(handle) ?? knownLastPostId.get(handle) ?? null;
      const isNewer = isPostIdNewer(postId, priorBest);
      if (isNewer) maxSeenThisRun.set(handle, postId);

      // Never flag anything the first time we've ever checked a handle -
      // that just establishes the baseline - and never flag a post we've
      // already seen (or an older one Apify happened to resurface).
      if (isFirstCheck || !isNewer) continue;

      const caption = (post.caption || "").toLowerCase();
      const matched = IG_SALE_KEYWORDS.find((kw) => caption.includes(kw));
      if (!matched) continue;

      const postUrl = post.url || `https://www.instagram.com/p/${post.shortCode}/`;
      await env.DB.prepare(
        `INSERT INTO ig_flagged_posts (handle, post_id, post_url, caption, matched_keyword, posted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(handle, post_id) DO NOTHING`
      )
        .bind(handle, postId, postUrl, post.caption || "", matched, post.timestamp || null)
        .run();
      flaggedCount++;
    }
  }

  // Persist the new high-water mark for every handle touched this run
  // (including first-time accounts, whose baseline this establishes).
  for (const [handle, postId] of maxSeenThisRun) {
    await env.DB.prepare(
      `INSERT INTO ig_watch (handle, last_post_id, last_checked_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(handle) DO UPDATE SET last_post_id = excluded.last_post_id, last_checked_at = excluded.last_checked_at`
    )
      .bind(handle, postId)
      .run();
  }

  if (flaggedCount > 0 && env.ADMIN_EMAIL) {
    const reviewLink = `${env.SITE_URL}/admin/ig-posts?token=${env.WEBHOOK_SECRET}`;
    try {
      await sendEmail(
        env,
        env.ADMIN_EMAIL,
        `${flaggedCount} new HYROX Instagram post(s) to review`,
        `<p>${flaggedCount} new Instagram post(s) mentioned a ticket sale. Review and publish: <a href="${reviewLink}">${reviewLink}</a></p>`,
        `${flaggedCount} new Instagram post(s) mentioned a ticket sale.\nReview and publish: ${reviewLink}`
      );
    } catch (e) {
      console.error("Failed to send admin IG digest email:", e);
    }
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .trim();
}

/** Batched indexing job: crawl a slice of hyrox.com's event sitemap each run
 * (missing or >7-days-stale entries first) and cache each page's title, so
 * visitors can search by city name instead of pasting a URL. Deliberately
 * bounded (INDEX_BATCH_SIZE) to stay well under Cloudflare's free-plan cap
 * of 50 outbound subrequests per invocation - converges to a full index
 * over a handful of runs, then just keeps entries fresh. */
const MONTH_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** HYROX event marketing pages show the race's start date in a
 * "event_date_1"-classed element, e.g. "23. Sep. 2026" - confirmed
 * consistent across every event page checked (Milan, Rome, Rio). Returns
 * ISO YYYY-MM-DD, or null if the page doesn't have a parseable date. */
function parseEventDate(html: string): string | null {
  const fieldMatch = html.match(/event_date_1[^>]*>\s*<span class="w-post-elm-value">([^<]+)</i);
  if (!fieldMatch) return null;
  const dateMatch = fieldMatch[1].match(/(\d{1,2})\.\s*([A-Za-z]+)\.?\s*(\d{4})/);
  if (!dateMatch) return null;
  const [, day, monthAbbr, year] = dateMatch;
  const month = MONTH_ABBR[monthAbbr.slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function indexEvents(env: Env): Promise<number> {
  let sitemapXml: string;
  try {
    const resp = await fetch(SITEMAP_URL, { headers: HEADERS });
    if (!resp.ok) return 0;
    sitemapXml = await resp.text();
  } catch {
    return 0;
  }

  const urls = Array.from(sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1].trim());
  if (urls.length === 0) return 0;

  const staleCutoff = new Date(Date.now() - INDEX_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { results: existing } = await env.DB.prepare("SELECT url, updated_at FROM event_directory").all<any>();
  const existingMap = new Map((existing || []).map((r: any) => [r.url, r.updated_at]));

  const toIndex = urls.filter((u) => !existingMap.has(u) || (existingMap.get(u) as string) < staleCutoff).slice(0, INDEX_BATCH_SIZE);

  let indexed = 0;
  for (const url of toIndex) {
    try {
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) continue;
      const html = await resp.text();
      const m = html.match(/<title>([^<]+)<\/title>/i);
      if (!m) continue;
      const title = decodeHtmlEntities(m[1]).replace(/\s*\|\s*HYROX\s*$/i, "").trim();
      if (!title) continue;
      const eventDate = parseEventDate(html);
      await env.DB.prepare(
        `INSERT INTO event_directory (url, title, event_date, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(url) DO UPDATE SET title = excluded.title, event_date = excluded.event_date, updated_at = excluded.updated_at`
      )
        .bind(url, title, eventDate)
        .run();
      indexed++;
    } catch (e) {
      console.error(`Failed to index ${url}:`, e);
    }
  }
  return indexed;
}

async function handleSearchEvents(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 2) {
    return jsonResponse({ results: [] });
  }
  const { results } = await env.DB.prepare(
    "SELECT url, title FROM event_directory WHERE title LIKE ? ORDER BY title LIMIT 8"
  )
    .bind(`%${q}%`)
    .all<any>();
  return jsonResponse({ results: results || [] });
}

/** Full browsable list for the homepage dropdown: every not-yet-passed
 * event, sorted by race date, with the cached on-sale status kept fresh by
 * refreshEventDirectorySaleStatus(). Undated entries (date not parsed yet)
 * sort last rather than being hidden, since they're still real events. */
async function handleListEvents(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT url, title, event_date, on_sale FROM event_directory
     WHERE event_date IS NULL OR event_date >= ?
     ORDER BY event_date IS NULL, event_date, title`
  )
    .bind(todayIso())
    .all<any>();
  return jsonResponse({ results: results || [] });
}

/** Manual trigger for the indexing job (same bearer-secret pattern as
 * /notify) - lets a batch be run on demand instead of waiting for the daily
 * schedule, e.g. to bring a fresh event_directory up to speed quickly. */
async function handleReindex(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const indexed = await indexEvents(env);
  return jsonResponse({ indexed });
}

/** Manual trigger for refreshEventDirectorySaleStatus, same pattern as
 * /admin/reindex - useful for testing without waiting on the real cron. */
async function handleRefreshSaleStatus(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  await refreshEventDirectorySaleStatus(env);
  return jsonResponse({ ok: true });
}

/** Manual trigger for checkInstagramAnnouncements, same pattern as
 * /admin/reindex - useful for testing without waiting on the daily cron. */
async function handleCheckInstagram(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  await checkInstagramAnnouncements(env);
  return jsonResponse({ ok: true });
}


/** Renders the last few admin-approved Instagram announcements for the
 * homepage - a lightweight "heads up" banner, separate from the browsable
 * event list's own on_sale status (which reflects the actual vivenu shop,
 * not a social-media post). Returns "" when there's nothing to show. */
async function renderAnnouncementsBanner(env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    "SELECT handle, post_url, banner_text, detected_at FROM ig_flagged_posts WHERE status = 'approved' ORDER BY detected_at DESC LIMIT 5"
  ).all<any>();
  if (!results || !results.length) return "";
  const rows = results
    .map(
      (r: any) => `<div class="ticket-row">
      <span>${escapeHtml(r.banner_text || r.handle)}</span>
      <a href="${escapeHtml(r.post_url)}" target="_blank" rel="noopener">View post</a>
    </div>`
    )
    .join("");
  return `<div class="card"><h2>Recent ticket-sale news</h2>${rows}</div>`;
}

/** Admin-only review queue for posts checkInstagramAnnouncements() flagged -
 * keyword matching alone can false-positive (a caption could mention
 * "tickets" for something unrelated), so nothing here reaches the public
 * homepage until approved. Uses the token-in-URL pattern (like
 * unsubscribe/my-alerts links) rather than a Bearer header, since this page
 * is meant to be opened in a normal browser, not called programmatically. */
async function handleIgAdminPage(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

  const { results } = await env.DB.prepare(
    "SELECT id, handle, post_url, caption, matched_keyword, detected_at FROM ig_flagged_posts WHERE status = 'pending' ORDER BY detected_at DESC"
  ).all<any>();

  const rows = (results || [])
    .map((r: any) => {
      const suggested = `${r.handle} just posted about tickets - check it out`;
      return `<div class="card">
        <p><b>@${escapeHtml(r.handle)}</b> &middot; matched "${escapeHtml(r.matched_keyword)}" &middot; <a href="${escapeHtml(r.post_url)}" target="_blank" rel="noopener">View on Instagram</a></p>
        <p><small>${escapeHtml(r.caption || "")}</small></p>
        <form method="POST" action="/admin/ig-posts/publish">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="id" value="${r.id}">
          <label>Banner text
            <input type="text" name="banner_text" value="${escapeHtml(suggested)}">
          </label>
          <div class="row">
            <button type="submit">Publish to homepage</button>
          </div>
        </form>
        <form method="POST" action="/admin/ig-posts/dismiss">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="id" value="${r.id}">
          <button type="submit">Dismiss</button>
        </form>
      </div>`;
    })
    .join("");

  return page("Instagram posts to review", rows || "<div class=\"card\"><p>Nothing pending.</p></div>", {
    "cache-control": "private, no-store",
  });
}

async function handleIgPublish(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const id = String(form.get("id") || "");
  const bannerText = String(form.get("banner_text") || "");
  await env.DB.prepare("UPDATE ig_flagged_posts SET status = 'approved', banner_text = ? WHERE id = ?")
    .bind(bannerText, id)
    .run();
  return Response.redirect(`${env.SITE_URL}/admin/ig-posts?token=${encodeURIComponent(token)}`, 303);
}

async function handleIgDismiss(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const id = String(form.get("id") || "");
  await env.DB.prepare("UPDATE ig_flagged_posts SET status = 'dismissed' WHERE id = ?").bind(id).run();
  return Response.redirect(`${env.SITE_URL}/admin/ig-posts?token=${encodeURIComponent(token)}`, 303);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/" && req.method === "GET") return await handleSignupPage(req, env);
      if (url.pathname === "/resolve" && req.method === "GET") return await handleResolve(req, env);
      if (url.pathname === "/subscribe" && req.method === "POST") return await handleSubscribe(req, env);
      if (url.pathname === "/login" && req.method === "POST") return await handleLogin(req, env);
      if (url.pathname === "/watch-sale" && req.method === "POST") return await handleWatchSale(req, env);
      if (url.pathname === "/verify" && req.method === "GET") return await handleVerify(req, env);
      if (url.pathname === "/unsubscribe" && req.method === "GET") return await handleUnsubscribe(req, env);
      if (url.pathname === "/my-alerts" && req.method === "GET") return await handleMyAlerts(req, env);
      if (url.pathname === "/remove-subscription" && req.method === "POST") return await handleRemoveSubscription(req, env);
      if (url.pathname === "/remove-sale-watch" && req.method === "POST") return await handleRemoveSaleWatch(req, env);
      if (url.pathname === "/sign-out" && req.method === "GET") return handleSignOut(env);
      if (url.pathname === "/notify" && req.method === "POST") return await handleNotify(req, env);
      if (url.pathname === "/search-events" && req.method === "GET") return await handleSearchEvents(req, env);
      if (url.pathname === "/events" && req.method === "GET") return await handleListEvents(env);
      if (url.pathname === "/admin/reindex" && req.method === "POST") return await handleReindex(req, env);
      if (url.pathname === "/admin/refresh-sale-status" && req.method === "POST") return await handleRefreshSaleStatus(req, env);
      if (url.pathname === "/admin/check-instagram" && req.method === "POST") return await handleCheckInstagram(req, env);
      if (url.pathname === "/admin/ig-posts" && req.method === "GET") return await handleIgAdminPage(req, env);
      if (url.pathname === "/admin/ig-posts/publish" && req.method === "POST") return await handleIgPublish(req, env);
      if (url.pathname === "/admin/ig-posts/dismiss" && req.method === "POST") return await handleIgDismiss(req, env);
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      console.error(e);
      return new Response(`Internal error: ${e.message}`, { status: 500 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Three schedules share this Worker (see wrangler.toml): the frequent
    // one checks tickets, one indexes the event directory daily, and one
    // checks Instagram for new ticket-sale announcements daily.
    if (event.cron === "*/2 * * * *") {
      ctx.waitUntil(checkCommunityTickets(env));
      ctx.waitUntil(checkSaleWatches(env));
      ctx.waitUntil(refreshEventDirectorySaleStatus(env));
    } else if (event.cron === "0 8 * * *") {
      ctx.waitUntil(checkInstagramAnnouncements(env));
    } else {
      ctx.waitUntil(indexEvents(env).then(() => undefined));
    }
  },
};
