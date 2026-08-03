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

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1a1a1a;background:#fafafa}
h1{font-size:1.5rem}
.card{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:24px;margin-top:16px}
label{display:block;margin:10px 0;font-size:0.95rem}
input[type=email]{width:100%;padding:10px;font-size:1rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin-top:6px}
button{background:#111;color:#fff;border:0;border-radius:6px;padding:12px 20px;font-size:1rem;cursor:pointer;margin-top:16px}
button:hover{background:#333}
small{color:#666}
a{color:#111}
.consent{font-size:0.85rem;color:#555;margin-top:14px}
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
      <form method="POST" action="/subscribe">
        <div>${options || "<p>No tickets currently tracked.</p>"}</div>
        <label>Your email
          <input type="email" name="email" required placeholder="you@example.com">
        </label>
        <p class="consent">By subscribing you agree to receive ticket-availability emails for the event(s) selected above. You can unsubscribe at any time via the link in every email. We don't share your email with anyone.</p>
        <button type="submit">Subscribe</button>
      </form>
    </div>`
  );
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

  const { results } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token FROM subscribers s
     JOIN subscriptions sub ON sub.subscriber_id = s.id
     WHERE s.verified = 1 AND sub.event_name = ? AND sub.ticket_name = ?`
  )
    .bind(event_name, ticket_name)
    .all<any>();

  let sent = 0;
  for (const row of results || []) {
    const unsubLink = `${env.SITE_URL}/unsubscribe?token=${row.unsubscribe_token}`;
    try {
      await sendEmail(
        env,
        row.email,
        `Ticket available: ${ticket_name}`,
        `<p><b>${escapeHtml(event_name)}</b><br>${escapeHtml(ticket_name)} is now available.</p><p><a href="${link}">${link}</a></p><p><small><a href="${unsubLink}">Unsubscribe</a></small></p>`,
        `${event_name}\n${ticket_name} is now available.\n${link}\n\nUnsubscribe: ${unsubLink}`
      );
      sent++;
    } catch (e) {
      console.error(`Failed to email ${row.email}:`, e);
    }
  }

  return new Response(JSON.stringify({ sent }), { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/" && req.method === "GET") return await handleSignupPage(env);
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
};
