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
  ANTHROPIC_API_KEY: string;
  SEND_FROM: string;
  SITE_URL: string;
  ADMIN_EMAIL: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
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

async function sendTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  if (!resp.ok) {
    console.error(`Telegram send failed: ${resp.status} ${await resp.text()}`);
  }
}

/** Mirrors an alert to Telegram, but only when it's addressed to the
 * site owner's own account (ADMIN_EMAIL) - other subscribers never get a
 * Telegram message, this is purely a personal secondary channel for the
 * owner's own watched tickets, alongside their regular alert email.
 * Failures are logged, never thrown - a missed Telegram ping shouldn't
 * fail the email send it's mirroring. */
async function notifyAdminTelegram(env: Env, recipientEmail: string, text: string): Promise<void> {
  if (!env.ADMIN_EMAIL || recipientEmail.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) return;
  try {
    await sendTelegram(env, text);
  } catch (e) {
    console.error("Failed to mirror alert to Telegram:", e);
  }
}

/** Email every verified subscriber watching this exact (event_name, ticket_name). */
async function notifySubscribers(env: Env, eventName: string, ticketName: string, link: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token FROM subscribers s
     JOIN subscriptions sub ON sub.subscriber_id = s.id
     WHERE s.verified = 1 AND sub.event_name = ? AND sub.ticket_name = ? AND sub.purchased_at IS NULL`
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
      await notifyAdminTelegram(env, row.email, `🎟️ ${eventName}\n${ticketName} is now available.\n${link}`);
      sent++;
    } catch (e) {
      console.error(`Failed to email ${row.email}:`, e);
    }
  }
  return sent;
}

function page(title: string, body: string, extraHeaders: Record<string, string> = {}, wide = false): Response {
  return new Response(
    `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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
.urlWrap input{padding-right:30px}
.clearX{position:absolute;right:4px;top:50%;transform:translateY(-50%);background:transparent;border:0;color:#888;font-size:1.2rem;line-height:1;cursor:pointer;padding:4px 8px;margin:0}
.clearX:hover{color:#111}
.suggestions{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #ccc;border-top:0;border-radius:0 0 6px 6px;max-height:220px;overflow-y:auto;z-index:10}
.suggestions div{padding:8px 10px;cursor:pointer;font-size:0.9rem}
.suggestions div:hover{background:#f0f0f0}
.ticket-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee}
.ticket-row:last-child{border-bottom:0}
.ticket-row form{margin:0}
.ticket-row button{margin:0;background:#fff;color:#b00;border:1px solid #e2b3b3;padding:6px 12px;font-size:0.85rem}
.ticket-row button:hover{background:#fee}
.ticket-row .buy-btn{color:#1e7e34;border-color:#bfe0c9}
.ticket-row .buy-btn:hover{background:#e6f4ea}
.verify-banner{background:#fff4e0;border:1px solid #ffe1a8;color:#7a5b00;padding:12px 16px;border-radius:8px;margin-top:16px;font-size:0.9rem}
.verify-banner p{margin:0}
.verify-banner p+p{margin-top:6px}
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
.event-badge{font-size:0.75rem;padding:2px 8px;border-radius:10px;white-space:nowrap;flex-shrink:0}
.event-badge.on{background:#e6f4ea;color:#1e7e34}
.event-badge.off{background:#f1f1f1;color:#777}
.event-badge.presale{background:#fff4e0;color:#9a6700}
.event-badge.soon{background:#e6eeff;color:#2851b8}
.event-subtitle{font-size:0.8rem;font-weight:600;color:#9a6700;margin-top:2px}
.event-race-date{font-size:0.7rem;color:#999;margin-top:2px}
.event-right{display:flex;align-items:center;gap:4px;flex-shrink:0}
.row-chev{color:#999}
.row-monitor{display:block;margin-top:4px;background:#fff;border:1px solid #ccc;border-radius:6px;padding:2px 8px;font-size:0.75rem;color:#111;cursor:pointer}
.row-monitor:hover{background:#f5f5f5}
.row-monitor:disabled{color:#1e7e34;border-color:#bfe0c9;cursor:default}
.nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding-bottom:12px;margin-bottom:4px;border-bottom:1px solid #e2e2e2;font-size:0.9rem}
.nav a{text-decoration:none;color:#555;font-weight:600}
.nav a.active{color:#111}
.nav-user{margin-left:auto;color:#666;font-size:0.85rem}
.nav-user a{font-weight:400;color:#111}
.nav-hint{font-size:0.75rem;color:#888;margin-top:4px;text-align:right}
body.wide{max-width:980px}
.layout{display:flex;gap:24px;align-items:flex-start}
.main-col{flex:0 0 640px;max-width:640px;min-width:0}
.sidebar{flex:0 0 300px;max-width:300px;display:flex;flex-direction:column;gap:16px}
.sidebar .event-row{flex-direction:column;align-items:flex-start;gap:4px}
.hero h2{font-size:1.6rem;margin:0 0 6px}
.hero-sub{color:#555;font-size:0.95rem;margin:0}
.hint{color:#555;font-size:0.9rem;margin-top:0}
@media (max-width:1000px){.layout{flex-direction:column}.main-col,.sidebar{flex:1 1 auto;max-width:none;width:100%}}
</style></head>
<body${wide ? ' class="wide"' : ""}><h1>RoxRaceAlerts</h1>${body}
<p><small>Independent HYROX ticket-availability alerts. Not affiliated with HYROX or vivenu. &middot; <a href="/feedback">Propose a feature or leave feedback</a></small></p>
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

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#111"/>
<path fill="#fff" d="M16 6.5c-.8 0-1.5.7-1.5 1.5v.6C11.4 9.4 9.5 12 9.5 15.2V20l-2 2.5v1h17v-1l-2-2.5v-4.8c0-3.2-1.9-5.8-5-6.6V8c0-.8-.7-1.5-1.5-1.5z"/>
<path fill="#fff" d="M13.2 24.5a2.8 2.8 0 0 0 5.6 0z"/>
</svg>`;

function handleFavicon(): Response {
  return new Response(FAVICON_SVG, {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
  });
}

function navBar(
  currentPath: "/" | "/my-alerts",
  subscriber: { email: string } | null,
  watchCount = 0,
  showSignIn = false
): string {
  const myAlertsLabel = watchCount > 0 ? `My Alerts (${watchCount})` : "My Alerts";
  const rightSlot = subscriber
    ? `<span class="nav-user" id="navSignedIn">Signed in as ${escapeHtml(subscriber.email)} &middot; <a href="/sign-out">Sign out</a></span>`
    : showSignIn
    ? `<span class="nav-user">
        <a href="#" id="navSignIn">Sign in</a>
        <form method="POST" action="/login" id="loginForm" class="row" style="display:none">
          <input type="email" name="email" required placeholder="you@example.com">
          <button type="submit">Send link</button>
        </form>
        <div class="nav-hint" id="loginHint" style="display:none">We'll email a sign-in link to the address you signed up with.</div>
      </span>`
    : "";
  return `<nav class="nav">
    <a href="/"${currentPath === "/" ? ' class="active"' : ""}>Home</a>
    <a href="/my-alerts"${currentPath === "/my-alerts" ? ' class="active"' : ""}>${myAlertsLabel}</a>
    ${rightSlot}
  </nav>
  <script>
  (function() {
    var navSignIn = document.getElementById('navSignIn');
    if (navSignIn) {
      navSignIn.addEventListener('click', function(e) {
        e.preventDefault();
        navSignIn.style.display = 'none';
        document.getElementById('loginForm').style.display = 'flex';
        document.getElementById('loginHint').style.display = 'block';
      });
    }
  })();
  </script>`;
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
  var clearX = document.getElementById('clearFindX');
  var browseDetails = document.getElementById('browseEvents');
  var submitBtn = document.querySelector('.submit-step');
  var signedIn = !!document.getElementById('navSignedIn');
  function updateClearX() {
    if (clearX) clearX.style.display = input.value.trim() ? 'block' : 'none';
  }
  if (clearX) {
    clearX.addEventListener('click', function(e) {
      e.preventDefault();
      out.innerHTML = '';
      input.value = '';
      suggestions.innerHTML = '';
      updateClearX();
      if (browseDetails) browseDetails.open = true;
      if (submitBtn) submitBtn.style.display = 'none';
      input.focus();
    });
  }

  async function doFind(url) {
    url = url.trim();
    if (!url) return;
    suggestions.innerHTML = '';
    out.innerHTML = '<p>Looking...</p>';
    updateClearX();
    if (submitBtn) submitBtn.style.display = 'none';
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
            (signedIn ? '' : '<input type="email" id="saleEmail" placeholder="you@example.com">') +
            '<button type="button" id="saleBtn">Notify me when on sale</button>' +
            '</div>';
          document.getElementById('saleBtn').addEventListener('click', async function() {
            var email = '';
            if (!signedIn) {
              var emailInput = document.getElementById('saleEmail');
              email = emailInput.value.trim();
              if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
                out.innerHTML = '<p>Please enter a valid email address.</p>';
                return;
              }
            }
            out.innerHTML = '<p>Submitting...</p>';
            try {
              var fd = new FormData();
              fd.set('event_url', url);
              fd.set('event_title', data.event_title);
              fd.set('event_date', data.event_date || '');
              if (email) fd.set('email', email);
              var subResp = await fetch('/watch-sale', { method: 'POST', body: fd });
              if (subResp.redirected) {
                // Already-verified subscriber - server set the session
                // cookie and redirected home; follow it for real so the
                // page actually shows "Signed in as ...".
                window.location.href = subResp.url;
              } else if (subResp.ok) {
                out.innerHTML = signedIn
                  ? '<p>Done - we\\'ll email you the moment tickets go on sale.</p>'
                  : '<p>Almost done - we\\'ve sent a confirmation link to your email. Click it to start receiving alerts.</p>';
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
      if (submitBtn) submitBtn.style.display = 'block';
    } catch (e) {
      out.innerHTML = '<p>Something went wrong. Try again.</p>';
    }
  }

  document.getElementById('findBtn').addEventListener('click', function() {
    doFind(input.value);
  });

  var debounceTimer;
  input.addEventListener('input', function() {
    updateClearX();
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

  var eventListMain = document.getElementById('eventList');
  var eventListSide = document.getElementById('eventListSide');
  var sideCard = document.getElementById('sideOnSaleCard');
  var eventsLoaded = false;

  function attachRowClicks(container) {
    if (!container) return;
    container.addEventListener('click', function(e) {
      if (e.target.closest && e.target.closest('.row-monitor')) return;
      var row = e.target.closest ? e.target.closest('.event-row') : null;
      if (!row) return;
      var url = row.getAttribute('data-url');
      if (!url) return;
      input.value = url;
      var details = row.closest('details');
      if (details) details.open = false;
      doFind(url);
    });
  }

  function wireMonitorButtons(container) {
    if (!container) return;
    container.addEventListener('click', function(e) {
      var btn = e.target.closest ? e.target.closest('.row-monitor') : null;
      if (!btn || btn.disabled) return;
      var url = btn.getAttribute('data-url');
      var title = btn.getAttribute('data-title');
      var date = btn.getAttribute('data-date');
      if (!signedIn) {
        input.value = url;
        if (browseDetails) browseDetails.open = false;
        doFind(url);
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Monitoring…';
      var fd = new FormData();
      fd.set('event_url', url);
      fd.set('event_title', title);
      fd.set('event_date', date || '');
      fetch('/watch-sale', { method: 'POST', body: fd }).then(function(resp) {
        if (resp.ok) {
          btn.textContent = '✓ Monitoring';
        } else {
          btn.disabled = false;
          btn.textContent = '+ Monitor';
        }
      }).catch(function() {
        btn.disabled = false;
        btn.textContent = '+ Monitor';
      });
    });
  }

  if (eventListMain || eventListSide) {
    async function loadEvents() {
      if (eventsLoaded) return;
      eventsLoaded = true;
      try {
        var resp = await fetch('/events');
        var data = await resp.json();
        if (!data.results || !data.results.length) {
          if (eventListMain) eventListMain.innerHTML = '<p>No events found.</p>';
          if (sideCard) sideCard.style.display = 'none';
          return;
        }
        function formatLocal(utcIso, tz) {
          try {
            return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: tz || 'UTC' }).format(new Date(utcIso));
          } catch (e) {
            return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: 'UTC' }).format(new Date(utcIso));
          }
        }
        function truncateText(s, max) {
          return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
        }
        function entriesFor(ev) {
          var out = [];
          if (ev.on_sale) {
            out.push({ section: 'on', badge: 'On sale', badgeClass: 'on', subtitle: '' });
          } else if (ev.presale_is_live) {
            out.push({ section: 'live', badge: 'Pre-sale (live now)', badgeClass: 'on', subtitle: truncateText(ev.presale_note || '', 55) });
          }
          if (!ev.on_sale && ev.presale_live_at) {
            out.push({ section: 'soon', badge: 'Public sale (soon live)', badgeClass: 'soon', subtitle: 'on ' + formatLocal(ev.presale_live_at, ev.presale_timezone) });
          }
          if (!out.length) out.push({ section: 'waiting', badge: 'Not on sale', badgeClass: 'off', subtitle: '' });
          return out;
        }
        function rowHtml(ev, entry) {
          var dateLabel = 'Race: ' + (ev.event_date || 'date TBA');
          var badge = '<span class="event-badge ' + entry.badgeClass + '">' + esc(entry.badge) + '</span>';
          var subtitle = entry.subtitle ? '<div class="event-subtitle">' + esc(entry.subtitle) + '</div>' : '';
          return '<div class="event-row" data-url="' + esc(ev.url) + '"><div><span>' + esc(dateLabel) + ' &mdash; ' + esc(ev.title) + '</span>' + subtitle + '</div><div class="event-right">' + badge + '<span class="row-chev">&#8250;</span></div></div>';
        }
        var URGENT_MS = 48 * 60 * 60 * 1000;
        function isUrgent(ev) {
          if (!ev.presale_live_at) return false;
          var diff = new Date(ev.presale_live_at).getTime() - Date.now();
          return diff >= 0 && diff <= URGENT_MS;
        }
        function sideRowHtml(ev, entry) {
          var badge = '<span class="event-badge ' + entry.badgeClass + '">' + esc(entry.badge) + '</span>';
          var saleLine = entry.subtitle
            ? '<div class="event-subtitle">' + (entry.section === 'soon' && isUrgent(ev) ? '🔥 ' : '') + esc(entry.subtitle) + '</div>'
            : '';
          var raceLine = '<div class="event-race-date">Race: ' + esc(ev.event_date || 'date TBA') + '</div>';
          var monitorBtn = entry.section === 'soon'
            ? '<button type="button" class="row-monitor" data-url="' + esc(ev.url) + '" data-title="' + esc(ev.title) + '" data-date="' + esc(ev.event_date || '') + '">+ Monitor</button>'
            : '';
          return '<div class="event-row" data-url="' + esc(ev.url) + '"><div><span>' + esc(ev.title) + '</span>' + saleLine + raceLine + monitorBtn + '</div><div class="event-right">' + badge + '<span class="row-chev">&#8250;</span></div></div>';
        }
        function groupHtml(title, items, rowFn) {
          if (!items.length) return '';
          return '<div class="event-group"><h3>' + esc(title) + ' (' + items.length + ')</h3>' +
            '<div class="event-group-rows">' + items.map(function(x) { return rowFn(x.ev, x.entry); }).join('') + '</div></div>';
        }
        function byGoLive(a, b) {
          var ta = a.ev.presale_live_at ? new Date(a.ev.presale_live_at).getTime() : Infinity;
          var tb = b.ev.presale_live_at ? new Date(b.ev.presale_live_at).getTime() : Infinity;
          return ta - tb;
        }
        var bySection = { on: [], live: [], soon: [], waiting: [] };
        data.results.forEach(function(ev) {
          entriesFor(ev).forEach(function(entry) { bySection[entry.section].push({ ev: ev, entry: entry }); });
        });
        bySection.live.sort(byGoLive);
        bySection.soon.sort(byGoLive);
        if (eventListMain) {
          eventListMain.innerHTML = groupHtml('On sale now', bySection.on, rowHtml) + groupHtml('Not on sale yet', bySection.waiting, rowHtml);
        }
        if (eventListSide) {
          var sideHtml = groupHtml('Live now', bySection.live, sideRowHtml) + groupHtml('Going live soon', bySection.soon, sideRowHtml);
          eventListSide.innerHTML = sideHtml;
          if (sideCard) sideCard.style.display = sideHtml ? '' : 'none';
        }
      } catch (e) {
        if (eventListMain) eventListMain.innerHTML = '<p>Something went wrong loading events.</p>';
        if (sideCard) sideCard.style.display = 'none';
      }
    }
    loadEvents();
    if (browseDetails) {
      browseDetails.addEventListener('toggle', function() {
        if (browseDetails.open) loadEvents();
      });
    }
    attachRowClicks(eventListMain);
    attachRowClicks(eventListSide);
    wireMonitorButtons(eventListSide);
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

/** Cheap counts for the homepage's signed-in teaser card - just enough to
 * say "you're tracking N things" and link to /my-alerts, without paying for
 * the full renderTicketRows/renderSaleWatchRows joins + timezone formatting
 * on every homepage load. */
async function getWatchCounts(subscriberId: number, env: Env): Promise<{ tickets: number; races: number }> {
  const t = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber_id = ?").bind(subscriberId).first<any>();
  const w = await env.DB.prepare("SELECT COUNT(*) AS n FROM sale_watchers WHERE subscriber_id = ?").bind(subscriberId).first<any>();
  return { tickets: t?.n || 0, races: w?.n || 0 };
}

function pastEventsSection(pastTickets: string, pastSales: string): string {
  if (!pastTickets && !pastSales) return "";
  return `<div class="card">
    <h2>Past events</h2>
    ${pastTickets}
    ${pastSales}
  </div>`;
}

async function renderTicketRows(subscriberId: number, token: string, env: Env): Promise<ActivePast & { purchased: string }> {
  const { results } = await env.DB.prepare(
    "SELECT id, event_name, ticket_name, event_date, purchased_at FROM subscriptions WHERE subscriber_id = ? ORDER BY event_date IS NULL, event_date, event_name, ticket_name"
  )
    .bind(subscriberId)
    .all<any>();
  const rows = results || [];
  const purchasedRows = rows.filter((r: any) => r.purchased_at);
  const { active, past } = splitByEventDate(rows.filter((r: any) => !r.purchased_at));
  const render = (rows: any[], emptyMsg?: string, showBuyButton?: boolean) => {
    const html = rows
      .map(
        (r: any) => `<div class="ticket-row">
      <span>${escapeHtml(r.event_name)} &mdash; ${escapeHtml(r.ticket_name)}</span>
      <div class="row" style="gap:6px">
        ${
          showBuyButton
            ? `<form method="POST" action="/mark-purchased">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="subscription_id" value="${r.id}">
          <button type="submit" class="buy-btn">I bought this</button>
        </form>`
            : ""
        }
        <form method="POST" action="/remove-subscription">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="subscription_id" value="${r.id}">
          <button type="submit">Remove</button>
        </form>
      </div>
    </div>`
      )
      .join("");
    return html || (emptyMsg ? `<p>${emptyMsg}</p>` : "");
  };
  return {
    active: render(active, "No active subscriptions yet.", true),
    past: render(past),
    purchased: render(purchasedRows),
  };
}

interface SaleWatchEntry {
  section: "live" | "soon" | "waiting";
  badge: string;
  badgeClass: "on" | "soon" | "off";
  subtitle: string;
}

/** A sale_watch row can produce up to two entries at once, not one status -
 * a pre-sale being live right now and a known future public-sale date are
 * two different facts, so they show as two separate lines (one in "Live
 * now", one in "Going live soon") rather than being squashed into a single
 * merged status line. Falls back to a single "Not yet on sale" entry when
 * nothing at all is known. */
function saleWatchEntries(row: {
  resolved: boolean;
  presale_is_live: boolean;
  presale_note: string | null;
  presale_live_at: string | null;
  presale_timezone: string | null;
}): SaleWatchEntry[] {
  const entries: SaleWatchEntry[] = [];
  if (row.resolved) {
    entries.push({ section: "live", badge: "On sale", badgeClass: "on", subtitle: "Alert sent" });
  } else if (row.presale_is_live) {
    entries.push({ section: "live", badge: "Pre-sale (live now)", badgeClass: "on", subtitle: row.presale_note || "" });
  }
  if (!row.resolved && row.presale_live_at) {
    const when = formatInTimezone(row.presale_live_at, row.presale_timezone);
    entries.push({ section: "soon", badge: "Public sale (soon live)", badgeClass: "soon", subtitle: `on ${when}` });
  }
  if (entries.length === 0) {
    entries.push({ section: "waiting", badge: "Not yet on sale", badgeClass: "off", subtitle: "" });
  }
  return entries;
}

interface SaleWatchSections {
  live: string;
  soon: string;
  waiting: string;
  past: string;
}

async function renderSaleWatchRows(subscriberId: number, token: string, env: Env): Promise<SaleWatchSections> {
  const { results } = await env.DB.prepare(
    `SELECT w.id, sw.event_title, sw.resolved, sw.event_date, sw.presale_note, sw.presale_live_at, sw.presale_timezone, sw.presale_is_live
     FROM sale_watchers w
     JOIN sale_watch sw ON sw.event_url = w.event_url
     WHERE w.subscriber_id = ? ORDER BY sw.event_date IS NULL, sw.event_date, sw.event_title`
  )
    .bind(subscriberId)
    .all<any>();
  const { active, past } = splitByEventDate(results || []);
  const rowHtml = (r: any, entry: SaleWatchEntry) => `<div class="ticket-row">
      <div><span>${escapeHtml(r.event_title)}</span>
      <span class="event-badge ${entry.badgeClass}">${escapeHtml(entry.badge)}</span>
      ${entry.subtitle ? `<div class="event-subtitle">${escapeHtml(entry.subtitle)}</div>` : ""}</div>
      <form method="POST" action="/remove-sale-watch">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="hidden" name="watcher_id" value="${r.id}">
        <button type="submit">Remove</button>
      </form>
    </div>`;
  const section = (rows: any[], sec: "live" | "soon" | "waiting") =>
    rows
      .flatMap((r: any) => saleWatchEntries(r).filter((e) => e.section === sec).map((e) => rowHtml(r, e)))
      .join("");
  return {
    live: section(active, "live"),
    soon: section(active, "soon"),
    waiting: section(active, "waiting"),
    past: past.flatMap((r: any) => saleWatchEntries(r).map((e) => rowHtml(r, e))).join(""),
  };
}

async function handleSignupPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const announcements = await renderAnnouncementsBanner(env);

  const searchBox = `<div class="row">
      <div class="urlWrap">
        <input type="text" id="urlInput" placeholder="Type a city (e.g. Geneva) or paste an event URL" autocomplete="off">
        <button type="button" id="clearFindX" class="clearX" title="Clear" style="display:none">&times;</button>
        <div id="suggestions" class="suggestions"></div>
      </div>
      <button type="button" id="findBtn">Find tickets</button>
    </div>
    <div id="resolveResult"></div>`;

  const browseSection = `<details class="browse" id="browseEvents" open>
      <summary class="browse-toggle">On sale now &amp; not on sale yet <span class="chev">&#9656;</span></summary>
      <div id="eventList" class="event-list"><p>Loading...</p></div>
    </details>`;

  const hero = `<div class="hero">
    <h2>Get HYROX Ticket Dates &amp; Alerts</h2>
    <p class="hero-sub">Free alerts for sold-out ticket types, pre-sales, and public sales going live &mdash; for any HYROX race, worldwide.</p>
  </div>`;

  const sideOnSaleCard = `<div class="card" id="sideOnSaleCard">
    <h2>Live &amp; upcoming sales</h2>
    <div id="eventListSide" class="event-list"><p>Loading...</p></div>
  </div>`;

  if (subscriber) {
    const counts = await getWatchCounts(subscriber.id, env);
    return page(
      "RoxRaceAlerts",
      `${navBar("/", subscriber, counts.tickets + counts.races)}
      <div class="layout">
        <div class="main-col">
          ${hero}
          <div class="card">
            <h2>Monitor race tickets</h2>
            <form method="POST" action="/subscribe" id="signupForm">
              ${searchBox}
              <button type="submit" class="submit-step" style="display:none">Add selected ticket(s)</button>
            </form>
            ${browseSection}
          </div>
        </div>
        <div class="sidebar">
          ${sideOnSaleCard}
          ${announcements}
        </div>
      </div>
      ${RESOLVE_SCRIPT}`,
      {},
      true
    );
  }

  return page(
    "Get notified when sold-out HYROX tickets become available",
    `${navBar("/", null, 0, true)}
    <div class="layout">
      <div class="main-col">
        ${hero}
        <div class="card">
          <h2>Monitor race tickets</h2>
          <p class="hint">Paste the HYROX event page you care about, pick your ticket(s), enter your email, confirm it, done.</p>
          <form method="POST" action="/subscribe" id="signupForm">
            ${searchBox}
            <div class="submit-step" style="display:none">
              <label>Your email
                <input type="email" name="email" required placeholder="you@example.com">
              </label>
              <p class="consent">By subscribing you agree to receive ticket-availability emails for the event(s) selected above. You can unsubscribe at any time, or manage exactly what you're watching, via the links in every email. We don't share your email with anyone.</p>
              <button type="submit">Subscribe</button>
            </div>
          </form>
          ${browseSection}
        </div>
      </div>
      <div class="sidebar">
        ${sideOnSaleCard}
        ${announcements}
      </div>
    </div>
    ${RESOLVE_SCRIPT}`,
    {},
    true
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

/** Sends the confirmation email and, since a session cookie normally only
 * gets set once a subscriber verifies, also signs the submitting browser in
 * right away (same unsubscribe_token session as a verified subscriber gets)
 * so it can immediately reach /my-alerts and see the "please confirm"
 * banner there too - not just on this one-time response page. */
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
    )}</b>. Click it to start receiving alerts. Don't see it? Check your spam folder.</p></div>`,
    { "Set-Cookie": sessionCookieHeader(subscriber.unsubscribe_token) }
  );
}

/** Runs once a day: nudges anyone who signed up 24h+ ago and still hasn't
 * clicked their confirmation link, since they otherwise have no idea their
 * watched tickets are silently not being monitored (see the verified-only
 * filters in checkCommunityTickets/checkSaleWatches). verify_token is never
 * cleared until they do verify, so it's safe to reuse here. nudge_sent_at
 * caps this at one email per subscriber, ever. */
async function sendVerificationNudges(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM subscribers
     WHERE verified = 0 AND nudge_sent_at IS NULL AND created_at <= datetime('now', '-1 day')`
  ).all<any>();

  for (const subscriber of results || []) {
    const link = `${env.SITE_URL}/verify?token=${subscriber.verify_token}`;
    await sendEmail(
      env,
      subscriber.email,
      "You're not getting alerts yet - confirm your subscription",
      `<p>You signed up for RoxRaceAlerts but never confirmed your email, so we haven't been able to send you any ticket-availability alerts.</p><p>Click to confirm:</p><p><a href="${link}">${link}</a></p><p>If you don't confirm, we won't be able to alert you at all. If you didn't request this, just ignore this email.</p>`,
      `You signed up for RoxRaceAlerts but never confirmed your email, so we haven't been able to send you any alerts.\n\nConfirm here: ${link}\n\nIf you don't confirm, we won't be able to alert you at all. If you didn't request this, ignore this email.`
    );
    await env.DB.prepare("UPDATE subscribers SET nudge_sent_at = datetime('now') WHERE id = ?").bind(subscriber.id).run();
  }
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
    `<div class="card"><p>You're confirmed! You'll get an email the moment your selected ticket(s) become available.</p><p><a href="/my-alerts">Manage my alerts</a></p></div>`,
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

/** Token-based entry point from emails - verifies the token, signs the
 * browser in via the session cookie, then hands off to the homepage, which
 * already renders everything a signed-in visitor needs (watched tickets,
 * sale watches, announcements, browse list) and is the only place that
 * view is maintained, so this never drifts out of sync with it again. */
async function handleMyAlerts(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token) {
    const subscriber = await env.DB.prepare("SELECT id FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
    if (!subscriber) {
      return page("Not found", `${navBar("/my-alerts", null, 0, true)}<div class="card"><p>This link is invalid.</p></div>`);
    }
    // Drop the token from the URL once it's become a session cookie, so it
    // doesn't linger in browser history/bookmarks.
    return new Response(null, {
      status: 303,
      headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) },
    });
  }

  const subscriber = await getSessionSubscriber(req, env);
  if (!subscriber) {
    return page(
      "My Alerts",
      `${navBar("/my-alerts", null, 0, true)}
      <div class="card">
        <p>You're not signed in. Use "Sign in" above, or go to the <a href="/">homepage</a> to search for tickets.</p>
      </div>`
    );
  }

  const rows = await renderTicketRows(subscriber.id, subscriber.unsubscribe_token, env);
  const saleRows = await renderSaleWatchRows(subscriber.id, subscriber.unsubscribe_token, env);
  const counts = await getWatchCounts(subscriber.id, env);
  const saleSections: string[] = [];
  if (saleRows.live) saleSections.push(`<h2>Live now</h2>${saleRows.live}`);
  if (saleRows.soon) saleSections.push(`<h2>Going live soon</h2>${saleRows.soon}`);
  if (saleRows.waiting || saleSections.length === 0) {
    saleSections.push(`<h2>Waiting for tickets to go on sale</h2>${saleRows.waiting || "<p>None yet.</p>"}`);
  }
  const verifyBanner = subscriber.verified
    ? ""
    : `<div class="verify-banner">
      <p><b>Confirm your email to start receiving alerts</b> — until you do, nothing below is actually being checked.</p>
      <p>We sent a confirmation link to ${escapeHtml(subscriber.email)}. Don't see it? Check your spam folder.</p>
    </div>`;

  return page(
    "My Alerts",
    `${navBar("/my-alerts", subscriber, counts.tickets + counts.races)}
    ${verifyBanner}
    <div class="card">
      <h2>Your watched tickets</h2>
      ${rows.active}
      ${saleSections.join("\n")}
    </div>
    ${rows.purchased ? `<div class="card"><h2>Purchased</h2>${rows.purchased}</div>` : ""}
    ${pastEventsSection(rows.past, saleRows.past)}
    <div class="card">
      <p>Want to track another ticket? <a href="/">Search on the homepage</a>.</p>
    </div>
    <div class="card">
      <p><a href="/unsubscribe?token=${escapeHtml(subscriber.unsubscribe_token)}">Unsubscribe from everything</a></p>
    </div>`
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
    headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) },
  });
}

async function handleMarkPurchased(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const subscriptionId = String(form.get("subscription_id") || "");

  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  }
  await env.DB.prepare("UPDATE subscriptions SET purchased_at = datetime('now') WHERE id = ? AND subscriber_id = ?")
    .bind(subscriptionId, subscriber.id)
    .run();

  return new Response(null, {
    status: 303,
    headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) },
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
    headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) },
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
  // Skip anything nobody verified actually wants anymore - an unverified
  // signup shouldn't consume a checking slot until they confirm, and once
  // every verified subscriber has marked it bought there's no one left to
  // alert either.
  const { results } = await env.DB.prepare(
    `SELECT ct.* FROM community_tickets ct
     WHERE (ct.event_date IS NULL OR ct.event_date >= ?)
       AND EXISTS (
         SELECT 1 FROM subscriptions sub JOIN subscribers s ON s.id = sub.subscriber_id
         WHERE s.verified = 1 AND sub.event_name = ct.event_name AND sub.ticket_name = ct.ticket_name AND sub.purchased_at IS NULL
       )`
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
  // Same reasoning as checkCommunityTickets - don't spend a checking slot
  // on a race nobody verified is actually waiting to hear about.
  const { results } = await env.DB.prepare(
    `SELECT sw.* FROM sale_watch sw
     WHERE sw.resolved = 0 AND (sw.event_date IS NULL OR sw.event_date >= ?)
       AND EXISTS (
         SELECT 1 FROM sale_watchers w JOIN subscribers s ON s.id = w.subscriber_id
         WHERE s.verified = 1 AND w.event_url = sw.event_url
       )`
  )
    .bind(todayIso())
    .all<any>();
  for (const row of results || []) {
    const found = await resolveEvent(row.event_url);
    if (!found) continue; // still not on sale

    // Clear any Instagram-derived presale info too - the real shop is live
    // now, so the "pre-sale live" / "going live soon" lines are stale info
    // and would otherwise linger next to the real "on sale" status.
    await env.DB.prepare(
      `UPDATE sale_watch SET resolved = 1, updated_at = datetime('now'),
       presale_note = NULL, presale_live_at = NULL, presale_timezone = NULL, presale_is_live = 0
       WHERE event_url = ?`
    )
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
        await notifyAdminTelegram(env, watcher.email, `🎟️ ${row.event_title} tickets are now on sale!\n${row.event_url}`);
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
    // Once the real shop is confirmed live, clear any Instagram-derived
    // presale info too - it's stale next to the real "on sale" status.
    await env.DB.prepare(
      found
        ? `UPDATE event_directory SET on_sale = 1, last_sale_check = datetime('now'),
           presale_note = NULL, presale_live_at = NULL, presale_timezone = NULL, presale_is_live = 0
           WHERE url = ?`
        : "UPDATE event_directory SET on_sale = 0, last_sale_check = datetime('now') WHERE url = ?"
    )
      .bind(row.url)
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

const IG_HANDLES_LOWER = new Set(IG_HANDLES.map((h) => h.toLowerCase()));

/** Sends a plain-English summary of a matched Instagram post - including
 * which known event it's about, if identifiable - to everyone watching that
 * event's real ticket shop. Reused by the daily auto-check and by manually
 * re-publishing a dismissed post. Deliberately doesn't touch
 * sale_watch.resolved: an Instagram pre-sale (e.g. a gym-only early-access
 * link) isn't the same as the real public sale being live, so
 * checkSaleWatches keeps polling independently. */
async function notifySaleWatchers(env: Env, eventUrl: string, bannerText: string, postUrl: string): Promise<void> {
  const eventRow = await env.DB.prepare("SELECT event_title FROM sale_watch WHERE event_url = ?").bind(eventUrl).first<any>();
  if (!eventRow) return;
  const { results: watchers } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token FROM subscribers s
     JOIN sale_watchers w ON w.subscriber_id = s.id
     WHERE s.verified = 1 AND w.event_url = ?`
  )
    .bind(eventUrl)
    .all<any>();

  for (const watcher of watchers || []) {
    const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${watcher.unsubscribe_token}`;
    const eventTitle = eventRow.event_title;
    try {
      await sendEmail(
        env,
        watcher.email,
        `Instagram update on ${eventTitle} tickets`,
        `<p><b>${escapeHtml(eventTitle)}</b>: ${escapeHtml(bannerText)}</p><p><a href="${escapeHtml(postUrl)}">${escapeHtml(postUrl)}</a></p><p><small>This may not be the full public sale yet - check the post for details. We'll still alert you the moment the shop itself is live.</small></p><p><small><a href="${myAlertsLink}">Manage my alerts</a></small></p>`,
        `${eventTitle}: ${bannerText}\n${postUrl}\n\nThis may not be the full public sale yet - check the post for details. We'll still alert you the moment the shop itself is live.\n\nManage my alerts: ${myAlertsLink}`
      );
      await notifyAdminTelegram(env, watcher.email, `📣 ${eventTitle}: ${bannerText}\n${postUrl}`);
    } catch (e) {
      console.error(`Failed to email ${watcher.email}:`, e);
    }
  }
}

async function sendCountdownReminder(
  env: Env,
  eventUrl: string,
  label: string,
  liveAtUtc: string,
  liveAtTimezone: string | null,
  postUrl: string
): Promise<void> {
  const eventRow = await env.DB.prepare("SELECT event_title FROM sale_watch WHERE event_url = ?").bind(eventUrl).first<any>();
  if (!eventRow) return;
  const { results: watchers } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token FROM subscribers s
     JOIN sale_watchers w ON w.subscriber_id = s.id
     WHERE s.verified = 1 AND w.event_url = ?`
  )
    .bind(eventUrl)
    .all<any>();

  const eventTitle = eventRow.event_title;
  const liveAtLabel = formatInTimezone(liveAtUtc, liveAtTimezone);
  for (const watcher of watchers || []) {
    const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${watcher.unsubscribe_token}`;
    try {
      await sendEmail(
        env,
        watcher.email,
        `${eventTitle} tickets: ${label}`,
        `<p><b>${escapeHtml(eventTitle)}</b> ${escapeHtml(label)} (expected around ${escapeHtml(liveAtLabel)}).</p><p><a href="${escapeHtml(postUrl)}">${escapeHtml(postUrl)}</a></p><p><small>This is a best-effort estimate from an Instagram post, not a guarantee - we'll still alert you the moment the actual shop is live.</small></p><p><small><a href="${myAlertsLink}">Manage my alerts</a></small></p>`,
        `${eventTitle} ${label} (expected around ${liveAtLabel}).\n${postUrl}\n\nThis is a best-effort estimate, not a guarantee - we'll still alert you the moment the actual shop is live.\n\nManage my alerts: ${myAlertsLink}`
      );
      await notifyAdminTelegram(env, watcher.email, `⏰ ${eventTitle} ${label} (expected around ${liveAtLabel}).\n${postUrl}`);
    } catch (e) {
      console.error(`Failed to email reminder to ${watcher.email}:`, e);
    }
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

/** Fires countdown reminders (1 day / 1 hour / 5 minutes before) for any
 * announcement whose caption gave a specific expected go-live time -
 * dispatched from the same 2-minute Cron Trigger as the ticket checks, so
 * the 5-minute window is never missed by more than a couple of minutes.
 * Each threshold is a one-shot flag on the row, so a tick that's already
 * past a threshold just skips it rather than re-sending. If the whole
 * thing is more than 6 hours overdue (e.g. after extended downtime), marks
 * the reminder sent without emailing - a stale countdown isn't useful. */
async function checkAnnouncementReminders(env: Env): Promise<void> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, event_url, post_url, live_at_utc, live_at_timezone, reminder_1d_sent, reminder_1h_sent, reminder_5m_sent
     FROM ig_flagged_posts
     WHERE status = 'approved' AND event_url IS NOT NULL AND live_at_utc IS NOT NULL
       AND (reminder_1d_sent = 0 OR reminder_1h_sent = 0 OR reminder_5m_sent = 0)`
  ).all<any>();

  for (const row of results || []) {
    const liveAt = Date.parse(row.live_at_utc);
    if (isNaN(liveAt)) continue;
    const msUntil = liveAt - now;
    const tooStaleToBother = msUntil < -6 * ONE_HOUR_MS;

    if (!row.reminder_1d_sent && msUntil <= ONE_DAY_MS) {
      if (!tooStaleToBother) {
        await sendCountdownReminder(env, row.event_url, "is expected to go live in about 1 day", row.live_at_utc, row.live_at_timezone, row.post_url);
      }
      await env.DB.prepare("UPDATE ig_flagged_posts SET reminder_1d_sent = 1 WHERE id = ?").bind(row.id).run();
    }
    if (!row.reminder_1h_sent && msUntil <= ONE_HOUR_MS) {
      if (!tooStaleToBother) {
        await sendCountdownReminder(env, row.event_url, "is expected to go live in about 1 hour", row.live_at_utc, row.live_at_timezone, row.post_url);
      }
      await env.DB.prepare("UPDATE ig_flagged_posts SET reminder_1h_sent = 1 WHERE id = ?").bind(row.id).run();
    }
    if (!row.reminder_5m_sent && msUntil <= FIVE_MIN_MS) {
      if (!tooStaleToBother) {
        await sendCountdownReminder(env, row.event_url, "is expected to go live in about 5 minutes", row.live_at_utc, row.live_at_timezone, row.post_url);
      }
      await env.DB.prepare("UPDATE ig_flagged_posts SET reminder_5m_sent = 1 WHERE id = ?").bind(row.id).run();
    }
  }
}

interface AiAnnouncementParse {
  eventUrl: string | null;
  bannerText: string;
  isRaceTicketSale: boolean;
  liveAtUtc: string | null;
  liveAtTimezone: string | null;
  presaleIsLive: boolean;
}

/** HYROX country accounts post in whatever language that country speaks, and
 * a single account can cover many cities (e.g. @hyroxitalia posts about
 * Rome, Milan, Bologna...), so figuring out "which known event is this
 * about, and what does it actually say" needs real language understanding,
 * not regex. Also judges relevance, not just extraction - every new post
 * gets sent here regardless of what it says (there's no keyword pre-filter
 * anymore; it missed too much - non-English captions, future-tense
 * announcements), so this is the *only* thing standing between "someone
 * posted a workout selfie" and it publishing as a ticket-sale alert.
 * Returns null on any failure - the caller treats that as "no evidence,
 * don't publish" rather than blocking the whole check. */
async function parseAnnouncementWithAI(
  env: Env,
  caption: string,
  postedAt: string | null,
  candidates: { title: string; url: string }[]
): Promise<AiAnnouncementParse | null> {
  const candidateList = candidates.map((c) => `- ${c.title}: ${c.url}`).join("\n");
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // Cheapest current model - this is a small structured-extraction
        // task (read one caption, match it against a list, write one short
        // sentence), not something that needs Opus-tier reasoning.
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system:
          "You read Instagram captions from HYROX country/region accounts, written in any language, and decide whether the post is genuinely announcing that RACE REGISTRATION/ENTRY tickets are going on sale, opening for pre-sale, or now available to sign up for a HYROX race. Set is_race_ticket_sale to false for anything else that merely contains ticket-related words out of context - merchandise sales, spectator-only tickets, giveaways, general reminders, unrelated promotions. If is_race_ticket_sale is true: produce a short, factual English summary (banner_text) suitable for a public alerts website and an email - include any date/time mentioned in the caption, translated and clarified (resolve relative dates like \"tomorrow\" using the post's timestamp); set matched_event_url only if the caption clearly names a specific event from the provided list (by city or event name), use null rather than guessing if it's ambiguous; and if the caption states or clearly implies a specific date and time the (pre-)sale goes or went live, convert it to an absolute UTC timestamp in live_at_utc (ISO 8601, e.g. 2026-08-06T10:00:00Z) - infer the local timezone from the event's country/city if not stated explicitly (e.g. Milan -> Europe/Rome, Berlin -> Europe/Berlin), and also return that same IANA timezone identifier in timezone so displays can show the event's own local time instead of UTC; use null for both live_at_utc and timezone if no specific time is given (a vague \"soon\" is not a specific time). Also set presale_is_live to true only if the caption means people can register or buy RIGHT NOW - an open early-access/gym link, a pre-sale or the public sale itself described as already open or live - as opposed to merely announcing that it WILL open at a future date with nothing accessible yet; set it false in that latter case (this is independent of live_at_utc, which may still be set to a future public-sale date even while presale_is_live is true for an ongoing early-access window). If is_race_ticket_sale is false, still fill banner_text with a brief note of what the post was actually about, and leave matched_event_url, live_at_utc, and timezone null, and set presale_is_live to false.",
        messages: [
          {
            role: "user",
            content: `Post timestamp: ${postedAt || "unknown"}\n\nCaption:\n${caption}\n\nKnown HYROX events (title: url):\n${candidateList}`,
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                is_race_ticket_sale: { type: "boolean" },
                matched_event_url: { type: ["string", "null"] },
                banner_text: { type: "string" },
                live_at_utc: { type: ["string", "null"] },
                timezone: { type: ["string", "null"] },
                presale_is_live: { type: "boolean" },
              },
              required: ["is_race_ticket_sale", "matched_event_url", "banner_text", "live_at_utc", "timezone", "presale_is_live"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!resp.ok) {
      console.error(`Anthropic request failed: ${resp.status} ${await resp.text()}`);
      return null;
    }
    const data: any = await resp.json();
    const textBlock = (data.content || []).find((b: any) => b.type === "text");
    if (!textBlock) return null;
    const parsed = JSON.parse(textBlock.text);
    const liveAtUtc = parsed.live_at_utc && !isNaN(Date.parse(parsed.live_at_utc)) ? parsed.live_at_utc : null;
    return {
      eventUrl: parsed.matched_event_url || null,
      bannerText: parsed.banner_text,
      isRaceTicketSale: !!parsed.is_race_ticket_sale,
      liveAtUtc,
      liveAtTimezone: liveAtUtc && parsed.timezone ? parsed.timezone : null,
      presaleIsLive: !!parsed.presale_is_live,
    };
  } catch (e) {
    console.error("Failed to parse Instagram announcement with AI:", e);
    return null;
  }
}

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

/** Daily check (see the "0 8 * * *" cron below). Every genuinely new post
 * from a tracked account gets read by Claude (any language) to decide
 * whether it's actually a race ticket-sale announcement, write an English
 * summary, and where confident, match it to a known event - if so, anyone
 * watching that event's sale gets emailed right away. No human approval
 * gate: the AI's read of the caption is judged reliable enough, and the
 * admin can always retract a bad publish afterwards from /admin/ig-posts. */
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

  // Fetched once and reused for every AI parse this run, rather than
  // per-post - the candidate event list rarely needs to be fresher than
  // "as of this cron tick".
  let candidateEvents: { title: string; url: string }[] | null = null;

  for (const post of posts) {
    const postId = post.id || post.shortCode;
    if (!postId) continue;

    // A post can legitimately belong to more than one tracked account at
    // once (a Collab between two country pages), and Apify doesn't tell us
    // which of our input usernames produced this result - so match against
    // our known list via owner + coauthors rather than trusting response
    // order. Anything not in our list is ignored outright (Apify has
    // occasionally returned an untracked account via fuzzy-match fallback).
    const ownerCandidates = [post.ownerUsername, ...(post.coauthorProducers || []).map((c) => c.username)].filter(
      (u): u is string => !!u
    );
    const matchedHandles = ownerCandidates.filter((u) => IG_HANDLES_LOWER.has(u.toLowerCase()));

    for (const handle of matchedHandles) {
      const isFirstCheck = !knownLastPostId.has(handle);
      const priorBest = maxSeenThisRun.get(handle) ?? knownLastPostId.get(handle) ?? null;
      const isNewer = isPostIdNewer(postId, priorBest);
      if (isNewer) maxSeenThisRun.set(handle, postId);

      // Never flag anything the first time we've ever checked a handle -
      // that just establishes the baseline - and never flag a post we've
      // already seen (or an older one Apify happened to resurface).
      if (isFirstCheck || !isNewer) continue;

      const postUrl = post.url || `https://www.instagram.com/p/${post.shortCode}/`;

      if (candidateEvents === null) {
        const { results } = await env.DB.prepare(
          "SELECT title, url FROM event_directory WHERE event_date IS NULL OR event_date >= ?"
        )
          .bind(todayIso())
          .all<any>();
        candidateEvents = results || [];
      }
      const ai = await parseAnnouncementWithAI(env, post.caption || "", post.timestamp || null, candidateEvents);
      // No keyword pre-filter anymore (it missed non-English captions and
      // future-tense announcements - see e.g. "Tickets Are Almost Here" or
      // a Portuguese "as vendas começam em..."), so the AI's relevance
      // judgment is now the *only* signal that a post is genuinely about
      // race ticket sales. A failed AI call means no evidence at all, not
      // "probably fine" - skip rather than publish blind.
      if (!ai || !ai.isRaceTicketSale) continue;

      const bannerText = ai.bannerText;
      const eventUrl = ai.eventUrl;
      const liveAtUtc = ai.liveAtUtc;
      const liveAtTimezone = ai.liveAtTimezone;
      const presaleIsLive = ai.presaleIsLive ? 1 : 0;

      await env.DB.prepare(
        `INSERT INTO ig_flagged_posts (handle, post_id, post_url, caption, posted_at, status, banner_text, event_url, live_at_utc, live_at_timezone, presale_is_live)
         VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)
         ON CONFLICT(handle, post_id) DO NOTHING`
      )
        .bind(handle, postId, postUrl, post.caption || "", post.timestamp || null, bannerText, eventUrl, liveAtUtc, liveAtTimezone, presaleIsLive)
        .run();
      flaggedCount++;

      if (eventUrl) {
        await notifySaleWatchers(env, eventUrl, bannerText, postUrl);
        // Surface the same info on both the public browsable list
        // (event_directory) and the personal "waiting" list (sale_watch),
        // so it's visible to everyone, not just people who set up a watch.
        await env.DB.prepare("UPDATE event_directory SET presale_note = ?, presale_live_at = ?, presale_timezone = ?, presale_is_live = ? WHERE url = ?")
          .bind(bannerText, liveAtUtc, liveAtTimezone, presaleIsLive, eventUrl)
          .run();
        await env.DB.prepare("UPDATE sale_watch SET presale_note = ?, presale_live_at = ?, presale_timezone = ?, presale_is_live = ? WHERE event_url = ?")
          .bind(bannerText, liveAtUtc, liveAtTimezone, presaleIsLive, eventUrl)
          .run();
      }
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
    const logLink = `${env.SITE_URL}/admin/ig-posts?token=${env.WEBHOOK_SECRET}`;
    try {
      await sendEmail(
        env,
        env.ADMIN_EMAIL,
        `${flaggedCount} new HYROX Instagram post(s) published`,
        `<p>${flaggedCount} new Instagram post(s) mentioned a ticket sale and were published automatically. Review or retract: <a href="${logLink}">${logLink}</a></p>`,
        `${flaggedCount} new Instagram post(s) mentioned a ticket sale and were published automatically.\nReview or retract: ${logLink}`
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

/** Renders a UTC timestamp in the event's own local time (e.g. "Thu, 6 Aug
 * 2026, 12:00 CEST") instead of GMT/UTC, which reads as a foreign,
 * confusing time to most people. Falls back to UTC if the timezone is
 * missing or Claude returned something Intl doesn't recognize, rather than
 * throwing. */
function formatInTimezone(utcIso: string, timezone: string | null): string {
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return utcIso;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: timezone || "UTC" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(d);
  }
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
    `SELECT url, title, event_date, on_sale, presale_note, presale_live_at, presale_timezone, presale_is_live FROM event_directory
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

/** Manual trigger for sendVerificationNudges, same pattern as
 * /admin/reindex - useful for testing without waiting on the daily cron. */
async function handleSendNudges(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  await sendVerificationNudges(env);
  return jsonResponse({ ok: true });
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
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

async function renderAnnouncementsBanner(env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    "SELECT handle, post_url, banner_text, detected_at FROM ig_flagged_posts WHERE status = 'approved' ORDER BY detected_at DESC LIMIT 3"
  ).all<any>();
  if (!results || !results.length) return "";
  const rows = results
    .map(
      (r: any) => `<div class="ticket-row">
      <span>${escapeHtml(truncate(r.banner_text || r.handle, 70))}</span>
      <a href="${escapeHtml(r.post_url)}" target="_blank" rel="noopener">View post</a>
    </div>`
    )
    .join("");
  return `<div class="card"><h2>Recent ticket-sale news</h2>${rows}</div>`;
}

async function handleFeedbackPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  return page(
    "Feedback",
    `${navBar("/", subscriber, 0, !subscriber)}
    <div class="card">
      <h2>Feedback</h2>
      <p class="hint">Bug, feature idea, anything else you want to tell us - we read every one.</p>
      <form method="POST" action="/feedback">
        <label>Message
          <textarea name="message" required rows="5" style="width:100%;padding:10px;font-size:1rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin-top:6px;font-family:inherit"></textarea>
        </label>
        <label>Your email (optional, in case we want to follow up)
          <input type="email" name="email" placeholder="you@example.com">
        </label>
        <button type="submit">Send feedback</button>
      </form>
    </div>`
  );
}

async function handleFeedback(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const message = String(form.get("message") || "").trim();
  const email = String(form.get("email") || "").trim();
  if (!message) {
    return page("Feedback", `<div class="card"><p>Please enter a message. <a href="/feedback">Go back</a></p></div>`);
  }
  await env.DB.prepare("INSERT INTO feedback (message, email) VALUES (?, ?)")
    .bind(message, email || null)
    .run();

  if (env.ADMIN_EMAIL) {
    try {
      await sendEmail(
        env,
        env.ADMIN_EMAIL,
        "New RoxRaceAlerts feedback",
        `<p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>${email ? `<p>From: ${escapeHtml(email)}</p>` : ""}`,
        `${message}${email ? `\n\nFrom: ${email}` : ""}`
      );
    } catch (e) {
      console.error("Failed to email feedback to admin:", e);
    }
  }

  return page("Feedback", `<div class="card"><p>Thanks - we've got it.</p></div>`);
}

/** Read-only log of feedback submitted via /feedback, plus a delete
 * button to clean up spam/duplicates. Private - nothing here is public.
 * Uses the token-in-URL pattern (like /admin/ig-posts) rather than a
 * Bearer header, since this page is meant to be opened in a browser. */
async function handleFeedbackAdminPage(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

  const { results } = await env.DB.prepare("SELECT id, message, email, created_at FROM feedback ORDER BY created_at DESC LIMIT 100").all<any>();

  const rows = (results || [])
    .map(
      (r: any) => `<div class="card">
        <p><small>${escapeHtml(r.created_at)}${r.email ? ` &middot; ${escapeHtml(r.email)}` : ""}</small></p>
        <p>${escapeHtml(r.message).replace(/\n/g, "<br>")}</p>
        <form method="POST" action="/admin/feedback/dismiss">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="id" value="${r.id}">
          <button type="submit">Delete</button>
        </form>
      </div>`
    )
    .join("");

  return page("Feedback inbox", rows || `<div class="card"><p>Nothing yet.</p></div>`, { "cache-control": "private, no-store" });
}

async function handleFeedbackDismiss(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const id = String(form.get("id") || "");
  await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
  return Response.redirect(`${env.SITE_URL}/admin/feedback?token=${encodeURIComponent(token)}`, 303);
}

/** Private, read-only list of everyone registered - who Resend itself has
 * no concept of (it just relays individual sends, it doesn't retain a
 * subscriber list for us). This is the only place that list is visible
 * without querying D1 directly. Same token-gated pattern as the other
 * /admin/* pages. */
async function handleSubscribersAdminPage(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

  const { results } = await env.DB.prepare(
    `SELECT s.email, s.verified, s.created_at,
       (SELECT COUNT(*) FROM subscriptions WHERE subscriber_id = s.id) AS ticket_count,
       (SELECT COUNT(*) FROM sale_watchers WHERE subscriber_id = s.id) AS watch_count,
       (SELECT COUNT(*) FROM subscriptions WHERE subscriber_id = s.id AND purchased_at IS NOT NULL) AS bought_count
     FROM subscribers s
     ORDER BY s.created_at DESC
     LIMIT 500`
  ).all<any>();

  const rows = results || [];
  const totalBought = rows.reduce((sum: number, r: any) => sum + r.bought_count, 0);
  const totalTickets = rows.reduce((sum: number, r: any) => sum + r.ticket_count, 0);

  const rowsHtml = rows
    .map(
      (r: any) => `<div class="ticket-row">
        <span>${escapeHtml(r.email)} ${r.verified ? "" : '<small>(unverified)</small>'} &mdash; ${r.ticket_count} ticket(s), ${r.watch_count} race(s), ${r.bought_count} bought &middot; <small>${escapeHtml(r.created_at)}</small></span>
      </div>`
    )
    .join("");

  return page(
    "Subscribers",
    `<div class="card">
      <h2>Subscribers (${rows.length})</h2>
      <p><small>${totalBought} of ${totalTickets} watched ticket(s) marked as bought overall.</small></p>
      ${rowsHtml || "<p>Nobody yet.</p>"}
    </div>`,
    { "cache-control": "private, no-store" }
  );
}

/** Read-only log of what the daily Instagram check auto-published, plus a
 * one-click way to retract a bad publish (an AI mismatch, or an incorrect
 * event match). Nothing here requires action - publishing already
 * happened by the time this page is opened. Uses the token-in-URL pattern
 * (like unsubscribe/my-alerts links) rather than a Bearer header, since
 * this page is meant to be opened in a normal browser. */
async function handleIgAdminPage(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

  const { results } = await env.DB.prepare(
    "SELECT id, handle, post_url, caption, banner_text, event_url, detected_at FROM ig_flagged_posts WHERE status = 'approved' ORDER BY detected_at DESC LIMIT 30"
  ).all<any>();

  const rows = (results || [])
    .map(
      (r: any) => `<div class="card">
        <p><b>@${escapeHtml(r.handle)}</b> &middot; <a href="${escapeHtml(r.post_url)}" target="_blank" rel="noopener">View on Instagram</a></p>
        <p>${escapeHtml(r.banner_text || "")}</p>
        ${r.event_url ? `<p><small>Emailed watchers of: ${escapeHtml(r.event_url)}</small></p>` : ""}
        <p><small>${escapeHtml(r.caption || "")}</small></p>
        <form method="POST" action="/admin/ig-posts/dismiss">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="id" value="${r.id}">
          <button type="submit">Remove from homepage</button>
        </form>
      </div>`
    )
    .join("");

  return page(
    "Recently published Instagram announcements",
    rows || "<div class=\"card\"><p>Nothing published yet.</p></div>",
    { "cache-control": "private, no-store" }
  );
}

async function handleIgDismiss(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const id = String(form.get("id") || "");
  const post = await env.DB.prepare("SELECT event_url FROM ig_flagged_posts WHERE id = ?").bind(id).first<any>();
  await env.DB.prepare("UPDATE ig_flagged_posts SET status = 'dismissed' WHERE id = ?").bind(id).run();
  // Clear the presale info this post set, so a retracted bad match doesn't
  // keep showing on the public list or a subscriber's "waiting" line.
  if (post?.event_url) {
    await env.DB.prepare(
      "UPDATE event_directory SET presale_note = NULL, presale_live_at = NULL, presale_timezone = NULL, presale_is_live = 0 WHERE url = ?"
    )
      .bind(post.event_url)
      .run();
    await env.DB.prepare(
      "UPDATE sale_watch SET presale_note = NULL, presale_live_at = NULL, presale_timezone = NULL, presale_is_live = 0 WHERE event_url = ?"
    )
      .bind(post.event_url)
      .run();
  }
  return Response.redirect(`${env.SITE_URL}/admin/ig-posts?token=${encodeURIComponent(token)}`, 303);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/favicon.svg" && req.method === "GET") return handleFavicon();
      if (url.pathname === "/" && req.method === "GET") return await handleSignupPage(req, env);
      if (url.pathname === "/resolve" && req.method === "GET") return await handleResolve(req, env);
      if (url.pathname === "/subscribe" && req.method === "POST") return await handleSubscribe(req, env);
      if (url.pathname === "/login" && req.method === "POST") return await handleLogin(req, env);
      if (url.pathname === "/watch-sale" && req.method === "POST") return await handleWatchSale(req, env);
      if (url.pathname === "/verify" && req.method === "GET") return await handleVerify(req, env);
      if (url.pathname === "/unsubscribe" && req.method === "GET") return await handleUnsubscribe(req, env);
      if (url.pathname === "/my-alerts" && req.method === "GET") return await handleMyAlerts(req, env);
      if (url.pathname === "/remove-subscription" && req.method === "POST") return await handleRemoveSubscription(req, env);
      if (url.pathname === "/mark-purchased" && req.method === "POST") return await handleMarkPurchased(req, env);
      if (url.pathname === "/remove-sale-watch" && req.method === "POST") return await handleRemoveSaleWatch(req, env);
      if (url.pathname === "/sign-out" && req.method === "GET") return handleSignOut(env);
      if (url.pathname === "/notify" && req.method === "POST") return await handleNotify(req, env);
      if (url.pathname === "/search-events" && req.method === "GET") return await handleSearchEvents(req, env);
      if (url.pathname === "/events" && req.method === "GET") return await handleListEvents(env);
      if (url.pathname === "/admin/reindex" && req.method === "POST") return await handleReindex(req, env);
      if (url.pathname === "/admin/refresh-sale-status" && req.method === "POST") return await handleRefreshSaleStatus(req, env);
      if (url.pathname === "/admin/send-nudges" && req.method === "POST") return await handleSendNudges(req, env);
      if (url.pathname === "/admin/check-instagram" && req.method === "POST") return await handleCheckInstagram(req, env);
      if (url.pathname === "/admin/ig-posts" && req.method === "GET") return await handleIgAdminPage(req, env);
      if (url.pathname === "/admin/ig-posts/dismiss" && req.method === "POST") return await handleIgDismiss(req, env);
      if (url.pathname === "/feedback" && req.method === "GET") return await handleFeedbackPage(req, env);
      if (url.pathname === "/feedback" && req.method === "POST") return await handleFeedback(req, env);
      if (url.pathname === "/admin/feedback" && req.method === "GET") return await handleFeedbackAdminPage(req, env);
      if (url.pathname === "/admin/subscribers" && req.method === "GET") return await handleSubscribersAdminPage(req, env);
      if (url.pathname === "/admin/feedback/dismiss" && req.method === "POST") return await handleFeedbackDismiss(req, env);
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
      ctx.waitUntil(checkAnnouncementReminders(env));
    } else if (event.cron === "0 8 * * *") {
      ctx.waitUntil(checkInstagramAnnouncements(env));
      ctx.waitUntil(sendVerificationNudges(env));
    } else {
      ctx.waitUntil(indexEvents(env).then(() => undefined));
    }
  },
};
