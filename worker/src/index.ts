import { resolveEvent, getEventData, ticketStatus, isFetchableUrl } from "./resolve";

export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  WEBHOOK_SECRET: string;
  CONFIG_URL: string;
  SEND_FROM: string;
  SITE_URL: string;
}

interface TrackedTicket {
  event_name: string;
  ticket_name: string;
  shop_url: string;
  // Present only for tickets resolved via /resolve (the public "paste any
  // URL" flow) - curated tickets from config.json don't need these, since
  // that list is checked by the existing Python pipeline, not by us.
  event_id?: string;
  status?: "available" | "sold_out";
}

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

async function fetchTrackedTickets(env: Env): Promise<TrackedTicket[]> {
  const resp = await fetch(env.CONFIG_URL, { cf: { cacheTtl: 60 } as any });
  if (!resp.ok) return [];
  const config = await resp.json<any>();
  const tickets: TrackedTicket[] = [];
  for (const ev of config.events || []) {
    for (const name of Object.keys(ev.watched_tickets || {})) {
      tickets.push({
        event_name: ev.event_name,
        ticket_name: name,
        shop_url: ev.shop_url || ev.source_url,
      });
    }
  }
  return tickets;
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
    const unsubLink = `${env.SITE_URL}/unsubscribe?token=${row.unsubscribe_token}`;
    try {
      await sendEmail(
        env,
        row.email,
        `Ticket available: ${ticketName}`,
        `<p><b>${escapeHtml(eventName)}</b><br>${escapeHtml(ticketName)} is now available.</p><p><a href="${link}">${link}</a></p><p><small><a href="${unsubLink}">Unsubscribe</a></small></p>`,
        `${eventName}\n${ticketName} is now available.\n${link}\n\nUnsubscribe: ${unsubLink}`
      );
      sent++;
    } catch (e) {
      console.error(`Failed to email ${row.email}:`, e);
    }
  }
  return sent;
}

function page(title: string, body: string): Response {
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
</style></head>
<body><h1>RoxRaceAlerts</h1>${body}
<p><small>Independent HYROX ticket-availability alerts. Not affiliated with HYROX or vivenu.</small></p>
</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function handleSignupPage(env: Env): Promise<Response> {
  const tickets = await fetchTrackedTickets(env);
  const options = tickets
    .map(
      (t) =>
        `<label><input type="checkbox" name="ticket" value="${escapeHtml(encodeTicket(t))}"> ${escapeHtml(
          t.event_name
        )} &mdash; ${escapeHtml(t.ticket_name)}</label>`
    )
    .join("\n");

  return page(
    "Get notified when sold-out HYROX tickets become available",
    `<div class="card">
      <p>Free alerts the moment a sold-out ticket type becomes available again. Pick one or more, enter your email, confirm it, done.</p>
      <form method="POST" action="/subscribe" id="signupForm">
        <h2>Currently tracked</h2>
        <div>${options || "<p>No tickets currently tracked.</p>"}</div>

        <h2>Or find another HYROX event</h2>
        <div class="row">
          <input type="text" id="urlInput" placeholder="https://hyrox.com/event/...">
          <button type="button" id="findBtn">Find tickets</button>
        </div>
        <div id="resolveResult"></div>

        <label>Your email
          <input type="email" name="email" required placeholder="you@example.com">
        </label>
        <p class="consent">By subscribing you agree to receive ticket-availability emails for the event(s) selected above. You can unsubscribe at any time via the link in every email. We don't share your email with anyone.</p>
        <button type="submit">Subscribe</button>
      </form>
    </div>
    <script>
    (function() {
      function esc(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
      }
      document.getElementById('findBtn').addEventListener('click', async function() {
        var input = document.getElementById('urlInput');
        var out = document.getElementById('resolveResult');
        var url = input.value.trim();
        if (!url) return;
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
      });
    })();
    </script>`
  );
}

async function handleResolve(req: Request, env: Env): Promise<Response> {
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
  const email = String(form.get("email") || "").trim().toLowerCase();
  const ticketValues = form.getAll("ticket").map(String);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return page("Invalid email", `<div class="card"><p>That doesn't look like a valid email address. <a href="/">Go back</a></p></div>`);
  }
  if (ticketValues.length === 0) {
    return page("Pick a ticket", `<div class="card"><p>Please select at least one ticket to watch. <a href="/">Go back</a></p></div>`);
  }

  let subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<any>();
  const verifyToken = randomToken();
  const unsubToken = subscriber ? subscriber.unsubscribe_token : randomToken();

  if (!subscriber) {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, verified, verify_token, unsubscribe_token) VALUES (?, 0, ?, ?)"
    )
      .bind(email, verifyToken, unsubToken)
      .run();
    subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<any>();
  } else if (!subscriber.verified) {
    await env.DB.prepare("UPDATE subscribers SET verify_token = ? WHERE id = ?").bind(verifyToken, subscriber.id).run();
  }

  for (const val of ticketValues) {
    const t = decodeTicket(val);
    if (!t) continue;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO subscriptions (subscriber_id, event_name, ticket_name, shop_url) VALUES (?, ?, ?, ?)"
    )
      .bind(subscriber.id, t.event_name, t.ticket_name, t.shop_url)
      .run();

    // Community-resolved ticket (has event_id) - register it for the Worker's
    // own Cron Trigger to keep checking, independent of the curated list.
    if (t.event_id) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO community_tickets (event_id, event_name, ticket_name, shop_url, last_status) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(t.event_id, t.event_name, t.ticket_name, t.shop_url, t.status || "sold_out")
        .run();
    }
  }

  if (!subscriber.verified) {
    const link = `${env.SITE_URL}/verify?token=${verifyToken}`;
    await sendEmail(
      env,
      email,
      "Confirm your RoxRaceAlerts subscription",
      `<p>Click to confirm you want ticket-availability alerts:</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
      `Confirm your subscription: ${link}\n\nIf you didn't request this, ignore this email.`
    );
    return page(
      "Check your email",
      `<div class="card"><p>Almost done — we've sent a confirmation link to <b>${escapeHtml(
        email
      )}</b>. Click it to start receiving alerts.</p></div>`
    );
  }

  return page(
    "Subscribed",
    `<div class="card"><p>You're already verified — added the selected ticket(s) to your alerts.</p></div>`
  );
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
    `<div class="card"><p>You're confirmed! You'll get an email the moment your selected ticket(s) become available.</p></div>`
  );
}

async function handleUnsubscribe(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This unsubscribe link is invalid.</p></div>`);
  }
  await env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(subscriber.id).run();
  return page("Unsubscribed", `<div class="card"><p>You've been unsubscribed from all alerts. Sorry to see you go.</p></div>`);
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
 * fan out alerts on sold_out -> available, mirroring monitor.py's run_check()
 * for the curated list but fully independent of it. */
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/" && req.method === "GET") return await handleSignupPage(env);
      if (url.pathname === "/resolve" && req.method === "GET") return await handleResolve(req, env);
      if (url.pathname === "/subscribe" && req.method === "POST") return await handleSubscribe(req, env);
      if (url.pathname === "/verify" && req.method === "GET") return await handleVerify(req, env);
      if (url.pathname === "/unsubscribe" && req.method === "GET") return await handleUnsubscribe(req, env);
      if (url.pathname === "/notify" && req.method === "POST") return await handleNotify(req, env);
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      console.error(e);
      return new Response(`Internal error: ${e.message}`, { status: 500 });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkCommunityTickets(env));
  },
};
