import { resolveEvent, getEventData, ticketStatus, isFetchableUrl, HEADERS } from "./resolve";

const SITEMAP_URL = "https://hyrox.com/event-sitemap.xml";
const INDEX_BATCH_SIZE = 30;
const INDEX_STALE_DAYS = 7;

export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  WEBHOOK_SECRET: string;
  SEND_FROM: string;
  SITE_URL: string;
}

interface TrackedTicket {
  event_name: string;
  ticket_name: string;
  shop_url: string;
  event_id: string;
  status: "available" | "sold_out";
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
        out.innerHTML = '<p>' + esc(data.error || 'Could not find tickets for that page. Double check the URL.') + '</p>';
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
})();
</script>`;

async function renderTicketRows(subscriberId: number, token: string, env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    "SELECT id, event_name, ticket_name FROM subscriptions WHERE subscriber_id = ? ORDER BY event_name, ticket_name"
  )
    .bind(subscriberId)
    .all<any>();
  return (
    (results || [])
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
      .join("") || "<p>No active subscriptions yet.</p>"
  );
}

async function handleSignupPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);

  const findForm = `<div class="row">
      <div class="urlWrap">
        <input type="text" id="urlInput" placeholder="Type a city (e.g. Geneva) or paste an event URL" autocomplete="off">
        <div id="suggestions" class="suggestions"></div>
      </div>
      <button type="button" id="findBtn">Find tickets</button>
    </div>
    <div id="resolveResult"></div>`;

  if (subscriber) {
    const rows = await renderTicketRows(subscriber.id, subscriber.unsubscribe_token, env);
    return page(
      "RoxRaceAlerts",
      `<div class="card">
        <p>Signed in as <b>${escapeHtml(subscriber.email)}</b> &middot; <a href="/sign-out">Not you? Sign out</a></p>
        <h2>Your watched tickets</h2>
        ${rows}
      </div>
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
    `<div class="card">
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

async function handleResolve(req: Request): Promise<Response> {
  const url = new URL(req.url).searchParams.get("url") || "";
  if (!isFetchableUrl(url)) {
    return new Response(JSON.stringify({ error: "Please enter a valid http(s) URL." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const found = await resolveEvent(url);
  if (!found) {
    return new Response(JSON.stringify({ error: "Could not find a HYROX/vivenu event on that page." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const tickets = found.event.tickets.map((t) => {
    const status = ticketStatus(t);
    const encoded = encodeTicket({
      event_name: found.event.name,
      ticket_name: t.name,
      shop_url: found.shopUrl,
      event_id: found.event._id,
      status,
    });
    return { name: t.name, status, encoded };
  });
  return new Response(JSON.stringify({ event_name: found.event.name, tickets }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const ticketValues = form.getAll("ticket").map(String);
  if (ticketValues.length === 0) {
    return page("Pick a ticket", `<div class="card"><p>Please select at least one ticket to watch. <a href="/">Go back</a></p></div>`);
  }

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

  for (const val of ticketValues) {
    const t = decodeTicket(val);
    if (!t) continue;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO subscriptions (subscriber_id, event_name, ticket_name, shop_url) VALUES (?, ?, ?, ?)"
    )
      .bind(subscriber.id, t.event_name, t.ticket_name, t.shop_url)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO community_tickets (event_id, event_name, ticket_name, shop_url, last_status) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(t.event_id, t.event_name, t.ticket_name, t.shop_url, t.status || "sold_out")
      .run();
  }

  if (needsVerification) {
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

  return page("Subscribed", `<div class="card"><p>Added. <a href="/">Manage my alerts</a></p></div>`, {
    "Set-Cookie": sessionCookieHeader(subscriber.unsubscribe_token),
  });
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
  return page(
    "My alerts",
    `<div class="card">
      <p>Signed in as <b>${escapeHtml(subscriber.email)}</b></p>
      <h2>Your watched tickets</h2>
      ${rows}
    </div>
    <div class="card">
      <p><a href="/unsubscribe?token=${escapeHtml(token)}">Unsubscribe from everything</a> &middot; <a href="/">Add another ticket</a></p>
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
  return new Response(JSON.stringify({ sent }), { headers: { "content-type": "application/json" } });
}

/** Cron Trigger entry point: re-check every community-requested ticket and
 * fan out alerts on sold_out -> available. Every subscription flows through
 * here (there's no separate curated list on the public site). */
async function checkCommunityTickets(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM community_tickets").all<any>();
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
      await env.DB.prepare(
        `INSERT INTO event_directory (url, title, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(url) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
      )
        .bind(url, title)
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
    return new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } });
  }
  const { results } = await env.DB.prepare(
    "SELECT url, title FROM event_directory WHERE title LIKE ? ORDER BY title LIMIT 8"
  )
    .bind(`%${q}%`)
    .all<any>();
  return new Response(JSON.stringify({ results: results || [] }), {
    headers: { "content-type": "application/json" },
  });
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
  return new Response(JSON.stringify({ indexed }), { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/" && req.method === "GET") return await handleSignupPage(req, env);
      if (url.pathname === "/resolve" && req.method === "GET") return await handleResolve(req);
      if (url.pathname === "/subscribe" && req.method === "POST") return await handleSubscribe(req, env);
      if (url.pathname === "/login" && req.method === "POST") return await handleLogin(req, env);
      if (url.pathname === "/verify" && req.method === "GET") return await handleVerify(req, env);
      if (url.pathname === "/unsubscribe" && req.method === "GET") return await handleUnsubscribe(req, env);
      if (url.pathname === "/my-alerts" && req.method === "GET") return await handleMyAlerts(req, env);
      if (url.pathname === "/remove-subscription" && req.method === "POST") return await handleRemoveSubscription(req, env);
      if (url.pathname === "/sign-out" && req.method === "GET") return handleSignOut(env);
      if (url.pathname === "/notify" && req.method === "POST") return await handleNotify(req, env);
      if (url.pathname === "/search-events" && req.method === "GET") return await handleSearchEvents(req, env);
      if (url.pathname === "/admin/reindex" && req.method === "POST") return await handleReindex(req, env);
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      console.error(e);
      return new Response(`Internal error: ${e.message}`, { status: 500 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two schedules share this Worker (see wrangler.toml): the frequent one
    // checks tickets, the infrequent one indexes the event directory.
    if (event.cron === "*/2 * * * *") {
      ctx.waitUntil(checkCommunityTickets(env));
    } else {
      ctx.waitUntil(indexEvents(env).then(() => undefined));
    }
  },
};
