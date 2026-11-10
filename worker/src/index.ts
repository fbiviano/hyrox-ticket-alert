import { resolveEvent, getEventData, ticketStatus, isFetchableUrl, HEADERS, FetchBlocked } from "./resolve";
import { renderCardJpeg, renderSlideJpeg, type CardInput, type Slide } from "./igcard";
import PostalMime from "postal-mime";

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
  EMAIL_DRY_RUN?: string; // "1" on staging: emails are logged, never sent
  SCHEDULER: DurableObjectNamespace; // CheckScheduler: alarm-driven fallback for the frequent checks
  IG_ACCESS_TOKEN?: string; // Instagram API (Instagram Login) token for @roxracealerts, long-lived (60 days)
  RESEND_WEBHOOK_SECRET?: string; // signing secret (whsec_...) of the Resend webhook -> /resend/webhook (delivered/opened/...)
  SCHEDULER_AUTOSTART?: string; // "1" = any request arms the alarm scheduler (production)
  TICKET_GRID?: string; // "1" = category-by-day ticket picker; unset = the plain list (until confirmed)
  TELEGRAM_BOT_USERNAME?: string; // public handle of the bot, for the t.me deep link
  TELEGRAM_WEBHOOK_SECRET?: string; // header secret Telegram echoes on every webhook call
  STRIPE_SECRET_KEY?: string; // Stripe secret key (sk_test_... in staging); Priority is off without it
  STRIPE_WEBHOOK_SECRET?: string; // signing secret (whsec_...) of the /stripe/webhook endpoint
  PRIORITY_OPEN_TO_ALL?: string; // "1" = every verified subscriber sees the Priority button; unset = admin only
  PRIORITY_FREE_DELAY_MINUTES?: string; // how long free watchers wait after Priority holders; unset/0 = nobody is delayed
  // WhatsApp Cloud API (see sendWhatsAppAlert). All optional: unset = WhatsApp off.
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  ADMIN_WHATSAPP?: string;
  WHATSAPP_PUBLIC_NUMBER?: string; // number subscribers message to link, digits only
  WHATSAPP_VERIFY_TOKEN?: string; // webhook handshake secret
  WHATSAPP_APP_SECRET?: string; // verifies Meta's webhook signatures
  WHATSAPP_APP_ID?: string; // the Meta app's id (not secret)
  WHATSAPP_OPEN_TO_ALL?: string; // "1" = every verified subscriber may link; unset = admin only
  GSC_KEY?: string; // Google service-account key (JSON) with read access to Search Console - SEO report
  BING_API_KEY?: string; // Bing Webmaster Tools API key - SEO report
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

/** Line in subscriber emails pointing to our Instagram, where upcoming ticket dates are posted. */
const IG_PROFILE_URL = "https://www.instagram.com/roxracealerts/";
const IG_FOLLOW_HTML = `<p><small>📸 Upcoming ticket dates on Instagram: <a href="${IG_PROFILE_URL}">@roxracealerts</a></small></p>`;
const IG_FOLLOW_TEXT = `\n\nUpcoming ticket dates on Instagram: ${IG_PROFILE_URL}`;

async function sendEmail(env: Env, to: string, subject: string, html: string, text: string, opts: { fromName?: string; replyTo?: string } = {}) {
  if (env.EMAIL_DRY_RUN === "1") {
    // Staging: behave as if sent (so every flow runs like production) but never mail anyone.
    await env.DB.prepare("INSERT INTO email_log (to_address, subject, ok, error) VALUES (?, ?, 1, ?)").bind(to, subject, `dry run - not sent | ${text.slice(0, 1500)}`).run();
    return;
  }
  let error: string | null = null;
  let resendId: string | null = null;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // fromName swaps only the display name ("Francesco from RoxRaceAlerts <alerts@...>").
        from: opts.fromName ? env.SEND_FROM.replace(/^[^<]*</, `${opts.fromName} <`) : env.SEND_FROM,
        to: [to],
        subject,
        html,
        text,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      error = `${resp.status} ${body}`.slice(0, 300);
      throw new Error(`Resend send failed: ${resp.status} ${body}`);
    }
    // Resend's id for this email - its webhook events (delivered, opened, ...) refer to it.
    resendId = ((await resp.json().catch(() => null)) as any)?.id ?? null;
  } catch (e) {
    if (!error) error = String(e).slice(0, 300);
    throw e;
  } finally {
    // Every attempt is logged (see email_log in schema.sql) - and a logging
    // failure must never turn a delivered alert into a failed one.
    try {
      await env.DB.prepare("INSERT INTO email_log (to_address, subject, ok, error, resend_id) VALUES (?, ?, ?, ?, ?)")
        .bind(to, subject, error ? 0 : 1, error, resendId)
        .run();
    } catch (logErr) {
      console.error("Failed to write email_log:", logErr);
    }
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

/** Same as sendTelegram but with an attached image - used for the daily IG
 * post-queue reminder, where seeing the actual graphic matters. Telegram's
 * sendPhoto needs multipart/form-data, not JSON. */
async function sendTelegramPhoto(env: Env, photoBytes: Uint8Array, filename: string, caption: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const form = new FormData();
  form.set("chat_id", env.TELEGRAM_CHAT_ID);
  form.set("caption", caption);
  form.set("photo", new Blob([photoBytes], { type: "image/png" }), filename);
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    console.error(`Telegram photo send failed: ${resp.status} ${await resp.text()}`);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Runs daily: reminds the admin which pre-made Instagram post to upload
 * next, with the actual image attached and the caption/hashtags as text -
 * everything needed to just copy-paste and post. Purely a personal
 * reminder tool (ig_post_queue is hand-populated, not user-facing) - picks
 * the lowest day_number not yet sent and marks it sent immediately, since
 * this is a one-shot "here's today's post" nudge, not a tracker of
 * whether the admin actually uploaded it. */
async function sendDailyIgPostReminder(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM ig_post_queue WHERE posted_at IS NULL ORDER BY day_number ASC LIMIT 1"
  ).first<any>();
  if (!row) return;

  const caption = `📅 Day ${row.day_number} - upload today\n\n${row.caption}\n\n${row.hashtags}`;
  await sendTelegramPhoto(env, base64ToBytes(row.image_base64), row.filename, caption);
  await env.DB.prepare("UPDATE ig_post_queue SET posted_at = datetime('now') WHERE id = ?").bind(row.id).run();
}

/** Mirrors an alert to Telegram, but only when it's addressed to the
 * site owner's own account (ADMIN_EMAIL) - other subscribers never get a
 * Telegram message, this is purely a personal secondary channel for the
 * owner's own watched tickets, alongside their regular alert email.
 * Failures are logged, never thrown - a missed Telegram ping shouldn't
 * fail the email send it's mirroring. */
/** A heads-up to the admin's Telegram about something a visitor did (sign-up, confirmation,
 * unsubscribe, ...). Best effort: never fails or slows the visitor's request. */
async function pingAdmin(env: Env, text: string): Promise<void> {
  try {
    await sendTelegram(env, text);
  } catch (e) {
    console.error("Failed to ping admin on Telegram:", e);
  }
}

async function notifyAdminTelegram(env: Env, recipientEmail: string, text: string): Promise<void> {
  if (!env.ADMIN_EMAIL || recipientEmail.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) return;
  try {
    await sendTelegram(env, text);
  } catch (e) {
    console.error("Failed to mirror alert to Telegram:", e);
  }
}

/** WhatsApp via Meta's Cloud API. Business-initiated messages (our alerts)
 * must use a pre-approved template, so every alert goes through one UTILITY
 * template, "ticket_alert": "RoxRaceAlerts update for {{1}}: {{2}} Open it
 * here: {{3}} You are getting this because you asked for HYROX ticket alerts
 * on roxracealerts.com." (footer: Reply STOP to turn off WhatsApp alerts).
 * Replies to something a person just sent us (the START/STOP confirmations)
 * are free-form text, allowed for 24h after their message.
 *
 * Everything funnels through postWhatsApp(): it never throws - an alert must
 * not fail because WhatsApp did - and records every attempt in whatsapp_log,
 * success or not. "Accepted" is not "delivered": delivery/read receipts
 * arrive later by webhook and are written onto the same row. */
const WHATSAPP_API = "https://graph.facebook.com/v25.0";
const WHATSAPP_ALERT_TEMPLATE = "ticket_alert";

async function postWhatsApp(env: Env, number: string, label: string, message: Record<string, unknown>): Promise<boolean> {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return false;
  let error: string | null = null;
  let messageId: string | null = null;
  try {
    const resp = await fetch(`${WHATSAPP_API}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: number, ...message }),
    });
    const body: any = await resp.json().catch(() => ({}));
    // Meta's error object carries the details that separate look-alike failures
    // (subcode, details text, fbtrace_id for Meta support) - keep them, they are what
    // made "Access denied" diagnosable.
    if (!resp.ok) {
      const e = body?.error ?? {};
      error = [resp.status, e.code, e.error_subcode, e.message, e.error_data?.details, e.fbtrace_id ? `trace ${e.fbtrace_id}` : ""]
        .filter((x) => x !== undefined && x !== null && x !== "")
        .join(" | ")
        .slice(0, 500);
    }
    else messageId = body?.messages?.[0]?.id ?? null;
  } catch (e) {
    error = String(e).slice(0, 300);
  }
  try {
    await env.DB.prepare("INSERT INTO whatsapp_log (to_number, template, ok, error, message_id) VALUES (?, ?, ?, ?, ?)")
      .bind(number, label, error ? 0 : 1, error, messageId)
      .run();
  } catch (logErr) {
    console.error("Failed to write whatsapp_log:", logErr);
  }
  if (error) console.error("WhatsApp send failed:", error);
  return !error;
}

/** One alert to one phone. If that person messaged us in the last 23 hours
 * (their 24h customer-service window is open) the alert goes as a normal
 * message - free, and it needs no approved template. Otherwise (the usual
 * case: alerts rarely land inside a window) it goes through the template. A
 * normal message that Meta refuses falls back to the template, so a window we
 * misjudged can't lose an alert. Template variables can't contain newlines,
 * tabs or runs of spaces, hence the cleaning. */
const WHATSAPP_ALERT_TEXT_LABEL = "ticket_alert_text"; // same alert, sent as a normal message inside an open window

async function sendWhatsAppAlert(env: Env, to: string, title: string, message: string, url: string): Promise<boolean> {
  const clean = (v: string, max: number) => v.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
  const number = to.replace(/\D/g, "");
  const [t, m, u] = [clean(title, 60), clean(message, 200), clean(url, 300)];

  const win = await env.DB.prepare(
    "SELECT 1 AS open FROM subscribers WHERE whatsapp_phone = ? AND whatsapp_last_inbound_at >= datetime('now', '-23 hours') LIMIT 1"
  )
    .bind(number)
    .first<any>();
  if (win) {
    const text = `RoxRaceAlerts update for ${t}: ${m} Open it here: ${u}\n\nYou are getting this because you asked for HYROX ticket alerts on roxracealerts.com.\nReply STOP to turn off WhatsApp alerts.`;
    if (await postWhatsApp(env, number, WHATSAPP_ALERT_TEXT_LABEL, { type: "text", text: { body: text, preview_url: false } })) return true;
  }
  return postWhatsApp(env, number, WHATSAPP_ALERT_TEMPLATE, {
    type: "template",
    template: {
      name: WHATSAPP_ALERT_TEMPLATE,
      language: { code: "en" },
      components: [{ type: "body", parameters: [t, m, u].map((text) => ({ type: "text", text })) }],
    },
  });
}

/** Free-form reply to a person who just messaged us. Capped at 3 per phone
 * per hour (only replies Meta accepted count - a failed send costs nothing and
 * must not lock a real person out): anyone can message the number, and replies
 * beyond Meta's free allowance cost money, so garbage must not be able to run
 * up a bill. */
async function sendWhatsAppReply(env: Env, to: string, text: string): Promise<boolean> {
  const number = to.replace(/\D/g, "");
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM whatsapp_log WHERE to_number = ? AND template = 'reply' AND ok = 1 AND created_at >= datetime('now', '-1 hour')"
  )
    .bind(number)
    .first<any>();
  if ((recent?.n || 0) >= 3) return false;
  return postWhatsApp(env, number, "reply", { type: "text", text: { body: text.slice(0, 1000), preview_url: false } });
}

/** Email every verified subscriber watching this exact (event_name, ticket_name). */
async function notifySubscribers(env: Env, eventName: string, ticketName: string, link: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token, s.whatsapp_phone, s.telegram_chat_id, ${hasTicketPrioritySql("s.id", "sub.event_name")} AS has_priority
     FROM subscribers s
     JOIN subscriptions sub ON sub.subscriber_id = s.id
     WHERE s.verified = 1 AND sub.event_name = ? AND sub.ticket_name = ? AND sub.purchased_at IS NULL`
  )
    .bind(eventName, ticketName)
    .all<any>();

  let sent = 0;
  for (const row of results || []) if (await sendTicketAlert(env, row, eventName, ticketName, link, row.has_priority ? null : 0)) sent++;
  return sent;
}

/** A sold-out ticket came back (community check): Priority holders (that event, or the season) are told first,
 * everyone else after the Priority delay - see "Priority alerts". */
async function notifyTicketReturned(env: Env, ct: any): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token, s.whatsapp_phone, s.telegram_chat_id, ${hasTicketPrioritySql("s.id", "sub.event_name")} AS has_priority
     FROM subscribers s JOIN subscriptions sub ON sub.subscriber_id = s.id
     WHERE s.verified = 1 AND sub.event_name = ? AND sub.ticket_name = ? AND sub.purchased_at IS NULL`
  )
    .bind(ct.event_name, ct.ticket_name)
    .all<any>();
  const all = results || [];
  const paid = all.filter((w: any) => w.has_priority);
  const delayMs = priorityDelayMs(env);
  const holdBack = delayMs > 0 && paid.length > 0 && paid.length < all.length;
  if (holdBack) {
    await env.DB.prepare("UPDATE community_tickets SET detected_at = datetime('now'), free_alert_after = ? WHERE id = ?")
      .bind(sqlTime(Date.now() + delayMs), ct.id)
      .run();
  }
  for (const row of holdBack ? paid : all) await sendTicketAlert(env, row, ct.event_name, ct.ticket_name, ct.shop_url, row.has_priority ? null : 0);
}

/** Sends held-back sold-out-ticket alerts once the delay is up (same rules as the race ones). */
async function sendDueFreeTicketAlerts(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, event_name, ticket_name, shop_url, detected_at FROM community_tickets WHERE free_alert_after IS NOT NULL AND free_alert_after <= datetime('now')"
  ).all<any>();
  for (const ct of results || []) {
    const claim = await env.DB.prepare("UPDATE community_tickets SET free_alert_after = NULL WHERE id = ? AND free_alert_after IS NOT NULL").bind(ct.id).run();
    if (!claim.meta.changes) continue;
    const { results: rows } = await env.DB.prepare(
      `SELECT s.email, s.unsubscribe_token, s.whatsapp_phone, s.telegram_chat_id
       FROM subscribers s JOIN subscriptions sub ON sub.subscriber_id = s.id
       WHERE s.verified = 1 AND sub.event_name = ? AND sub.ticket_name = ? AND sub.purchased_at IS NULL
         AND sub.created_at <= ? AND NOT ${hasTicketPrioritySql("s.id", "sub.event_name")}`
    )
      .bind(ct.event_name, ct.ticket_name, ct.detected_at)
      .all<any>();
    const behind = minutesSince(ct.detected_at);
    for (const row of rows || []) await sendTicketAlert(env, row, ct.event_name, ct.ticket_name, ct.shop_url, behind);
  }
}

/** The "ticket available" alert to one subscriber, on every channel they've set up. */
async function sendTicketAlert(env: Env, row: any, eventName: string, ticketName: string, link: string, upsellMinutes: number | null = null): Promise<boolean> {
  const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${row.unsubscribe_token}`;
  const up = upsellMinutes === null ? { html: "", text: "" } : priorityUpsell(env, row.unsubscribe_token, upsellMinutes);
  const unsubLink = `${env.SITE_URL}/unsubscribe?token=${row.unsubscribe_token}`;
  if (row.whatsapp_phone) await sendWhatsAppAlert(env, row.whatsapp_phone, eventName, `${ticketName} is now available.`, link);
  await sendTelegramAlert(env, row.telegram_chat_id, eventName, `${ticketName} is now available.`, link);
  try {
    await sendEmail(
      env,
      row.email,
      `Ticket available: ${ticketName}`,
      `<p><b>${escapeHtml(eventName)}</b><br>${escapeHtml(ticketName)} is now available.</p><p><a href="${link}">${link}</a></p>${up.html}${IG_FOLLOW_HTML}<p><small><a href="${myAlertsLink}">Manage my alerts</a> &middot; <a href="${unsubLink}">Unsubscribe from everything</a></small></p>`,
      `${eventName}\n${ticketName} is now available.\n${link}${up.text}${IG_FOLLOW_TEXT}\n\nManage my alerts: ${myAlertsLink}\nUnsubscribe from everything: ${unsubLink}`
    );
    await notifyAdminTelegram(env, row.email, `🎟️ ${eventName}\n${ticketName} is now available.\n${link}`);
    return true;
  } catch (e) {
    console.error(`Failed to email ${row.email}:`, e);
    return false;
  }
}

/** What search engines get told about a page. ownH1: the body carries the H1 itself (the brand
 * line at the top is then plain text), so the main heading can say what the page is about. */
interface PageSeo {
  description?: string;
  canonical?: string;
  jsonLd?: object[];
  ownH1?: boolean;
}

function page(title: string, body: string, extraHeaders: Record<string, string> = {}, wide = false, seo: PageSeo = {}): Response {
  const seoHead = [
    seo.description ? `<meta name="description" content="${escapeHtml(seo.description)}">` : "",
    seo.canonical ? `<link rel="canonical" href="${escapeHtml(seo.canonical)}">` : "",
    `<meta property="og:site_name" content="RoxRaceAlerts"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">`,
    seo.description ? `<meta property="og:description" content="${escapeHtml(seo.description)}">` : "",
    seo.canonical ? `<meta property="og:url" content="${escapeHtml(seo.canonical)}">` : "",
    ...(seo.jsonLd || []).map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`),
  ]
    .filter(Boolean)
    .join("\n");
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="msvalidate.01" content="33EA18F5CE22999A832E28883C0B455A">
<title>${escapeHtml(title)}</title>
${seoHead}
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1a1a1a;background:#fafafa}
h1{font-size:1.5rem}
.brand{font-size:1.5rem;font-weight:700;margin:0.67em 0}
h2{font-size:1.1rem;margin-top:0}
.faq details{border-top:1px solid #eee;padding:10px 0}.faq details:first-of-type{border-top:0}
.faq summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.faq summary::-webkit-details-marker{display:none}.faq summary h3{font-size:1rem;margin:0}
.faq summary::after{content:"+";color:#888;font-size:1.2rem;line-height:1;flex:none}.faq details[open] summary::after{content:"\\2013"}
.faq p{margin:8px 0 0;color:#444;font-size:0.95rem}
.card{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:24px;margin-top:16px}
label{display:block;margin:10px 0;font-size:0.95rem}
input[type=email],input[type=text],input[type=tel]{width:100%;padding:10px;font-size:1rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin-top:6px}
button{background:#111;color:#fff;border:0;border-radius:6px;padding:12px 20px;font-size:1rem;cursor:pointer;margin-top:16px}
button:hover{background:#333}
.row{display:flex;gap:8px;align-items:flex-start}
.row input{margin-top:0}
.row button{margin-top:0;white-space:nowrap}
small{color:#666}
a{color:#111}
.consent{font-size:0.85rem;color:#555;margin-top:14px}
.plan-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
@media(max-width:560px){.plan-grid{grid-template-columns:1fr}}
.plan{border:1px solid #e2e2e2;border-radius:10px;padding:14px;background:#fff;display:flex;flex-direction:column}
.plan.prio{border-color:#f0c36d;background:#fffaf0}
.plan h3{margin:0 0 8px;font-size:1rem}
.plan h3 span{font-weight:normal;color:#9a6700;font-size:0.9rem;margin-left:6px}
.plan ul{margin:0 0 8px;padding-left:18px;font-size:0.9rem}
.plan li{margin:3px 0}
.plan button{margin-top:auto;width:100%}
.plan-note{font-size:0.8rem;color:#666;margin:8px 0 0}
.plan.season{grid-column:1/-1;border-color:#e0a83a;background:#fff3d6}
.plan-line{font-size:0.9rem;margin:0 0 10px}
.tdaysec{margin-top:22px;padding-top:12px;border-top:1px solid #e5e5e5}
#resolveResult .tdayhead{margin:0 0 4px;font-weight:700;font-size:1.2rem;color:#111}
.tcatsec{margin:14px 0 0}
#resolveResult .tcathead{margin:0 0 6px;font-size:0.95rem;font-weight:700;color:#333}
.tcathead a{font-weight:normal;margin-left:6px;color:#111;font-size:0.88rem}
.tline{display:block;margin:7px 0;font-size:0.92rem}
.tstat{font-size:0.72rem;padding:1px 7px;border-radius:8px;margin-right:4px}
.tstat.sold{background:#fdecec;color:#b00}
.tstat.avail{background:#e6f4ea;color:#1e7e34}
.tsold{background:#fdecec;color:#b00;padding:1px 7px;border-radius:8px;font-size:0.8rem}
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
.ticket-row select{padding:5px 6px;font-size:0.85rem;border:1px solid #ccc;border-radius:6px;max-width:140px}
.subscriber-row{padding:10px 0;border-bottom:1px solid #eee}
.subscriber-row:last-child{border-bottom:0}
.subscriber-row summary{cursor:pointer}
.subscriber-row ul{margin:8px 0 0;padding-left:20px;font-size:0.85rem;color:#333}
.subscriber-row li{margin:2px 0}
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
.row-link{font-size:0.75rem;color:#777;margin-left:6px}
.status-list{list-style:none;padding:0;margin:0}
.status-list li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #eee;font-size:0.95rem}
.status-list li:last-child{border-bottom:0}
.race-links a{display:inline-block;margin:4px 12px 4px 0;font-size:0.9rem}
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
.side-compact .card{margin:0;padding:16px 18px}
.side-compact h2{font-size:1rem;margin:0 0 8px}
.side-compact p,.side-compact li{font-size:0.88rem;line-height:1.45}
.side-compact ul{padding-left:18px;margin:6px 0}
.side-compact input[type=text],.side-compact input[type=tel]{font-size:0.82rem;padding:6px 8px;margin:4px 0}
.side-compact label{font-size:0.8rem;margin:4px 0}
.side-compact .consent,.side-compact .hint,.side-compact small{font-size:0.74rem;line-height:1.35;margin:6px 0 0}
.side-compact button{font-size:0.85rem;padding:7px 12px;margin:2px 4px 2px 0}
.hero h1,.hero h2{font-size:1.6rem;margin:0 0 6px}
.hero-sub{color:#555;font-size:0.95rem;margin:0}
.stats-line{color:#555;font-size:0.9rem;margin:10px 0 0}.stats-line b{color:#111}
.hint{color:#555;font-size:0.9rem;margin-top:0}
.sponsors{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.sponsor{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid #eee;border-radius:8px;text-decoration:none;color:inherit}
.sponsor:hover{background:#f7f7f7;border-color:#ddd}
.sponsor img,.sp-ico{width:42px;height:42px;border-radius:8px;flex-shrink:0;object-fit:contain}
.sp-ico{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff3d00,#ffb800);color:#fff;font-weight:700;font-size:1.1rem}
.sp-body{display:flex;flex-direction:column;min-width:0}
.sp-body b{font-size:0.9rem}
.sp-body small{color:#666;font-size:0.78rem;line-height:1.25}
.sponsor-cta{border-style:dashed;border-color:#d6d6d6}
.rail{display:none}
.rail-tile{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:16px 12px;border-radius:12px;border:1px solid #eaeaea;text-decoration:none;color:#1a1a1a}
.rail-tile:hover{filter:brightness(0.97)}
.rail-tile b{font-size:0.95rem}
.rail-tile small{color:#555;font-size:0.78rem;line-height:1.3}
.rail-tile img,.rail-tile .sp-ico{width:44px;height:44px;border-radius:10px;object-fit:contain}
.rail-cta{background:#fff;border:2px dashed #d6d6d6}
.rail-tile .rail-spots{color:#999}
.sp-loc{font-weight:600;color:#9a6700 !important}
.rail-badge{align-self:flex-end;font-size:0.62rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#777;background:rgba(255,255,255,0.75);border:1px solid #ddd;border-radius:10px;padding:1px 7px}
.sp-body b .rail-badge{margin-left:4px;vertical-align:middle}
@media (min-width:1420px){.rail{display:flex;flex-direction:column;gap:12px;position:fixed;top:24px;width:170px;max-height:calc(100vh - 48px);overflow-y:auto;z-index:5}.rail-left{left:calc((100vw - 1020px)/2 - 185px)}#sponsorsCard{display:none}}
@media (max-width:1000px){.layout{flex-direction:column}.main-col,.sidebar{flex:1 1 auto;max-width:none;width:100%}}
</style></head>
<body${wide ? ' class="wide"' : ""}>${seo.ownH1 ? '<p class="brand">RoxRaceAlerts</p>' : "<h1>RoxRaceAlerts</h1>"}${body}
<p><small>Independent HYROX ticket-availability alerts. Not affiliated with HYROX or vivenu. &middot; <a href="/about">About</a> &middot; <a href="/guides/sold-out-hyrox-tickets">Sold-out tickets</a> &middot; <a href="/guides/hyrox-ticket-sale-dates">Sale dates</a> &middot; <a href="/guides/hyrox-ticket-types">Ticket types</a> &middot; <a href="/guides/hyrox-spectator-tickets">Spectator tickets</a> &middot; <a href="/tickets-back">Tickets that came back</a> &middot; <a href="/supporters">For gyms</a> &middot; <a href="/feedback">Feedback</a> &middot; <a href="/partners">Partner with us</a> &middot; <a href="/terms">Terms &amp; refunds</a> &middot; <a href="/privacy">Privacy</a><br>RoxRaceAlerts is operated by ${SELLER_ADDRESS} &middot; <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></small></p>
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
  showSignIn = false,
  env?: Env
): string {
  const myAlertsLabel = watchCount > 0 ? `My Alerts (${watchCount})` : "My Alerts";
  // Only rendered on the page load of the signed-in admin's own browser -
  // nobody else's session ever has subscriber.email match ADMIN_EMAIL, so
  // no other visitor's page includes this link or the token it carries.
  const isAdmin = !!(subscriber && env?.ADMIN_EMAIL && subscriber.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase());
  const adminLink =
    isAdmin && env?.WEBHOOK_SECRET
      ? ` &middot; <a href="/admin/subscribers?token=${encodeURIComponent(env.WEBHOOK_SECRET)}">Admin</a>`
      : "";
  const rightSlot = subscriber
    ? `<span class="nav-user" id="navSignedIn">Signed in as ${escapeHtml(subscriber.email)}${adminLink} &middot; <a href="/sign-out">Sign out</a></span>`
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
  // Race pages link here with ?event=<hyrox.com url>: open that race's ticket picker straight away.
  var presetEvent = new URLSearchParams(location.search).get('event');
  if (presetEvent && input) { input.value = presetEvent; setTimeout(function() { doFind(presetEvent); }, 0); }
  var browseDetails = document.getElementById('browseEvents');
  var submitBtn = document.querySelector('.submit-step');
  var signedIn = !!document.getElementById('navSignedIn');
  var prioEl = document.getElementById('priorityOffer');
  var priorityOn = !!prioEl;
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

  // --- Ticket picker: big races list 100+ ticket types because every ticket exists once per day.
  // Top level = race days; inside each day the tickets are grouped by category. Everything is
  // shown open - nothing hidden behind a click. ---
  var DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var CATS = ['Singles', 'Doubles', 'Relay', 'Adaptive', 'Charity', 'Spectators & extras'];
  function parseTicket(t) {
    var segs = t.name.split('|').map(function(x) { return x.trim(); });
    var last = segs[segs.length - 1].toLowerCase();
    var day = null;
    for (var d = 0; d < DAY_NAMES.length; d++) { if (last === DAY_NAMES[d].toLowerCase()) day = DAY_NAMES[d]; }
    var base = (day ? segs.slice(0, -1) : segs).join(' | ');
    var u = t.name.toUpperCase();
    var cat;
    if (u.indexOf('SPECTATOR') >= 0 || u.indexOf('PHOTO') >= 0 || u.indexOf('CHILD') >= 0 || u.indexOf('HYROX') < 0) cat = 'Spectators & extras';
    else if (u.indexOf('CHARITY') >= 0 || u.indexOf('MACMILLAN') >= 0) cat = 'Charity';
    else if (u.indexOf('RELAY') >= 0) cat = 'Relay';
    else if (u.indexOf('DOUBLES') >= 0) cat = 'Doubles';
    else if (u.indexOf('ADAPTIVE') >= 0) cat = 'Adaptive';
    else if (u.indexOf('MEN') >= 0) cat = 'Singles'; // Men, Women, Pro Men, Pro Women
    else cat = 'Spectators & extras';
    return { t: t, day: day, base: base, cat: cat, pro: /\\bPRO\\b/.test(u), sold: t.status === 'sold_out' };
  }
  function ticketLine(p) {
    return '<label class="tline"><input type="checkbox" name="ticket" value="' + esc(p.t.encoded) + '"> <span class="tstat ' + (p.sold ? 'sold' : 'avail') + '">' + (p.sold ? 'Sold out' : 'Available') + '</span> ' + esc(p.base) + '</label>';
  }
  function renderTicketPicker(data) {
    if (!document.getElementById('ticketGridOn')) {
      // Plain list (production until the new picker is confirmed).
      var plain = '<p><b>' + esc(data.event_name) + '</b></p>';
      for (var k = 0; k < data.tickets.length; k++) {
        var tk = data.tickets[k];
        plain += '<label><input type="checkbox" name="ticket" value="' + esc(tk.encoded) + '"> [' + esc(tk.status.toUpperCase()) + '] ' + esc(tk.name) + '</label>';
      }
      return plain;
    }
    var parsed = data.tickets.map(parseTicket);
    var html = '<p><b>' + esc(data.event_name) + '</b></p>';
    // Open before Pro; partner slots ("... ATHLETE 2") right after their main ticket.
    var nameKey = function(p) { return (p.pro ? '1' : '0') + p.base.replace(' ATHLETE 2', '') + (p.base.indexOf('ATHLETE 2') >= 0 ? '~' : ''); };
    var byName = function(a, b) { return nameKey(a) < nameKey(b) ? -1 : 1; };
    if (parsed.length < 8) {
      return html + parsed.slice().sort(function(a, b) { return (a.sold ? 0 : 1) - (b.sold ? 0 : 1); }).map(function(p) {
        return '<label class="tline"><input type="checkbox" name="ticket" value="' + esc(p.t.encoded) + '"> <span class="tstat ' + (p.sold ? 'sold' : 'avail') + '">' + (p.sold ? 'Sold out' : 'Available') + '</span> ' + esc(p.t.name) + '</label>';
      }).join('');
    }
    html += '<p class="hint">Tick the tickets you want to watch. For sold-out tickets we alert you the moment a place comes back.</p>';
    var sections = DAY_NAMES.filter(function(d) { return parsed.some(function(p) { return p.day === d; }); });
    if (parsed.some(function(p) { return !p.day; })) sections.push(null);
    sections.forEach(function(day) {
      var inDay = parsed.filter(function(p) { return p.day === day; });
      html += '<div class="tdaysec"><p class="tdayhead">' + (day ? esc(day) : 'Other tickets') + '</p>';
      CATS.forEach(function(c) {
        var rows = inDay.filter(function(p) { return p.cat === c; }).sort(byName);
        if (!rows.length) return;
        html += '<div class="tcatsec"><p class="tcathead">' + esc(c) + '</p>' +
          '<div class="tcatbody">' + rows.map(ticketLine).join('') + '</div></div>';
      });
      html += '</div>';
    });
    return html;
  }
  function afterPickerRender() {}

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
            (priorityOn
              ? (signedIn ? '' : '<input type="email" id="saleEmail" placeholder="you@example.com">') + prioEl.getAttribute('data-choice')
              : '<div class="row">' +
                (signedIn ? '' : '<input type="email" id="saleEmail" placeholder="you@example.com">') +
                '<button type="button" id="saleBtn">Notify me when on sale</button>' +
                '</div>');
          var wantPriority = '';
          if (priorityOn) {
            document.getElementById('salePrioBtn').addEventListener('click', function() {
              wantPriority = '1';
              document.getElementById('saleBtn').click();
            });
            var seasonBtn = document.getElementById('saleSeasonBtn');
            if (seasonBtn) seasonBtn.addEventListener('click', function() {
              wantPriority = 'season';
              document.getElementById('saleBtn').click();
            });
          }
          document.getElementById('saleBtn').addEventListener('click', async function() {
            var choice = wantPriority;
            wantPriority = '';
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
              if (choice) fd.set('priority', choice);
              var subResp = await fetch('/watch-sale', { method: 'POST', body: fd });
              if (choice && (subResp.headers.get('content-type') || '').indexOf('application/json') >= 0) {
                var pj = await subResp.json();
                if (pj.checkout_url) { window.location.href = pj.checkout_url; return; }
                out.innerHTML = '<p>' + esc(pj.error || 'Something went wrong. Try again.') + '</p>';
                return;
              }
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
      out.innerHTML = renderTicketPicker(data);
      afterPickerRender();
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
      if (e.target.closest && (e.target.closest('.row-monitor') || e.target.closest('.row-link'))) return;
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
          if (resp.headers.get('X-Priority-Offer') === '1') {
            var a = document.createElement('a');
            a.href = '/watching?event=' + encodeURIComponent(url);
            a.textContent = '⚡ Get alerted first';
            a.style.marginLeft = '8px';
            a.style.fontSize = '0.85rem';
            btn.parentNode.insertBefore(a, btn.nextSibling);
          }
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
        // Intl's own 'short' timeZoneName silently falls back to a bare
        // "GMT-3"/"GMT+8" offset for most zones outside Europe (confirmed
        // for Brazil, all of the Americas, and most of Asia/Oceania) -
        // there's just no short code in the browser's data for them. This
        // table covers the zones HYROX races actually use so real
        // acronyms (BRT, PDT, AEST...) show consistently instead of only
        // working for Europe. [std, dst] pairs are looked up against the
        // zone's own offset to pick the right one; a single string means
        // the zone doesn't observe DST.
        var TZ_ABBR = {
          'America/Sao_Paulo': 'BRT', 'America/Argentina/Buenos_Aires': 'ART', 'America/Buenos_Aires': 'ART',
          'America/Bogota': 'COT', 'America/Mexico_City': 'CST', 'America/Lima': 'PET', 'America/Santiago': 'CLT',
          'America/Los_Angeles': ['PST', 'PDT'], 'America/Vancouver': ['PST', 'PDT'],
          'America/Denver': ['MST', 'MDT'], 'America/Phoenix': 'MST',
          'America/Chicago': ['CST', 'CDT'],
          'America/New_York': ['EST', 'EDT'], 'America/Toronto': ['EST', 'EDT'],
          'Europe/London': ['GMT', 'BST'], 'Europe/Dublin': ['GMT', 'IST'], 'Europe/Istanbul': 'TRT',
          'Asia/Shanghai': 'CST', 'Asia/Taipei': 'CST', 'Asia/Hong_Kong': 'HKT', 'Asia/Tokyo': 'JST',
          'Asia/Seoul': 'KST', 'Asia/Singapore': 'SGT', 'Asia/Kuala_Lumpur': 'MYT', 'Asia/Bangkok': 'ICT',
          'Asia/Kolkata': 'IST', 'Asia/Riyadh': 'AST', 'Asia/Dubai': 'GST',
          'Australia/Sydney': ['AEST', 'AEDT'], 'Australia/Melbourne': ['AEST', 'AEDT'],
          'Australia/Brisbane': 'AEST', 'Australia/Perth': 'AWST',
          'Pacific/Auckland': ['NZST', 'NZDT'], 'Africa/Johannesburg': 'SAST', 'Africa/Cairo': 'EET'
        };
        function tzOffsetMinutes(date, tz) {
          var dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          var p = {};
          dtf.formatToParts(date).forEach(function(x) { p[x.type] = x.value; });
          var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
          return (asUtc - date.getTime()) / 60000;
        }
        function tzAbbr(utcIso, tz) {
          var entry = TZ_ABBR[tz];
          if (!entry) return null;
          if (typeof entry === 'string') return entry;
          var date = new Date(utcIso);
          var jan = tzOffsetMinutes(new Date(Date.UTC(date.getUTCFullYear(), 0, 15)), tz);
          var jul = tzOffsetMinutes(new Date(Date.UTC(date.getUTCFullYear(), 6, 15)), tz);
          var std = Math.min(jan, jul), dst = Math.max(jan, jul);
          if (std === dst) return entry[0];
          var actual = tzOffsetMinutes(date, tz);
          return actual === dst ? entry[1] : entry[0];
        }
        function formatLocal(utcIso, tz) {
          try {
            var abbr = tz ? tzAbbr(utcIso, tz) : null;
            var opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: abbr ? undefined : 'short', timeZone: tz || 'UTC' };
            var out = new Intl.DateTimeFormat('en-GB', opts).format(new Date(utcIso));
            return abbr ? out + ' ' + abbr : out;
          } catch (e) {
            return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: 'UTC' }).format(new Date(utcIso));
          }
        }
        function truncateText(s, max) {
          return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
        }
        var RECENTLY_ON_SALE_MS = 5 * 24 * 60 * 60 * 1000;
        function entriesFor(ev) {
          var out = [];
          if (ev.on_sale) {
            out.push({ section: 'on', badge: 'On sale', badgeClass: 'on', subtitle: '' });
            // Also spotlight it in the sidebar's "Live now" for a few days -
            // otherwise a just-opened sale immediately vanishes into the flat
            // "On sale now" list with dozens of other, older entries.
            if (ev.on_sale_since && (Date.now() - new Date(ev.on_sale_since).getTime()) <= RECENTLY_ON_SALE_MS) {
              out.push({ section: 'live', badge: 'On sale', badgeClass: 'on', subtitle: 'Just went on sale · ' + formatLocal(ev.on_sale_since, ev.presale_timezone) });
            }
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
          var detailsLink = ev.slug ? ' <a class="row-link" href="/hyrox/' + esc(ev.slug) + '">Details</a>' : '';
          return '<div class="event-row" data-url="' + esc(ev.url) + '"><div><span>' + esc(dateLabel) + ' &mdash; ' + esc(ev.title) + '</span>' + detailsLink + subtitle + '</div><div class="event-right">' + badge + '<span class="row-chev">&#8250;</span></div></div>';
        }
        var URGENT_MS = 48 * 60 * 60 * 1000;
        function isUrgent(ev) {
          if (!ev.presale_live_at) return false;
          var diff = new Date(ev.presale_live_at).getTime() - Date.now();
          return diff >= 0 && diff <= URGENT_MS;
        }
        function sideRowHtml(ev, entry) {
          var badge = '<span class="event-badge ' + entry.badgeClass + '">' + esc(entry.badge) + '</span>';
          var showFire = (entry.section === 'soon' && isUrgent(ev)) || (entry.section === 'live' && ev.on_sale);
          var saleLine = entry.subtitle
            ? '<div class="event-subtitle">' + (showFire ? '🔥 ' : '') + esc(entry.subtitle) + '</div>'
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

async function renderTicketRows(
  subscriberId: number,
  token: string,
  env: Env,
  priorityOn = false,
  seasonActive = false
): Promise<ActivePast & { purchased: string }> {
  const { results } = await env.DB.prepare(
    `SELECT id, event_name, ticket_name, event_date, purchased_at,
       (SELECT last_status FROM community_tickets ct WHERE ct.event_name = subscriptions.event_name AND ct.ticket_name = subscriptions.ticket_name LIMIT 1) AS last_status,
       ${hasTicketPrioritySql("subscriptions.subscriber_id", "subscriptions.event_name")} AS has_priority
     FROM subscriptions WHERE subscriber_id = ? ORDER BY event_date IS NULL, event_date, event_name, ticket_name`
  )
    .bind(subscriberId)
    .all<any>();
  const rows = results || [];
  const purchasedRows = rows.filter((r: any) => r.purchased_at);
  const { active, past } = splitByEventDate(rows.filter((r: any) => !r.purchased_at));
  const render = (rows: any[], emptyMsg?: string, showBuyButton?: boolean) => {
    // Priority belongs to the race, not one ticket: offer it once per race, on its first sold-out row.
    const offered = new Set<string>();
    const firstOfRace = (r: any) => !offered.has(r.event_name) && !!offered.add(r.event_name);
    const html = rows
      .map(
        (r: any) => `<div class="ticket-row">
      <span>${escapeHtml(r.event_name)} &mdash; ${escapeHtml(r.ticket_name)}</span>
      <div class="row" style="gap:6px">
        ${
          !showBuyButton
            ? ""
            : seasonActive || r.has_priority
              ? `<span class="event-badge presale" title="You're emailed before anyone else when this sells out and comes back">&#9889; ${seasonActive ? "Season Priority" : "Priority"}</span>`
              : priorityOn && r.last_status === "sold_out" && firstOfRace(r)
                ? priorityForm(token, "ticket", `&#9889; Priority for this race ${PRIORITY_PRICE_LABEL}`, { subscriptionId: r.id })
                : ""
        }
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

/** Self-authored list of common HYROX ticket categories, used only for the
 * "which ticket did you buy?" dropdown on race-level (sale_watch) purchases
 * - deliberately not fetched from the shop, since exact ticket names vary
 * per event/day and by the time someone's buying we don't want this to
 * depend on re-resolving it. Good enough for a rough category count on
 * /admin/subscribers, not meant to exactly match a shop's ticket_name. */
const TICKET_TYPE_OPTIONS = [
  "HYROX Men",
  "HYROX Women",
  "HYROX Pro Men",
  "HYROX Pro Women",
  "HYROX Doubles Men",
  "HYROX Doubles Women",
  "HYROX Doubles Mixed",
  "HYROX Adaptive Men",
  "HYROX Adaptive Women",
  "HYROX Relay",
  "Other / not sure",
];

async function renderSaleWatchRows(subscriberId: number, token: string, env: Env, priorityOn = false, seasonActive = false): Promise<SaleWatchSections> {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.event_url, sw.event_title, sw.resolved, sw.event_date, sw.presale_note, sw.presale_live_at, sw.presale_timezone, sw.presale_is_live,
       (SELECT COUNT(*) FROM sale_watchers x WHERE x.event_url = w.event_url) AS watching,
       EXISTS(SELECT 1 FROM race_priority rp WHERE rp.subscriber_id = w.subscriber_id AND rp.event_url = w.event_url) AS has_priority
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
      ${entry.subtitle ? `<div class="event-subtitle">${escapeHtml(entry.subtitle)}</div>` : ""}${
        priorityOn && entry.section !== "live" && !r.resolved && r.watching > 1 ? `<div class="event-subtitle">${r.watching} people are watching this race</div>` : ""
      }</div>
      <div class="row" style="gap:6px">
        ${
          seasonActive || r.has_priority
            ? `<span class="event-badge presale" title="You're notified before everyone else">&#9889; ${seasonActive ? "Season Priority" : "Priority"}</span>`
            : priorityOn && entry.section !== "live" && !r.resolved
              ? `<form method="POST" action="/priority/checkout">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="kind" value="race">
          <input type="hidden" name="event_url" value="${escapeHtml(r.event_url)}">
          <button type="submit" title="Be the first to know - notified before everyone else">&#9889; This race ${PRIORITY_PRICE_LABEL}</button>
        </form>`
              : ""
        }
        ${
          entry.section === "live"
            ? `<form method="POST" action="/mark-race-purchased">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="watcher_id" value="${r.id}">
          <select name="ticket_type" required>
            <option value="" disabled selected>Which ticket?</option>
            ${TICKET_TYPE_OPTIONS.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}
          </select>
          <button type="submit" class="buy-btn">I bought this</button>
        </form>`
            : ""
        }
        <form method="POST" action="/remove-sale-watch">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="watcher_id" value="${r.id}">
          <button type="submit">Remove</button>
        </form>
      </div>
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

async function handleSignupPage(req: Request, env: Env, previewPartners = false): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const announcements = await renderAnnouncementsBanner(env);
  const { card: sponsorsCard, rails: sponsorRails } = await renderSponsors(req, env, previewPartners);
  const events = await listDirectoryEvents(env);
  const seo = homeSeo(env);
  const faq = homeFaqHtml();
  const supportersCard = await renderSupportersCard(env);

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
      ${eventSummaryLine(events)}
      <div id="eventList" class="event-list">${eventListHtml(events)}</div>
    </details>`;

  // 2026-11-02: 2 of the 3 Nashville buyers paid for spectator tickets - family and friends
  // didn't know we cover them.
  const SPECTATOR_LINE = "Coming to watch? Spectator tickets sell out too - we alert you when they're back.";
  const stats = await siteStats(env);
  const hero = `<div class="hero">
    <h1>HYROX race alerts: get notified when tickets go on sale or come back</h1>
    <p class="hero-sub">Free alerts for every HYROX race worldwide: tickets on sale, pre-sales, and sold-out spots coming back.</p>
    ${stats.athletes >= 50 ? `<p class="stats-line"><b>${stats.athletes}</b> athletes &middot; <b>${roundDown(stats.alerts)}+</b> alerts sent &middot; <b>${roundDown(stats.returns)}+</b> sold-out tickets <a href="/tickets-back">spotted coming back</a></p>` : ""}
  </div>`;

  const sideOnSaleCard = `<div class="card" id="sideOnSaleCard">
    <h2>Live &amp; upcoming sales</h2>
    <div id="eventListSide" class="event-list"><p>Loading...</p></div>
  </div>`;

  // Tells the page script whether to show the "first" buttons, and with what words.
  // A season holder already has Priority on anything new they watch - no choice to make.
  const seasonHeld = subscriber ? await hasSeasonPass(env, subscriber.id) : false;
  const offerPriority = priorityOfferedTo(env, subscriber) && !seasonHeld;
  // The season is offered to everyone (2026-11-02: hidden from first-timers, nobody bought it);
  // someone who already paid for a race sees it as an upgrade at the difference.
  const seasonLabel = seasonButtonLabel(await seasonPriceFor(env, subscriber?.id));
  const seasonOffer = (button: string): string | null => button;
  const gridFlag = env.TICKET_GRID === "1" ? '<span id="ticketGridOn" hidden></span>' : "";
  const priorityFlag = offerPriority
    ? `<span id="priorityOffer" hidden data-price="${PRIORITY_PRICE_LABEL}" data-choice="${escapeHtml(
        priorityChoiceHtml(
          env,
          "race",
          `<button type="button" id="saleBtn">Notify me - free</button>`,
          `<button type="button" id="salePrioBtn">&#9889; Notify me first - ${PRIORITY_PRICE_LABEL}</button>`,
          seasonOffer(`<button type="button" id="saleSeasonBtn">&#9889; ${seasonLabel}</button>`)
        )
      )}"></span>`
    : "";

  if (subscriber) {
    const counts = await getWatchCounts(subscriber.id, env);
    return page(
      "RoxRaceAlerts",
      `${navBar("/", subscriber, counts.tickets + counts.races, false, env)}
      <div class="layout">
        <div class="main-col">
          ${hero}
          <div class="card">
            <h2>Monitor race tickets</h2>
            <p class="hint">${SPECTATOR_LINE}</p>
            <form method="POST" action="/subscribe" id="signupForm">
              ${searchBox}
              <div class="submit-step" style="display:none">
                ${
                  offerPriority
                    ? priorityChoiceHtml(
                        env,
                        "ticket",
                        `<button type="submit" name="priority" value="0">Watch - free</button>`,
                        `<button type="submit" name="priority" value="1">&#9889; Watch first - ${PRIORITY_PRICE_LABEL}</button>`,
                        seasonOffer(`<button type="submit" name="priority" value="season">&#9889; ${seasonLabel}</button>`)
                      )
                    : `<button type="submit" name="priority" value="0">Add selected ticket(s)</button>`
                }
              </div>
            </form>${priorityFlag}${gridFlag}
            ${browseSection}
          </div>
          ${faq}
          ${raceFooterLinksHtml(events, await listPastRaces(env, events))}
        </div>
        <div class="sidebar">
          ${sideOnSaleCard}
          ${sponsorsCard}
          ${supportersCard}
          ${announcements}
        </div>
      </div>
      ${sponsorRails}${RESOLVE_SCRIPT}`,
      {},
      true,
      seo
    );
  }

  return page(
    HOME_TITLE,
    `${navBar("/", null, 0, true)}
    <div class="layout">
      <div class="main-col">
        ${hero}
        <div class="card">
          <h2>Monitor race tickets</h2>
          <p class="hint">Paste the HYROX event page you care about, pick your ticket(s), enter your email, confirm it, done. ${SPECTATOR_LINE}</p>
          <form method="POST" action="/subscribe" id="signupForm">
            ${searchBox}
            <div class="submit-step" style="display:none">
              <label>Your email
                <input type="email" name="email" required placeholder="you@example.com">
              </label>
              <p class="consent">By subscribing you agree to receive ticket-availability emails for the event(s) selected above. You can unsubscribe at any time, or manage exactly what you're watching, via the links in every email. We don't share your email with anyone.</p>
              ${
                offerPriority
                  ? priorityChoiceHtml(
                      env,
                      "ticket",
                      `<button type="submit" name="priority" value="0">Subscribe - free</button>`,
                      `<button type="submit" name="priority" value="1">&#9889; Subscribe first - ${PRIORITY_PRICE_LABEL}</button>`,
                      seasonOffer(`<button type="submit" name="priority" value="season">&#9889; ${seasonLabel}</button>`)
                    )
                  : `<button type="submit" name="priority" value="0">Subscribe</button>`
              }
            </div>
          </form>${priorityFlag}${gridFlag}
          ${browseSection}
        </div>
        ${faq}
        ${raceFooterLinksHtml(events, await listPastRaces(env, events))}
      </div>
      <div class="sidebar">
        ${sideOnSaleCard}
        ${sponsorsCard}
        ${supportersCard}
        ${announcements}
      </div>
    </div>
    ${sponsorRails}${RESOLVE_SCRIPT}`,
    {},
    true,
    seo
  );
}

/** Crawlers, link-preview fetchers and scripts shouldn't inflate a sponsor's
 * numbers (or be billed to them one day). A user-agent check is only a rough
 * filter - good enough to keep the obvious ones out, not an audit. */
function isBot(req: Request): boolean {
  const ua = req.headers.get("user-agent") || "";
  return !ua || /bot|crawl|spider|slurp|preview|monitor|facebookexternalhit|whatsapp|telegram|curl|wget|python|headless|go-http|java\//i.test(ua);
}

/** Today in UTC as YYYY-MM-DD - sponsor_stats rows are per-day. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Total partner tiles the homepage has room for - also the "X of N spots
 * left" shown on the "your gym here" tiles and the cap on the partners page. */
const SPONSOR_SLOTS = 10;
const RAIL_PASTELS = ["#e9fbf0", "#fdeff6", "#fff5e6", "#f3ecff", "#eaf4ff"];

/** Partner tiles for gyms and brands, two ways at once (CSS shows one):
 *  - rail: a TrustMRR-style column fixed in the empty margin left of the page
 *    on wide screens (>= 1420px), so it stays in view while scrolling;
 *  - card: a "Gyms & partners" list in the sidebar, shown on narrower
 *    screens where there are no margins to use.
 * Both always end with a "your gym / brand here" tile linking to /partners
 * while spots are free, so the offer is visible before anyone has signed up.
 * Real tiles link through /out/<id> to count clicks; rendering counts one
 * view per tile for the day (bots excluded) - the evidence a partner gets. */
/** Master switch for the partner tiles on the public homepage (the left
 * column and the narrow-screen sidebar card). Off while there are no real
 * partners - the sample tiles on their own made the page look worse. The
 * tiles, their data, /partners and the admin preview all stay; flip to true
 * and redeploy to bring the column back. */
const SHOW_PARTNER_TILES = false;

async function renderSponsors(req: Request, env: Env, preview = false): Promise<{ card: string; rails: string }> {
  if (!SHOW_PARTNER_TILES && !preview) return { card: "", rails: "" };
  let results: any[] = []; // real tiles: these count against the 10 spots
  let examples: any[] = []; // clearly-labelled sample tiles: placeholders, never counted
  try {
    const all =
      (
        await env.DB.prepare(
          "SELECT id, name, kind, tagline, location, logo_url, is_example FROM sponsors WHERE active = 1 AND kind != 'supporter' ORDER BY sort_order, id LIMIT ?"
        )
          .bind(SPONSOR_SLOTS + 4)
          .all<any>()
      ).results || [];
    results = all.filter((s: any) => !s.is_example).slice(0, SPONSOR_SLOTS);
    // Samples fill the column only until real tiles take over, and their
    // views/clicks are not tracked - nobody is paying for them.
    examples = preview || results.length < SPONSOR_SLOTS / 2 ? all.filter((s: any) => s.is_example).slice(0, 3) : [];
    if (results.length && !isBot(req)) {
      const day = dayKey();
      await env.DB.batch(
        results.map((s: any) =>
          env.DB.prepare(
            "INSERT INTO sponsor_stats (sponsor_id, day, impressions, clicks) VALUES (?, ?, 1, 0) ON CONFLICT(sponsor_id, day) DO UPDATE SET impressions = impressions + 1"
          ).bind(s.id, day)
        )
      );
    }
  } catch (e) {
    // A broken ad slot must never take the homepage down with it.
    console.error("Failed to load sponsors:", e);
    results = [];
    examples = [];
  }

  // Only real tiles use up a spot, so "N of 10 spots left" is always true.
  const spotsLeft = Math.max(0, SPONSOR_SLOTS - results.length);
  const spotsText = `${spotsLeft} of ${SPONSOR_SLOTS} spots left`;
  const icon = (s: any) =>
    s.logo_url && /^(https:\/\/|\/partner-logo\/\d+$)/i.test(s.logo_url)
      ? `<img src="${escapeHtml(s.logo_url)}" alt="" loading="lazy">`
      : `<span class="sp-ico">${escapeHtml(String(s.name).trim().charAt(0).toUpperCase())}</span>`;
  const tagline = (s: any) =>
    (s.location ? `<small class="sp-loc">${escapeHtml(s.location)}</small>` : "") + (s.tagline ? `<small>${escapeHtml(s.tagline)}</small>` : "");

  // One column, left margin only: samples first, then real partners, then the offer.
  const ordered = [...examples, ...results];
  const railTile = (s: any, i: number) => {
    const bg = RAIL_PASTELS[i % RAIL_PASTELS.length];
    return s.is_example
      ? `<a class="rail-tile" style="background:${bg}" href="${preview ? "#" : "/partners"}">${preview ? "" : '<span class="rail-badge">Example</span>'}${icon(s)}<b>${escapeHtml(s.name)}</b>${tagline(s)}</a>`
      : `<a class="rail-tile" style="background:${bg}" href="/out/${s.id}" target="_blank" rel="sponsored noopener">${icon(s)}<b>${escapeHtml(s.name)}</b>${tagline(s)}</a>`;
  };
  const railCta = spotsLeft
    ? `<a class="rail-tile rail-cta" href="/partners"><span class="sp-ico">+</span><b>Your gym here</b><small>Make your gym known to HYROX athletes worldwide</small><small class="rail-spots">${spotsText}</small></a>`
    : "";
  const previewNote = preview
    ? `<div style="position:fixed;top:8px;right:8px;z-index:20;background:#111;color:#fff;font-size:12px;padding:4px 12px;border-radius:12px">Private preview - visitors don't see this</div>`
    : "";
  const rails = `<div class="rail rail-left">${ordered.map(railTile).join("")}${railCta}</div>${previewNote}`;

  // Narrow screens: the same list as a sidebar card.
  const cardTiles = ordered
    .map((s: any) =>
      s.is_example
        ? `<a class="sponsor" href="${preview ? "#" : "/partners"}">${icon(s)}<span class="sp-body"><b>${escapeHtml(s.name)}${preview ? "" : ' <span class="rail-badge">Example</span>'}</b>${tagline(s)}</span></a>`
        : `<a class="sponsor" href="/out/${s.id}" target="_blank" rel="sponsored noopener">${icon(s)}<span class="sp-body"><b>${escapeHtml(s.name)}</b>${tagline(s)}</span></a>`
    )
    .join("");
  const cardCta = spotsLeft
    ? `<a class="sponsor sponsor-cta" href="/partners"><span class="sp-ico">+</span><span class="sp-body"><b>Your gym or brand here</b><small>Make your name known to HYROX athletes worldwide &middot; ${spotsText}</small></span></a>`
    : "";
  const card = `<div class="card" id="sponsorsCard"><h2>Gyms &amp; partners</h2><div class="sponsors">${cardTiles}${cardCta}</div></div>`;
  return { card, rails };
}

/** Stripe Payment Link for a partner spot (buy.stripe.com/...). Empty until
 * one exists - the "approved, please pay" email then says payment details
 * follow by email instead of linking to it. Not a secret. */
const PARTNER_PAYMENT_URL = "";
const PARTNER_MAX_LOGO_BYTES = 256 * 1024;
const PARTNER_KINDS: Record<string, string> = { gym: "Gym or training club", brand: "Brand or business", coach: "Coach or creator", supporter: "Supporter (free tile for the widget)" };

/** Image type from the file's own first bytes, never from the filename or the
 * browser-supplied type. SVG is deliberately not accepted: it can carry
 * script, and these logos are served from our own domain. */
function detectImageType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** "@yourgym" -> its Instagram page; a bare domain gets https://; anything
 * that isn't https with a real-looking host is refused (no javascript:,
 * no http:). The result is what the tile will link to. */
function normalizePartnerLink(raw: string): string | null {
  let v = raw.trim();
  if (v.startsWith("@")) {
    const handle = v.slice(1).replace(/[^A-Za-z0-9._]/g, "");
    if (!handle) return null;
    v = `https://www.instagram.com/${handle}/`;
  } else {
    v = v.replace(/^http:\/\//i, "https://");
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  }
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The page every "your gym here" tile points to - also the link to send gym
 * owners and brands directly. No price on it on purpose (not decided yet):
 * it explains the placement and takes an application, logo included.
 * Applications are reviewed before anything is shown or charged. */
function partnersPageResponse(subscriber: any, env: Env, error = "", v: Record<string, string> = {}, status = 200): Response {
  const fieldStyle = "width:100%;padding:10px;font-size:1rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin-top:6px;font-family:inherit";
  const kindOptions = Object.entries(PARTNER_KINDS)
    .map(([k, label]) => `<option value="${k}"${v.kind === k ? " selected" : ""}>${label}</option>`)
    .join("");
  const r = page(
    "Partner with RoxRaceAlerts",
    `${navBar("/", subscriber, 0, !subscriber, env)}
    <div class="card">
      <h2>Make your gym known to HYROX athletes worldwide</h2>
      <p>RoxRaceAlerts is where HYROX athletes check when race tickets open, and get an email when sold-out tickets come back. Partner gyms and brands get a tile on the homepage, in front of exactly those people.</p>
      <h2 style="margin-top:20px">What you get</h2>
      <ul>
        <li>Your logo, name and a one-line pitch on the homepage: in the side columns on desktop, in the sidebar on mobile</li>
        <li>A link to your website or Instagram</li>
        <li>On request, how many people saw and clicked your tile</li>
        <li>The first position, at the very top of the column, is a premium spot and costs more - there's only one</li>
      </ul>
      <p class="hint">For HYROX gyms and training clubs, coaches, and brands for hybrid athletes. There are ${SPONSOR_SLOTS} spots in total. Every application is reviewed before anything is shown or charged.</p>
    </div>
    <div class="card">
      <h2>Apply for a spot</h2>
      ${error ? `<p style="color:#b00"><b>${escapeHtml(error)}</b></p>` : ""}
      <form method="POST" action="/partners" enctype="multipart/form-data">
        <label>Gym or brand name
          <input type="text" name="name" required maxlength="60" value="${escapeHtml(v.name || "")}">
        </label>
        <label>We are a
          <select name="kind" style="${fieldStyle}">${kindOptions}</select>
        </label>
        <label>Which spot are you interested in?
          <select name="placement" style="${fieldStyle}"><option value="any"${v.placement === "any" ? " selected" : ""}>Any spot</option><option value="top"${v.placement === "top" ? " selected" : ""}>The top spot (premium)</option></select>
        </label>
        <label>Website or Instagram
          <input type="text" name="link" required maxlength="300" placeholder="https://... or @yourgym" value="${escapeHtml(v.link || "")}">
        </label>
        <label>One-line pitch shown on your tile (optional, max 80 characters)
          <input type="text" name="tagline" maxlength="80" placeholder="e.g. HYROX prep and team training in Zurich" value="${escapeHtml(v.tagline || "")}">
        </label>
        <label>City and country (optional)
          <input type="text" name="location" maxlength="100" value="${escapeHtml(v.location || "")}">
        </label>
        <label>Logo (optional - PNG, JPG or WebP, under 250 KB, square works best)
          <input type="file" name="logo" accept="image/png,image/jpeg,image/webp">
        </label>
        <label>Your email
          <input type="email" name="email" required maxlength="200" placeholder="you@example.com" value="${escapeHtml(v.email || "")}">
        </label>
        <label>Anything else (optional)
          <textarea name="message" rows="3" maxlength="1000" style="${fieldStyle}">${escapeHtml(v.message || "")}</textarea>
        </label>
        <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty <input type="text" name="company_site" tabindex="-1" autocomplete="off"></label></div>
        <p class="consent">We'll only use your email to reply about your application.</p>
        <button type="submit">Apply for a spot</button>
      </form>
    </div>`
  );
  return status === 200 ? r : new Response(r.body, { status, headers: r.headers });
}

async function handlePartnersPage(req: Request, env: Env): Promise<Response> {
  return partnersPageResponse(await getSessionSubscriber(req, env), env);
}

/** Stores an application (logo included, validated by its bytes) as
 * 'pending' and pings the admin by email + Telegram with the review link.
 * Nothing is public until the admin approves it, and the applicant is never
 * emailed from here - so this form can't be used to send mail to a stranger.
 * The hidden company_site field is a honeypot (the public feedback form
 * already draws spam bots): a filled one gets the normal thank-you page but
 * nothing is stored or sent. A daily cap bounds how much junk can pile up. */
async function handlePartnersRequest(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const clip = (x: unknown, n: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const thanks = (email: string) =>
    page(
      "Thanks",
      `<div class="card"><p>Thanks - we've got your application${email ? ` and will reply to <b>${escapeHtml(email)}</b>` : ""}.</p><p><a href="/">Back to RoxRaceAlerts</a></p></div>`
    );
  if (clip(form.get("company_site"), 200)) return thanks("");

  const v = {
    name: clip(form.get("name"), 60),
    kind: clip(form.get("kind"), 10),
    placement: clip(form.get("placement"), 10) === "top" ? "top" : "any",
    link: clip(form.get("link"), 300),
    tagline: clip(form.get("tagline"), 80),
    location: clip(form.get("location"), 100),
    email: clip(form.get("email"), 200).toLowerCase(),
    message: String(form.get("message") ?? "").trim().slice(0, 1000),
  };
  const subscriber = await getSessionSubscriber(req, env);
  const fail = (msg: string) => partnersPageResponse(subscriber, env, msg, v, 400);

  const link = normalizePartnerLink(v.link);
  if (!v.name) return fail("Please enter your gym or brand name.");
  if (!link) return fail("Please enter a website (https://...) or an Instagram handle (@yourgym).");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return fail("Please enter a valid email address.");
  if (!PARTNER_KINDS[v.kind]) v.kind = "gym";

  let logoType: string | null = null;
  let logoB64: string | null = null;
  // The runtime hands back a File for a file input; the bundled type for
  // FormData.get only says string, hence the cast.
  const file = form.get("logo") as unknown as File | string | null;
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > PARTNER_MAX_LOGO_BYTES) return fail("That logo is too large - please use an image under 250 KB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    logoType = detectImageType(bytes);
    if (!logoType) return fail("The logo must be a PNG, JPG or WebP image.");
    logoB64 = bytesToBase64(bytes);
  }

  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM partner_applications WHERE created_at >= datetime('now', '-1 day')").first<any>();
  if ((recent?.n || 0) >= 30) return fail("We're receiving a lot of applications right now - please try again tomorrow.");

  await env.DB.prepare(
    `INSERT INTO partner_applications (name, kind, placement, link, tagline, location, email, message, logo_type, logo_b64)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(v.name, v.kind, v.placement, link, v.tagline || null, v.location || null, v.email, v.message || null, logoType, logoB64)
    .run();

  if (env.ADMIN_EMAIL) {
    try {
      const review = `${env.SITE_URL}/admin/partners?token=${encodeURIComponent(env.WEBHOOK_SECRET)}`;
      const summary = `${v.name} (${PARTNER_KINDS[v.kind]})${v.placement === "top" ? " - wants the TOP spot" : ""}\n${link}${v.location ? `\n${v.location}` : ""}${v.tagline ? `\n"${v.tagline}"` : ""}${logoType ? "\nlogo attached" : "\nno logo"}\nFrom: ${v.email}`;
      await sendEmail(
        env,
        env.ADMIN_EMAIL,
        `Partner application: ${v.name}`,
        `<p>${escapeHtml(summary).replace(/\n/g, "<br>")}</p>${v.message ? `<p>${escapeHtml(v.message).replace(/\n/g, "<br>")}</p>` : ""}<p><a href="${review}">Review applications</a></p>`,
        `${summary}${v.message ? `\n\n${v.message}` : ""}\n\nReview: ${review}`
      );
      await notifyAdminTelegram(env, env.ADMIN_EMAIL, `🤝 Partner application: ${summary}\n${review}`);
    } catch (e) {
      console.error("Failed to notify admin of partner application:", e);
    }
  }
  return thanks(v.email);
}

/** An approved partner's logo, served from our own domain. Only for tiles
 * that are live - a pending or rejected upload is never publicly reachable,
 * so this can't be used as a free image host. Type comes from the bytes
 * checked at upload; nosniff + a locked-down CSP keep it inert. */
async function handlePartnerLogo(env: Env, sponsorId: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT a.logo_type, a.logo_b64 FROM partner_applications a JOIN sponsors s ON s.id = a.sponsor_id
     WHERE s.id = ? AND s.active = 1 AND a.logo_b64 IS NOT NULL`
  )
    .bind(sponsorId)
    .first<any>();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(base64ToBytes(row.logo_b64), {
    headers: {
      "content-type": row.logo_type,
      "cache-control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

/** Review queue: applications waiting for a decision, and approved ones
 * waiting for payment. Approve-then-pay on purpose - a logo or pitch can be
 * refused before anyone has been charged. Logos here are inlined as data:
 * URIs, so pending uploads are visible to the admin only. */
async function handlePartnersAdminPage(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

  const { results } = await env.DB.prepare(
    `SELECT a.*, s.active AS sponsor_active FROM partner_applications a LEFT JOIN sponsors s ON s.id = a.sponsor_id
     WHERE a.status = 'pending' OR (a.status = 'approved' AND s.active = 0)
     ORDER BY a.status = 'pending' DESC, a.id DESC LIMIT 50`
  ).all<any>();

  // Supporter requests: has the widget been seen on their site (its page is the Referer of
  // the widget's data requests) in the last 30 days?
  const { results: hits } = await env.DB.prepare("SELECT host, SUM(hits) AS n FROM widget_hits WHERE day >= date('now', '-30 days') GROUP BY host").all<any>();
  const seen = new Map<string, number>((hits || []).map((h: any) => [h.host, Number(h.n)]));
  const widgetNote = (a: any) => {
    if (a.kind !== "supporter") return "";
    let host = "";
    try {
      host = new URL(a.link).hostname.replace(/^www\./, "");
    } catch {}
    const n = seen.get(host) || 0;
    return n
      ? `<p><b style="color:#1e7e34">✓ Widget seen on ${escapeHtml(host)}</b> <small>(${n} views in 30 days)</small>${a.race_slug ? ` &middot; tile on <a href="/hyrox/${escapeHtml(a.race_slug)}">/hyrox/${escapeHtml(a.race_slug)}</a>` : ""}</p>`
      : `<p><b style="color:#b00">Widget not seen on ${escapeHtml(host || a.link)} yet</b>${a.race_slug ? ` &middot; tile would go on /hyrox/${escapeHtml(a.race_slug)}` : ""}</p>`;
  };
  const btn = (id: number, action: string, label: string, extra = "") =>
    `<button type="submit" name="action" value="${action}" style="margin-top:8px;margin-right:6px;${extra}">${label}</button>`;
  const rows = (results || [])
    .map((a: any) => {
      const pending = a.status === "pending";
      const logo = a.logo_b64
        ? `<img src="data:${escapeHtml(a.logo_type)};base64,${a.logo_b64}" alt="" style="width:56px;height:56px;object-fit:contain;border:1px solid #eee;border-radius:8px;float:right;margin-left:12px">`
        : "";
      return `<div class="card">
        ${logo}
        <p><b>${escapeHtml(a.name)}</b> <small>${escapeHtml(PARTNER_KINDS[a.kind] || a.kind)} &middot; ${pending ? "waiting for review" : "approved, waiting for payment"} &middot; ${escapeHtml(a.created_at)}</small>${a.placement === "top" ? ` <b style="color:#9a6700">wants the TOP spot</b>` : ""}</p>
        <p><a href="${escapeHtml(a.link)}" target="_blank" rel="noopener">${escapeHtml(a.link)}</a>${a.location ? `<br><small>${escapeHtml(a.location)}</small>` : ""}${a.tagline ? `<br>"${escapeHtml(a.tagline)}"` : ""}<br><small>${escapeHtml(a.email)}</small></p>
        ${a.message ? `<p><small>${escapeHtml(a.message).replace(/\n/g, "<br>")}</small></p>` : ""}
        ${widgetNote(a)}
        <form method="POST" action="/admin/partners/decide" style="clear:both">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="id" value="${a.id}">
          ${
            pending
              ? btn(a.id, "live", "Approve &amp; go live (free spot)") + btn(a.id, "pay", "Approve &amp; ask for payment") + btn(a.id, "reject", "Reject", "background:#fff;color:#b00;border:1px solid #e2b3b3")
              : btn(a.id, "activate", "Payment received - go live") + btn(a.id, "reject", "Remove", "background:#fff;color:#b00;border:1px solid #e2b3b3")
          }
        </form>
      </div>`;
    })
    .join("");

  return page(
    "Partner applications",
    `${adminNav(token, "partners")}<p><small><a href="/admin/partners/preview?token=${encodeURIComponent(token)}" target="_blank">Preview the tile column with sample partners, no labels (only you can see it)</a></small></p>${rows || `<div class="card"><p>No applications waiting.</p></div>`}`,
    { "cache-control": "private, no-store" }
  );
}

async function sendPartnerEmail(env: Env, to: string, subject: string, html: string, text: string): Promise<void> {
  try {
    await sendEmail(env, to, subject, html, text);
  } catch (e) {
    // Logged in email_log too; the decision itself has already been saved.
    console.error(`Failed to email partner ${to}:`, e);
  }
}

async function handlePartnersDecide(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const id = Number(String(form.get("id") || ""));
  const action = String(form.get("action") || "");
  const back = Response.redirect(`${env.SITE_URL}/admin/partners?token=${encodeURIComponent(token)}`, 303);

  const a = await env.DB.prepare("SELECT * FROM partner_applications WHERE id = ?").bind(id).first<any>();
  if (!a) return back;

  const liveEmail = () =>
    sendPartnerEmail(
      env,
      a.email,
      `${a.name} is now on RoxRaceAlerts`,
      `<p>Your tile for <b>${escapeHtml(a.name)}</b> is live on <a href="${env.SITE_URL}">${env.SITE_URL}</a> - in the side columns on desktop and in the sidebar on mobile.</p><p>Want to know how many people saw and clicked it? Just reply and ask.</p>`,
      `Your tile for ${a.name} is live on ${env.SITE_URL} - in the side columns on desktop and in the sidebar on mobile.\n\nWant to know how many people saw and clicked it? Just reply and ask.`
    );

  if (a.status === "pending" && (action === "live" || action === "pay")) {
    const created = await env.DB.prepare(
      `INSERT INTO sponsors (name, kind, tagline, location, url, logo_url, active, sort_order, race_slug)
       VALUES (?, ?, ?, ?, ?, NULL, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sponsors), ?)`
    )
      .bind(a.name, a.kind === "brand" ? "brand" : a.kind === "supporter" ? "supporter" : "gym", a.tagline, a.location, a.link, action === "live" ? 1 : 0, a.race_slug || null)
      .run();
    const sponsorId = created.meta.last_row_id;
    if (a.logo_b64) await env.DB.prepare("UPDATE sponsors SET logo_url = ? WHERE id = ?").bind(`/partner-logo/${sponsorId}`, sponsorId).run();
    await env.DB.prepare("UPDATE partner_applications SET status = 'approved', sponsor_id = ? WHERE id = ?").bind(sponsorId, id).run();

    if (action === "live") {
      await liveEmail();
    } else {
      const pay = PARTNER_PAYMENT_URL
        ? { html: `<p>To reserve your spot: <a href="${PARTNER_PAYMENT_URL}">${PARTNER_PAYMENT_URL}</a></p>`, text: `To reserve your spot: ${PARTNER_PAYMENT_URL}` }
        : { html: `<p>We'll send you the payment details shortly.</p>`, text: `We'll send you the payment details shortly.` };
      await sendPartnerEmail(
        env,
        a.email,
        `Your RoxRaceAlerts partner spot: ${a.name}`,
        `<p>Thanks for applying - we'd like to feature <b>${escapeHtml(a.name)}</b> on RoxRaceAlerts.</p>${pay.html}<p>Your tile goes live as soon as payment is confirmed (we switch it on by hand, usually within a day).</p>`,
        `Thanks for applying - we'd like to feature ${a.name} on RoxRaceAlerts.\n\n${pay.text}\n\nYour tile goes live as soon as payment is confirmed (we switch it on by hand, usually within a day).`
      );
    }
  } else if (a.status === "approved" && action === "activate" && a.sponsor_id) {
    await env.DB.prepare("UPDATE sponsors SET active = 1 WHERE id = ?").bind(a.sponsor_id).run();
    await liveEmail();
  } else if (action === "reject") {
    if (a.sponsor_id) await env.DB.prepare("DELETE FROM sponsors WHERE id = ?").bind(a.sponsor_id).run();
    await env.DB.prepare("UPDATE partner_applications SET status = 'rejected', sponsor_id = NULL WHERE id = ?").bind(id).run();
  }
  return back;
}

/** Click-through for a sponsor tile: count the click, then 302 to the stored
 * https URL. The destination only ever comes from the sponsors table (set by
 * the admin or an approved application), never from the request, so this
 * can't be used as an open redirect. */
async function handleSponsorOut(req: Request, env: Env, id: number): Promise<Response> {
  const s = await env.DB.prepare("SELECT url FROM sponsors WHERE id = ? AND active = 1").bind(id).first<any>();
  if (!s || !/^https:\/\//i.test(s.url)) return new Response("Not found", { status: 404 });
  if (!isBot(req)) {
    try {
      await env.DB.prepare(
        "INSERT INTO sponsor_stats (sponsor_id, day, impressions, clicks) VALUES (?, ?, 0, 1) ON CONFLICT(sponsor_id, day) DO UPDATE SET clicks = clicks + 1"
      )
        .bind(id, dayKey())
        .run();
    } catch (e) {
      console.error("Failed to count sponsor click:", e);
    }
  }
  return new Response(null, { status: 302, headers: { Location: s.url, "cache-control": "no-store", "X-Robots-Tag": "noindex" } });
}

// ---------------------------------------------------------------------------
// WhatsApp: subscriber opt-in (code handshake), webhook, STOP, My alerts card
//
// Linking proves phone ownership without us ever asking for a number: the
// subscriber taps "Get alerts on WhatsApp" on My alerts, gets a one-off 6
// character code (valid 30 minutes), and sends "START <code>" to our WhatsApp
// number. Meta tells us (webhook) which phone the message came from - that
// sender number is authenticated by WhatsApp, so it can't be spoofed - and we
// store it against the subscriber who owns that code. STOP (or the button on
// My alerts) clears it again. Until WHATSAPP_OPEN_TO_ALL=1 only the admin's own
// subscriber record is offered the button (the sender is still Meta's test
// number, which can reach almost nobody).
// ---------------------------------------------------------------------------
const WA_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - 32 symbols, no modulo bias on a byte
const WA_STOP_WORDS = new Set(["stop", "stopp", "stop all", "unsubscribe", "cancel", "quit", "end", "arret", "arrêt"]);

function newWhatsAppCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => WA_CODE_ALPHABET[b % WA_CODE_ALPHABET.length]).join("");
}

/** May this subscriber be offered the "link WhatsApp" button right now? */
function whatsappLinkingOpen(env: Env, s: any): boolean {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PUBLIC_NUMBER || !s.verified) return false;
  if (env.WHATSAPP_OPEN_TO_ALL === "1") return true;
  return !!env.ADMIN_EMAIL && String(s.email).toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
}

function renderWhatsAppCard(env: Env, s: any): string {
  const token = escapeHtml(s.unsubscribe_token);
  if (s.whatsapp_phone) {
    const last4 = escapeHtml(String(s.whatsapp_phone).slice(-4));
    return `<div class="card">
      <h2>WhatsApp alerts</h2>
      <p>On for the number ending in <b>${last4}</b> - you get the same alerts as by email. Reply <b>STOP</b> on WhatsApp any time, or:</p>
      <form method="POST" action="/whatsapp/unlink"><input type="hidden" name="token" value="${token}"><button type="submit">Turn off WhatsApp alerts</button></form>
    </div>`;
  }
  if (!whatsappLinkingOpen(env, s)) {
    // Before launch: collect numbers (website opt-in) so nobody has to be asked again.
    // At launch each gets one message asking them to reply START, which also proves the number is theirs.
    if (!s.verified) return "";
    if (s.whatsapp_waitlist_phone) {
      return `<div class="card">
      <h2>WhatsApp alerts</h2>
      <p>Number saved. We'll message <b>${escapeHtml(maskPhone(s.whatsapp_waitlist_phone))}</b> once on WhatsApp - reply <b>START</b> to switch your alerts on.</p>
      <form method="POST" action="/whatsapp/waitlist"><input type="hidden" name="token" value="${token}"><input type="hidden" name="action" value="remove"><button type="submit">Remove my number</button></form>
    </div>`;
    }
    return `<div class="card">
      <h2>WhatsApp alerts</h2>
      <p>Get your alerts on WhatsApp too - included with Priority. Leave your number and we'll message you to switch them on.</p>
      <form method="POST" action="/whatsapp/waitlist">
        <input type="hidden" name="token" value="${token}">
        <input type="tel" name="phone" placeholder="+41 79 123 45 67" autocomplete="tel" required>
        <label><input type="checkbox" name="marketing" value="1"> Also send me occasional RoxRaceAlerts news on WhatsApp</label>
        <button type="submit">Save my WhatsApp number</button>
      </form>
      <p class="consent">Include your country code. We'll send one WhatsApp message to this number asking you to reply START. Your number is only used by RoxRaceAlerts and never shared. For instant alerts today, use Telegram below.</p>
    </div>`;
  }

  const number = String(env.WHATSAPP_PUBLIC_NUMBER).replace(/\D/g, "");
  const expires = s.whatsapp_code_expires ? Date.parse(String(s.whatsapp_code_expires).replace(" ", "T") + "Z") : 0;
  if (s.whatsapp_code && expires > Date.now()) {
    const code = escapeHtml(s.whatsapp_code);
    const link = `https://wa.me/${number}?text=${encodeURIComponent(`START ${s.whatsapp_code}`)}`;
    return `<div class="card">
      <h2>WhatsApp alerts</h2>
      <p>Almost done. Send this message to our WhatsApp number <b>+${escapeHtml(number)}</b>:</p>
      <p style="font-size:1.4rem;letter-spacing:0.05em"><b>START ${code}</b></p>
      <p><a href="${escapeHtml(link)}" target="_blank" rel="noopener"><button type="button">Open WhatsApp with the message ready</button></a></p>
      <p><small>The code works for 30 minutes. Once WhatsApp confirms, <a href="/my-alerts">refresh this page</a>.</small></p>
    </div>`;
  }
  return `<div class="card">
      <h2>WhatsApp alerts</h2>
      <p>Get the same alerts on WhatsApp as well as email. We never ask for your number - you prove it's yours by sending us one message.</p>
      <form method="POST" action="/whatsapp/link"><input type="hidden" name="token" value="${token}"><button type="submit">Get alerts on WhatsApp</button></form>
      <p class="consent">By linking, you agree to receive HYROX ticket alerts on WhatsApp for the races you watch. Reply STOP any time to turn them off.</p>
    </div>`;
}

/** "+41 79 123 45 67" / "0041791234567" -> "41791234567"; null without a country code or if implausible. */
function normalizePhone(raw: string): string | null {
  let t = String(raw || "").trim().replace(/[\s().\/-]/g, "");
  if (t.startsWith("00")) t = "+" + t.slice(2);
  if (!t.startsWith("+")) return null;
  const digits = t.slice(1);
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function maskPhone(digits: string): string {
  const d = String(digits);
  return `+${d.slice(0, 2)} … ${d.slice(-4)}`;
}

/** Waitlist number from a Stripe checkout: only fills an empty slot, never overwrites one the person typed on My alerts. */
async function saveWaitlistPhone(env: Env, subscriberId: number, digits: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE subscribers SET whatsapp_waitlist_phone = ?, whatsapp_waitlist_at = datetime('now') WHERE id = ? AND whatsapp_waitlist_phone IS NULL AND whatsapp_phone IS NULL"
  )
    .bind(digits, subscriberId)
    .run();
}

async function handleWhatsAppWaitlist(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const s = await env.DB.prepare("SELECT id, email, verified FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!s || !s.verified) return page("Not available", `<div class="card"><p>This link is invalid. <a href="/my-alerts">Back to my alerts</a></p></div>`);
  if (form.get("action") === "remove") {
    await env.DB.prepare("UPDATE subscribers SET whatsapp_waitlist_phone = NULL, whatsapp_waitlist_at = NULL, whatsapp_marketing_ok = 0 WHERE id = ?").bind(s.id).run();
  } else {
    const digits = normalizePhone(String(form.get("phone") || ""));
    if (!digits) {
      return page(
        "Check the number",
        `<div class="card"><p>Please enter your WhatsApp number with its country code, e.g. <b>+41 79 123 45 67</b>. <a href="/my-alerts">Back to my alerts</a></p></div>`
      );
    }
    await env.DB.prepare(
      "UPDATE subscribers SET whatsapp_waitlist_phone = ?, whatsapp_waitlist_at = datetime('now'), whatsapp_marketing_ok = ? WHERE id = ?"
    )
      .bind(digits, form.get("marketing") === "1" ? 1 : 0, s.id)
      .run();
    await pingAdmin(env, `📱 WhatsApp number left: ${s.email} +${digits}${form.get("marketing") === "1" ? " (news OK)" : ""}`);
  }
  return new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) } });
}

async function handleWhatsAppLink(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const s = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!s || !whatsappLinkingOpen(env, s)) {
    return page("Not available", `<div class="card"><p>WhatsApp alerts aren't available for this account yet. <a href="/my-alerts">Back to my alerts</a></p></div>`);
  }
  await env.DB.prepare("UPDATE subscribers SET whatsapp_code = ?, whatsapp_code_expires = datetime('now', '+30 minutes') WHERE id = ?")
    .bind(newWhatsAppCode(), s.id)
    .run();
  return new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) } });
}

async function handleWhatsAppUnlink(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const s = await env.DB.prepare("SELECT id FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!s) return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  await env.DB.prepare(
    "UPDATE subscribers SET whatsapp_phone = NULL, whatsapp_linked_at = NULL, whatsapp_code = NULL, whatsapp_code_expires = NULL, whatsapp_opted_out_at = datetime('now') WHERE id = ?"
  )
    .bind(s.id)
    .run();
  return new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) } });
}

/** Meta's one-off check when the callback URL is registered. */
function handleWhatsAppWebhookVerify(req: Request, env: Env): Response {
  const u = new URL(req.url);
  if (
    u.searchParams.get("hub.mode") === "subscribe" &&
    env.WHATSAPP_VERIFY_TOKEN &&
    u.searchParams.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN
  ) {
    return new Response(u.searchParams.get("hub.challenge") || "", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

/** Meta signs every webhook body with the app secret (X-Hub-Signature-256).
 * crypto.subtle.verify compares in constant time. */
async function whatsappSignatureOk(env: Env, raw: string, header: string | null): Promise<boolean> {
  if (!env.WHATSAPP_APP_SECRET || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const sig = Uint8Array.from(header.slice(7).match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WHATSAPP_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(raw));
}

const WA_STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyWhatsAppStatus(env: Env, st: any): Promise<void> {
  const id = String(st?.id || "");
  const status = String(st?.status || "").toLowerCase();
  if (!id || !WA_STATUS_RANK[status]) return;
  const row = await env.DB.prepare("SELECT delivery_status FROM whatsapp_log WHERE message_id = ?").bind(id).first<any>();
  if (!row) return; // a message we didn't log (e.g. sent from the dashboard test console)
  // Statuses can arrive out of order; never step backwards (read -> delivered).
  if (row.delivery_status && (WA_STATUS_RANK[row.delivery_status] || 0) >= WA_STATUS_RANK[status] && status !== "failed") return;
  const e = st?.errors?.[0];
  const err = e ? `${e.code ?? ""} ${e.title ?? e.message ?? ""}`.trim().slice(0, 300) : null;
  await env.DB.prepare("UPDATE whatsapp_log SET delivery_status = ?, status_at = datetime('now'), error = COALESCE(?, error) WHERE message_id = ?")
    .bind(status, err, id)
    .run();
}

async function handleWhatsAppInbound(env: Env, m: any): Promise<void> {
  const from = String(m?.from || "").replace(/\D/g, "");
  if (!from) return;
  // Any message from them - even one we ignore - opens a 24h window in which we may send normal messages.
  await env.DB.prepare("UPDATE subscribers SET whatsapp_last_inbound_at = datetime('now') WHERE whatsapp_phone = ?").bind(from).run();
  if (m?.type !== "text") return;
  // The body is only parsed, never stored or logged: it is a stranger's text.
  const text = String(m?.text?.body || "").trim().slice(0, 200);
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

  if (WA_STOP_WORDS.has(norm)) {
    await env.DB.prepare(
      "UPDATE subscribers SET whatsapp_phone = NULL, whatsapp_linked_at = NULL, whatsapp_opted_out_at = datetime('now') WHERE whatsapp_phone = ?"
    )
      .bind(from)
      .run();
    await sendWhatsAppReply(env, from, "WhatsApp alerts are turned off. Your email alerts continue as before. You can turn WhatsApp back on any time from My alerts on roxracealerts.com.");
    return;
  }

  const upper = text.toUpperCase();
  const code = upper.match(/^(?:START\s+)?([A-HJ-NP-Z2-9]{6})$/)?.[1];
  if (code) {
    const s = await env.DB.prepare("SELECT id FROM subscribers WHERE whatsapp_code = ? AND whatsapp_code_expires > datetime('now')")
      .bind(code)
      .first<any>();
    if (s) {
      await env.DB.prepare(
        "UPDATE subscribers SET whatsapp_phone = ?, whatsapp_linked_at = datetime('now'), whatsapp_last_inbound_at = datetime('now'), whatsapp_opted_out_at = NULL, whatsapp_code = NULL, whatsapp_code_expires = NULL WHERE id = ?"
      )
        .bind(from, s.id)
        .run();
      await sendWhatsAppReply(env, from, "You're set! WhatsApp alerts from RoxRaceAlerts are on: you'll get the same HYROX ticket alerts as by email. Reply STOP any time to turn them off.");
      return;
    }
  }
  // Only answer what looks like an attempt to link; ignore everything else.
  if (code || upper.startsWith("START")) {
    await sendWhatsAppReply(env, from, "That code isn't valid or has expired. Open My alerts on roxracealerts.com and tap \"Get alerts on WhatsApp\" for a new one.");
  }
}

async function handleWhatsAppWebhookPost(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  // Fail closed: without the app secret we cannot tell Meta from anyone else.
  if (!env.WHATSAPP_APP_SECRET) {
    console.error("WhatsApp webhook ignored: WHATSAPP_APP_SECRET is not set");
    return new Response("Not configured", { status: 503 });
  }
  if (!(await whatsappSignatureOk(env, raw, req.headers.get("X-Hub-Signature-256")))) return new Response("Bad signature", { status: 401 });
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("ok");
  }
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== "messages") continue;
      const v = change.value || {};
      if (env.WHATSAPP_PHONE_NUMBER_ID && v.metadata?.phone_number_id && v.metadata.phone_number_id !== env.WHATSAPP_PHONE_NUMBER_ID) continue;
      try {
        for (const st of v.statuses || []) await applyWhatsAppStatus(env, st);
        for (const m of v.messages || []) await handleWhatsAppInbound(env, m);
      } catch (e) {
        // Meta retries anything that isn't a 200 - a bad message must not cause a retry storm.
        console.error("WhatsApp webhook handling failed:", e);
      }
    }
  }
  return new Response("ok");
}

/** Button on the admin WhatsApp card: sends one clearly-labelled test alert to
 * ADMIN_WHATSAPP through the real sendWhatsAppAlert path (normal message if
 * the admin's 24h window is open, template otherwise) and shows exactly what
 * Meta answered, so "is WhatsApp working?" never needs a developer. */
async function handleWhatsAppTestAlert(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  let result: string;
  if (!env.ADMIN_WHATSAPP || !env.WHATSAPP_TOKEN) {
    result = "Not set up: ADMIN_WHATSAPP or WHATSAPP_TOKEN is missing.";
  } else {
    const ok = await sendWhatsAppAlert(env, env.ADMIN_WHATSAPP, "HYROX Basel", "this is a TEST alert, not a real sale.", `${env.SITE_URL}/`);
    const last = await env.DB.prepare("SELECT template, ok, error FROM whatsapp_log ORDER BY id DESC LIMIT 1").first<any>();
    result = ok
      ? `Sent - check your WhatsApp. (Sent as: ${last?.template === WHATSAPP_ALERT_TEXT_LABEL ? "a normal message, because you messaged us in the last 23 hours" : "the approved template"}.)`
      : `Meta refused it: ${String(last?.error || "unknown error").slice(0, 400)}`;
  }
  return page("WhatsApp test", `${adminNav(token, "analytics")}<div class="card"><h2>WhatsApp test alert</h2><p>${escapeHtml(result)}</p></div>`, {
    "cache-control": "private, no-store",
  });
}

/** Registers our webhook with Meta through the Application Subscriptions API
 * (POST /<app id>/subscriptions with an app access token), as an alternative
 * to hunting for the Configuration screen in the dashboard. Admin-only (the
 * admin page's token), and it only ever sends settings the Worker already
 * holds: Meta then calls our verify handshake straight away. The app secret
 * is used for the token and never shown or logged. */
async function handleWhatsAppRegisterWebhook(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

  const missing = (["WHATSAPP_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"] as const).filter((k) => !env[k]);
  let result: string;
  if (missing.length) {
    result = `Not set up yet - missing: ${missing.join(", ")}.`;
  } else {
    try {
      const resp = await fetch(`${WHATSAPP_API}/${env.WHATSAPP_APP_ID}/subscriptions`, {
        method: "POST",
        body: new URLSearchParams({
          object: "whatsapp_business_account",
          callback_url: `${env.SITE_URL}/whatsapp/webhook`,
          verify_token: String(env.WHATSAPP_VERIFY_TOKEN),
          fields: "messages",
          access_token: `${env.WHATSAPP_APP_ID}|${env.WHATSAPP_APP_SECRET}`,
        }),
      });
      const j: any = await resp.json().catch(() => ({}));
      result =
        resp.ok && j.success
          ? "Done: Meta accepted the webhook and will now send WhatsApp messages and delivery receipts to roxracealerts.com."
          : `Meta refused it: ${String(j?.error?.message || resp.status).slice(0, 300)}`;
    } catch (e) {
      result = `Could not reach Meta: ${String(e).slice(0, 200)}`;
    }
  }
  return page("WhatsApp webhook", `${adminNav(token, "analytics")}<div class="card"><h2>WhatsApp webhook</h2><p>${escapeHtml(result)}</p></div>`, {
    "cache-control": "private, no-store",
  });
}

// ---------------------------------------------------------------------------
// Telegram: subscriber opt-in (deep-link handshake), webhook, /stop, My alerts
//
// Same idea as the WhatsApp linking, but simpler and free: Telegram bots may
// message anyone who has pressed Start, any time, with no templates and no 24h
// window. The subscriber taps "Get alerts on Telegram" on My alerts, which
// issues a one-off code and opens t.me/<bot>?start=<code>; pressing Start makes
// Telegram send us "/start <code>" along with the chat id, which we store on
// the subscriber who owns that code. Telegram authenticates the sender, and
// calls our webhook with a secret header only it and we know.
// ---------------------------------------------------------------------------
async function logTelegram(env: Env, chatId: string, kind: string, ok: boolean, error: string | null): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO telegram_log (chat_id, kind, ok, error) VALUES (?, ?, ?, ?)").bind(chatId, kind, ok ? 1 : 0, error).run();
  } catch (e) {
    console.error("Failed to write telegram_log:", e);
  }
}

/** Send one message to one chat. Never throws. A 403 means the person blocked
 * the bot or deleted the chat - they can no longer be reached, so the link is
 * cleared instead of failing on every future alert. */
async function sendTelegramTo(env: Env, chatId: string, text: string, kind: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  let error: string | null = null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: false }),
    });
    if (!resp.ok) {
      const body: any = await resp.json().catch(() => ({}));
      error = `${resp.status} ${body?.description ?? ""}`.trim().slice(0, 300);
      if (resp.status === 403) {
        await env.DB.prepare(
          "UPDATE subscribers SET telegram_chat_id = NULL, telegram_linked_at = NULL, telegram_opted_out_at = datetime('now') WHERE telegram_chat_id = ?"
        )
          .bind(chatId)
          .run();
      }
    }
  } catch (e) {
    error = String(e).slice(0, 300);
  }
  await logTelegram(env, chatId, kind, !error, error);
  if (error) console.error("Telegram send failed:", error);
  return !error;
}

/** One alert to one linked subscriber. The admin's own chat already gets every
 * alert addressed to the admin through notifyAdminTelegram, so it is skipped
 * here to avoid a duplicate. */
async function sendTelegramAlert(env: Env, chatId: string | null | undefined, title: string, message: string, url: string): Promise<void> {
  if (!chatId || String(chatId) === String(env.TELEGRAM_CHAT_ID || "")) return;
  await sendTelegramTo(env, String(chatId), `🎟️ ${title}\n${message}\n${url}\n\nSend /stop to turn off Telegram alerts.`, "alert");
}

function renderTelegramCard(env: Env, s: any): string {
  if (!s.verified || !env.TELEGRAM_BOT_USERNAME || !env.TELEGRAM_BOT_TOKEN) return "";
  const token = escapeHtml(s.unsubscribe_token);
  if (s.telegram_chat_id) {
    return `<div class="card">
      <h2>Telegram alerts</h2>
      <p>On - you get the same alerts as by email. Send <b>/stop</b> to the bot any time, or:</p>
      <form method="POST" action="/telegram/unlink"><input type="hidden" name="token" value="${token}"><button type="submit">Turn off Telegram alerts</button></form>
    </div>`;
  }
  const expires = s.telegram_code_expires ? Date.parse(String(s.telegram_code_expires).replace(" ", "T") + "Z") : 0;
  if (s.telegram_code && expires > Date.now()) {
    const link = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${s.telegram_code}`;
    return `<div class="card">
      <h2>Telegram alerts</h2>
      <p>Almost done. Open Telegram with the button below and press <b>Start</b>:</p>
      <p><a href="${escapeHtml(link)}" target="_blank" rel="noopener"><button type="button">Open Telegram and press Start</button></a></p>
      <p><small>The link works for 30 minutes. Once the bot confirms, <a href="/my-alerts">refresh this page</a>.</small></p>
    </div>`;
  }
  return `<div class="card">
      <h2>Telegram alerts</h2>
      <p>Get the same alerts on Telegram as well as email - free, and instant.</p>
      <form method="POST" action="/telegram/link"><input type="hidden" name="token" value="${token}"><button type="submit">Get alerts on Telegram</button></form>
      <p class="consent">By linking, you agree to receive HYROX ticket alerts on Telegram for the races you watch. Send /stop to the bot any time to turn them off.</p>
    </div>`;
}

async function handleTelegramLink(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const s = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!s || !s.verified || !env.TELEGRAM_BOT_USERNAME || !env.TELEGRAM_BOT_TOKEN) {
    return page("Not available", `<div class="card"><p>Telegram alerts aren't available for this account. <a href="/my-alerts">Back to my alerts</a></p></div>`);
  }
  await env.DB.prepare("UPDATE subscribers SET telegram_code = ?, telegram_code_expires = datetime('now', '+30 minutes') WHERE id = ?")
    .bind(newWhatsAppCode(), s.id)
    .run();
  return new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) } });
}

async function handleTelegramUnlink(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const s = await env.DB.prepare("SELECT id FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!s) return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  await env.DB.prepare(
    "UPDATE subscribers SET telegram_chat_id = NULL, telegram_linked_at = NULL, telegram_code = NULL, telegram_code_expires = NULL, telegram_opted_out_at = datetime('now') WHERE id = ?"
  )
    .bind(s.id)
    .run();
  return new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) } });
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Telegram calls this for every message to the bot. Only a request carrying
 * our secret header (set when the webhook was registered) is believed. */
async function handleTelegramWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response("Not configured", { status: 503 });
  if (!sameSecret(req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }
  if (update?.callback_query) {
    try {
      const data = String(update.callback_query.data || "");
      if (data.startsWith("ig:")) await handleIgDraftButton(env, update.callback_query);
      else if (data.startsWith("upd:")) await handleUpdateButton(env, update.callback_query);
      else if (data.startsWith("nud:")) await handleNudgeButton(env, update.callback_query);
    } catch (e) {
      console.error("Telegram button failed:", e);
    }
    return new Response("ok");
  }
  const msg = update?.message;
  // Private chats only: a bot added to a group would otherwise be talked at by strangers.
  if (!msg || msg.chat?.type !== "private" || typeof msg.text !== "string") return new Response("ok");
  const chatId = String(msg.chat.id);
  const text = msg.text.trim().slice(0, 100);
  try {
    if (env.TELEGRAM_CHAT_ID && chatId === String(env.TELEGRAM_CHAT_ID) && /^\/update_/i.test(text)) {
      await handleUpdateCommand(env, text);
      return new Response("ok");
    }
    if (env.TELEGRAM_CHAT_ID && chatId === String(env.TELEGRAM_CHAT_ID) && /^\/nudge_/i.test(text)) {
      await handleNudgeCommand(env, text);
      return new Response("ok");
    }
    if (env.TELEGRAM_CHAT_ID && chatId === String(env.TELEGRAM_CHAT_ID) && /^\/seo(@\w+)?$/i.test(text)) {
      await sendTelegram(env, await seoReport(env));
      return new Response("ok");
    }
    const upper = text.toUpperCase();
    if (/^\/(STOP|UNSUBSCRIBE)(@\w+)?$/.test(upper) || upper === "STOP") {
      await env.DB.prepare(
        "UPDATE subscribers SET telegram_chat_id = NULL, telegram_linked_at = NULL, telegram_opted_out_at = datetime('now') WHERE telegram_chat_id = ?"
      )
        .bind(chatId)
        .run();
      await sendTelegramTo(env, chatId, "Telegram alerts are turned off. Your email alerts continue as before. You can turn Telegram back on any time from My alerts on roxracealerts.com.", "reply");
      return new Response("ok");
    }
    const code = upper.match(/^\/START(?:@\w+)?\s+([A-HJ-NP-Z2-9]{6})$/)?.[1] || upper.match(/^([A-HJ-NP-Z2-9]{6})$/)?.[1];
    if (code) {
      const s = await env.DB.prepare("SELECT id FROM subscribers WHERE telegram_code = ? AND telegram_code_expires > datetime('now')").bind(code).first<any>();
      if (s) {
        await env.DB.prepare(
          "UPDATE subscribers SET telegram_chat_id = ?, telegram_linked_at = datetime('now'), telegram_opted_out_at = NULL, telegram_code = NULL, telegram_code_expires = NULL WHERE id = ?"
        )
          .bind(chatId, s.id)
          .run();
        await sendTelegramTo(env, chatId, "You're set! Telegram alerts from RoxRaceAlerts are on: you'll get the same HYROX ticket alerts as by email. Send /stop any time to turn them off.", "reply");
        return new Response("ok");
      }
      await sendTelegramTo(env, chatId, "That link isn't valid or has expired. Open My alerts on roxracealerts.com and tap \"Get alerts on Telegram\" for a new one.", "reply");
      return new Response("ok");
    }
    if (upper.startsWith("/START")) {
      await sendTelegramTo(env, chatId, "Hi! I send HYROX ticket alerts. To turn them on, open My alerts on roxracealerts.com and tap \"Get alerts on Telegram\".", "reply");
    }
  } catch (e) {
    // Telegram retries anything that isn't a 200 - a bad update must not cause a retry storm.
    console.error("Telegram webhook handling failed:", e);
  }
  return new Response("ok");
}

// ---------------------------------------------------------------------------
// Priority alerts: paid "be the first to know" - one race, or the whole season
//
// Alerts stay free for everyone. A subscriber can pay once (Stripe Checkout) for
// Priority on one race ($3) or a Season Priority pass ($5.50, every race they watch
// until SEASON_VALID_UNTIL). Both are offered side by side so we can see which one
// people pick (admin analytics counts them).
//
// When a watched shop is detected live - or a sold-out ticket comes back, for season
// holders - Priority holders are alerted at once and everyone else
// PRIORITY_FREE_DELAY_MINUTES later. Free subscribers are only ever held back when
// somebody actually holds Priority for that alert; otherwise nothing changes. With the
// delay at 0 (the default) passes are sold and recorded but nobody is delayed.
// Announcement news and countdown reminders go to everyone at once: they arrive hours
// or days ahead, so a few minutes' head start there is worth nothing.
//
// Purchases are recorded only by the signed Stripe webhook (never by the browser
// coming back from Checkout), so a pass can't be faked by visiting a URL.
// Until PRIORITY_OPEN_TO_ALL=1 the offers are shown to the admin account only.
// ---------------------------------------------------------------------------
const PRIORITY_PRICE_CENTS = 300;
const SEASON_PRICE_CENTS = 550;
const SEASON_LABEL = "26/27";
const SEASON_VALID_UNTIL = "2027-07-31"; // last day the pass counts (UTC date)
const PRIORITY_CURRENCY = "usd";
const PRIORITY_MAX_DELAY_MINUTES = 30;

function money(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}
const PRIORITY_PRICE_LABEL = money(PRIORITY_PRICE_CENTS);
const SEASON_PRICE_LABEL = money(SEASON_PRICE_CENTS);
const SEASON_END_LABEL = new Date(`${SEASON_VALID_UNTIL}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** SQL: does subscriber `subCol` hold a season pass that is still valid? */
function hasSeasonPassSql(subCol: string): string {
  return `EXISTS(SELECT 1 FROM season_pass sp WHERE sp.subscriber_id = ${subCol} AND sp.valid_until >= date('now'))`;
}

/** SQL: is subscriber `subCol` Priority for sold-out tickets of event `nameCol` (that event, or the whole season)? */
function hasTicketPrioritySql(subCol: string, nameCol: string): string {
  // race_priority.event_name is filled in when that race's shop is detected live (checkSaleWatches),
  // so a "This race" pass keeps covering the race's sold-out tickets afterwards.
  return `(EXISTS(SELECT 1 FROM ticket_priority tp WHERE tp.subscriber_id = ${subCol} AND tp.event_name = ${nameCol})
    OR EXISTS(SELECT 1 FROM race_priority rpn WHERE rpn.subscriber_id = ${subCol} AND rpn.event_name = ${nameCol})
    OR ${hasSeasonPassSql(subCol)})`;
}

/** SQL: is subscriber `subCol` Priority for the race at `urlCol` (that race, or the whole season)? */
function hasRacePrioritySql(subCol: string, urlCol: string): string {
  return `(EXISTS(SELECT 1 FROM race_priority rp WHERE rp.subscriber_id = ${subCol} AND rp.event_url = ${urlCol}) OR ${hasSeasonPassSql(subCol)})`;
}

async function hasSeasonPass(env: Env, subscriberId: number): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS x WHERE ${hasSeasonPassSql("?")}`).bind(subscriberId).first<any>());
}

/** Priority is on sale to everyone. Selling "notified first" with no delay configured would be
 * selling nothing, so the public switch only works together with a real delay. */
function priorityPublic(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET && env.PRIORITY_OPEN_TO_ALL === "1" && priorityDelayMs(env) > 0;
}

/** Offers on My alerts etc. (verified subscribers). The admin can always preview. */
function priorityOpen(env: Env, s: any): boolean {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !s?.verified) return false;
  if (priorityPublic(env)) return true;
  return !!env.ADMIN_EMAIL && String(s.email).toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
}

/** The free-or-Priority choice when adding a watch: also shown to new, not-yet-confirmed
 * visitors (s = null when signed out) - they pay, then confirm their email. */
function priorityOfferedTo(env: Env, s: any | null): boolean {
  return s?.verified ? priorityOpen(env, s) : priorityPublic(env);
}

/** Free vs Priority side by side, where a watch is added, so the difference is clear before
 * anyone clicks. The buttons are passed in: fetch-driven ones for races, form submits for tickets. */
function priorityChoiceHtml(env: Env, what: "race" | "ticket", freeButton: string, priorityButton: string, seasonButton: string | null = null): string {
  const when = what === "race" ? "when tickets go on sale" : "when your ticket comes back";
  return `<div class="plan-grid">
      <div class="plan">
        <h3>Free</h3>
        <ul><li>Email alert ${when}</li><li>Free, always</li></ul>
        <p class="plan-note">Priority members are alerted first.</p>
        ${freeButton}
      </div>
      <div class="plan prio">
        <h3>&#9889; Priority <span>${PRIORITY_PRICE_LABEL} once</span></h3>
        <ul>
          <li><b>Alerted the instant we spot it</b> - before everyone else</li>
          <li><b>WhatsApp notification</b></li>
          <li>${what === "race" ? "This race" : "All your tickets at this race"} - no subscription</li>
        </ul>
        ${priorityButton}
        <p class="plan-note">Speeds up your alert; doesn't reserve a ticket. <a href="/terms" target="_blank">Terms</a></p>
      </div>
      ${
        seasonButton
          ? `<div class="plan season">
        <h3>&#9889; Season Priority <span>${SEASON_PRICE_LABEL} once</span></h3>
        <p class="plan-line">Every race and ticket you watch until ${SEASON_END_LABEL} - alerted first, WhatsApp notification.</p>
        ${seasonButton}
      </div>`
          : ""
      }
    </div>`;
}

/** Shown to the admin only while the head start is switched off, so a preview never looks like the real thing. */
function priorityPreviewNote(env: Env): string {
  return priorityDelayMs(env) > 0 ? "" : " (Admin preview: the head start is switched off on this server.)";
}

/** WhatsApp is really sending for everyone. Until then offers say how it gets switched on (add your number, we message you) instead of implying it already sends. */
function whatsappLive(env: Env): boolean {
  return !!env.WHATSAPP_TOKEN && env.WHATSAPP_OPEN_TO_ALL === "1";
}

/** The WhatsApp sentence in Priority offers. How it gets switched on (one WhatsApp message, reply START)
 * is said at checkout and, until whatsappLive(), on the terms page. */
function whatsappIncluded(_env: Env): string {
  return "WhatsApp notifications included.";
}

/** One-line pitch under the race list on My alerts (HTML). */
function priorityExplainer(env: Env, multiRace = false): string {
  return `<b>Priority alerts</b>: get new-ticket emails before anyone else. ${whatsappIncluded(env)} ${PRIORITY_PRICE_LABEL} per race${multiRace ? `, or ${SEASON_PRICE_LABEL} for every race you watch this season` : ""}. One-off payment, no subscription. Priority speeds up your alerts; it doesn't reserve or guarantee a ticket. <a href="/terms">Terms &amp; refunds</a>${escapeHtml(priorityPreviewNote(env))}`;
}

type PriorityKind = "race" | "ticket" | "season";

function priorityForm(token: string, kind: PriorityKind, label: string, target: { eventUrl?: string; subscriptionId?: number } = {}): string {
  return `<form method="POST" action="/priority/checkout" style="display:inline-block;margin-right:8px">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="hidden" name="kind" value="${kind}">
        ${target.eventUrl ? `<input type="hidden" name="event_url" value="${escapeHtml(target.eventUrl)}">` : ""}
        ${target.subscriptionId ? `<input type="hidden" name="subscription_id" value="${target.subscriptionId}">` : ""}
        <button type="submit">${label}</button>
      </form>`;
}

/** The two offers side by side. `race` = the race being offered; null offers the season only. */
function priorityOfferCard(env: Env, token: string, race: { event_url: string; event_title: string } | null, multiRace = false): string {
  return `<div class="card">
      <h2>&#9889; Priority alerts</h2>
      <p><b>Get new-ticket emails before anyone else</b>${race ? ` when ${escapeHtml(race.event_title)} tickets go on sale` : " for everything you watch"}. ${whatsappIncluded(env)}</p>
      ${race ? priorityForm(token, "race", `This race - ${PRIORITY_PRICE_LABEL}`, { eventUrl: race.event_url }) : ""}
      ${multiRace ? priorityForm(token, "season", SEASON_BUTTON_LABEL) : ""}
      <p class="consent">${multiRace ? `Whole season = every race and ticket you watch, including sold-out tickets coming back, until ${SEASON_END_LABEL}. ` : ""}One-off payment, no subscription. Priority speeds up your alerts; it doesn't reserve or guarantee a ticket. <a href="/terms">Terms &amp; refunds</a>${escapeHtml(priorityPreviewNote(env))}</p>
    </div>`;
}

/** The subscriber's not-yet-on-sale races they could still buy Priority for (none for season holders). */
async function priorityCandidates(env: Env, subscriberId: number, eventUrl?: string): Promise<any[]> {
  const { results } = await env.DB.prepare(
    `SELECT sw.event_url, sw.event_title FROM sale_watchers w JOIN sale_watch sw ON sw.event_url = w.event_url
     WHERE w.subscriber_id = ? AND sw.resolved = 0 AND (sw.event_date IS NULL OR sw.event_date >= ?)
       AND (? IS NULL OR sw.event_url = ?)
       AND NOT ${hasRacePrioritySql("w.subscriber_id", "w.event_url")}
     ORDER BY sw.event_date IS NULL, sw.event_date LIMIT 3`
  )
    .bind(subscriberId, todayIso(), eventUrl ?? null, eventUrl ?? null)
    .all<any>();
  return results || [];
}

// Who sells Priority and how to reach them - shown on /terms, which Stripe checks before
// enabling live payments. TODO before launch: confirm both with the business owner.
const SELLER_NAME = "MetaOne AG, Switzerland";
const SUPPORT_EMAIL = "support@roxracealerts.com";
const SELLER_ADDRESS = "MetaOne AG, c/o F10 (Switzerland) AG, Pfingstweidstrasse 110, 8005 Z&uuml;rich, Switzerland";

function handleTermsPage(env: Env): Response {
  return page(
    "Terms & refunds",
    `<div class="card">
      <h1>Terms &amp; refunds</h1>
      <p>RoxRaceAlerts is run by ${escapeHtml(SELLER_NAME)}. Questions or refunds: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
      <h2>Free alerts</h2>
      <p>Race and ticket alerts by email (and Telegram) are free. We check HYROX ticket shops regularly and email you when something you watch changes. We're independent - not affiliated with HYROX or vivenu - and can't guarantee every change is caught or how fast email arrives.</p>
      <h2>Priority alerts</h2>
      <ul>
        <li><b>What you get:</b> when we detect the change you're watching, your alert goes out first; free subscribers watching the same thing get theirs a few minutes later. ${whatsappIncluded(env)}</li>
        ${whatsappLive(env) ? "" : "<li><b>WhatsApp:</b> add your number at checkout or on My alerts and we'll send you one WhatsApp message to switch it on (reply START). Until it's on for your number, your Priority alerts come by email.</li>"}
        <li><b>Prices:</b> ${PRIORITY_PRICE_LABEL} for one race or one ticket watch (that event only), or ${SEASON_PRICE_LABEL} for everything you watch until ${SEASON_END_LABEL}. One-off payments in US dollars, charged by Stripe. No subscription, nothing renews.</li>
        <li><b>What it isn't:</b> Priority speeds up your alert. It doesn't reserve, hold or guarantee a ticket, and we never sell tickets.</li>
      </ul>
      <h2>Refunds</h2>
      <ul>
        <li>Changed your mind? Full refund on request until your first Priority alert has been sent.</li>
        <li>If the race is cancelled or never goes on sale while you hold Priority for it, full refund on request.</li>
        <li>If we fail to alert you before free subscribers, full refund on request.</li>
      </ul>
      <p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from the address you signed up with; refunds go back to the original payment method.</p>
      <p><a href="/">Back to RoxRaceAlerts</a></p>
    </div>`
  );
}

/** Privacy policy, incl. how people opt in to each alert channel (Meta asks for this before
 * allowing a WhatsApp Business number). */
function handlePrivacyPage(): Response {
  return page(
    "Privacy",
    `<div class="card">
      <h1>Privacy</h1>
      <p>RoxRaceAlerts is operated by ${SELLER_ADDRESS}. Contact: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
      <h2>How you sign up (opt-in)</h2>
      <ul>
        <li><b>Email:</b> you enter your email and pick the races or tickets to watch, then confirm with the link we email you. Only then do alerts start.</li>
        <li><b>Telegram:</b> only if you connect it yourself on My alerts and press Start in our bot. Send /stop to turn it off.</li>
        <li><b>WhatsApp:</b> only if you add your number (at checkout or on My alerts) and reply START to our first message. Reply STOP any time to turn it off.</li>
      </ul>
      <p>We only message you about the races and tickets you chose to watch, plus the occasional product update. Every email has an unsubscribe link.</p>
      <h2>What we store</h2>
      <ul>
        <li>Your email address and what you watch.</li>
        <li>If you connect them: your Telegram chat ID and your WhatsApp number.</li>
        <li>If you buy Priority: what you bought. Payments are handled by Stripe; we never see your card details.</li>
        <li>Basic email delivery data (delivered, opened), so we can tell whether alerts arrive.</li>
      </ul>
      <h2>Who processes it for us</h2>
      <p>Cloudflare (hosting and database), Resend (email), Stripe (payments), Telegram and Meta/WhatsApp (only if you connect them). We don't sell or share your data with anyone else.</p>
      <h2>Your choices</h2>
      <p>Unsubscribe at any time from any email, or ask us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> to see or delete your data. We keep it until you unsubscribe or ask us to delete it.</p>
      <p><a href="/">Back to RoxRaceAlerts</a></p>
    </div>`
  );
}

/** Shown right after a signed-in subscriber adds a race watch, when Priority is on offer
 * for it: confirms the (free) watch first, then offers Priority. */
async function handleWatchingPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const eventUrl = new URL(req.url).searchParams.get("event") || "";
  if (!subscriber) return new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/` } });
  const race = await env.DB.prepare(
    "SELECT sw.event_title FROM sale_watchers w JOIN sale_watch sw ON sw.event_url = w.event_url WHERE w.subscriber_id = ? AND w.event_url = ?"
  )
    .bind(subscriber.id, eventUrl)
    .first<any>();
  if (!race) return new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/my-alerts` } });
  const offer = priorityOpen(env, subscriber) ? (await priorityCandidates(env, subscriber.id, eventUrl))[0] : null;
  const counts = await getWatchCounts(subscriber.id, env);
  return page(
    "Watching",
    `${navBar("/my-alerts", subscriber, counts.tickets + counts.races, false, env)}
    <div class="card">
      <h2>&#10003; You're watching ${escapeHtml(race.event_title)}</h2>
      <p>We'll alert you the moment tickets go on sale - free, as always.</p>
    </div>
    ${offer ? priorityOfferCard(env, subscriber.unsubscribe_token, offer, (await watchedRaceCount(env, subscriber.id)) >= 2) : ""}
    <div class="card"><p><a href="/">No thanks - back to the homepage</a> &middot; <a href="/my-alerts">My alerts</a></p></div>`,
    offer ? { "X-Priority-Offer": "1" } : {}
  );
}

function priorityDelayMs(env: Env): number {
  const m = Number(env.PRIORITY_FREE_DELAY_MINUTES);
  return Number.isFinite(m) && m > 0 ? Math.min(m, PRIORITY_MAX_DELAY_MINUTES) * 60_000 : 0;
}

/** Wall-clock pause (not CPU time). hyrox.com refuses bursts from Cloudflare's network with 429s;
 * spacing our requests out gets far more of them through. */
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HYROX_REQUEST_GAP_MS = 1500;
const MAX_BLOCKED_PER_ROUND = 3;

/** D1's datetime('now') format, so values compare correctly against it in SQL. */
function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

interface PriorityItem {
  cents: number;
  name: string;
  description: string;
  metadata: Record<string, string>;
  /** Shown in Stripe's payments list (Description); defaults to `name`. */
  note?: string;
}

function racePriorityItem(env: Env, race: { event_url: string; event_title: string }): PriorityItem {
  return {
    cents: PRIORITY_PRICE_CENTS,
    name: `Priority alerts: ${race.event_title}`.slice(0, 200),
    description: `Get an email before anyone else when tickets for this race go on sale. ${whatsappIncluded(env)} One-off payment, this race only.`,
    metadata: { event_url: race.event_url, event_title: String(race.event_title).slice(0, 400) },
  };
}

function ticketPriorityItem(env: Env, eventName: string): PriorityItem {
  return {
    cents: PRIORITY_PRICE_CENTS,
    name: `Priority alerts: ${eventName}`.slice(0, 200),
    description: `Get an email before anyone else when sold-out tickets for this event come back. ${whatsappIncluded(env)} One-off payment, this event only.`,
    metadata: { event_name: String(eventName).slice(0, 480) },
  };
}

/** How many different races someone watches: race watches plus races they watch tickets at
 * (several tickets at one race count once - a single Priority already covers them). */
async function watchedRaceCount(env: Env, subscriberId: number): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM sale_watchers WHERE subscriber_id = ?1) + (SELECT COUNT(DISTINCT event_name) FROM subscriptions WHERE subscriber_id = ?1 AND purchased_at IS NULL) AS n"
  )
    .bind(subscriberId)
    .first<any>();
  return Number(r?.n) || 0;
}

const SEASON_BUTTON_LABEL = `All races this season - ${SEASON_PRICE_LABEL}`;

/** Season price for this person: anyone who already paid for one race or ticket gets that
 * one payment off ("upgrade"), instead of paying another race price. */
async function seasonPriceFor(env: Env, subscriberId: number | null | undefined): Promise<number> {
  if (!subscriberId) return SEASON_PRICE_CENTS;
  const paid = await env.DB.prepare(
    "SELECT 1 AS x WHERE EXISTS(SELECT 1 FROM race_priority WHERE subscriber_id = ?1 AND amount_cents > 0) OR EXISTS(SELECT 1 FROM ticket_priority WHERE subscriber_id = ?1 AND amount_cents > 0)"
  )
    .bind(subscriberId)
    .first<any>();
  return paid ? SEASON_PRICE_CENTS - PRIORITY_PRICE_CENTS : SEASON_PRICE_CENTS;
}

function seasonButtonLabel(cents: number): string {
  return cents < SEASON_PRICE_CENTS ? `Upgrade: all races this season - ${money(cents)}` : SEASON_BUTTON_LABEL;
}

function seasonPriorityItem(env: Env, cents = SEASON_PRICE_CENTS): PriorityItem {
  return {
    cents,
    name: `Season Priority ${SEASON_LABEL}`,
    description: `New-ticket emails before anyone else, for every race and ticket you watch. ${whatsappIncluded(env)} One-off payment, valid until ${SEASON_END_LABEL}.`,
    metadata: { season: SEASON_LABEL },
  };
}

/** Creates a Stripe Checkout session for one Priority item; its URL, or null if Stripe refused. */
async function startPriorityCheckout(env: Env, s: any, kind: PriorityKind, item: PriorityItem, successPath: string): Promise<string | null> {
  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": PRIORITY_CURRENCY,
    "line_items[0][price_data][unit_amount]": String(item.cents),
    "line_items[0][price_data][product_data][name]": item.name,
    "line_items[0][price_data][product_data][description]": item.description,
    client_reference_id: String(s.id),
    customer_email: s.email,
    "payment_intent_data[description]": (item.note || item.name).slice(0, 900),
    "metadata[subscriber_id]": String(s.id),
    "metadata[kind]": kind,
    success_url: `${env.SITE_URL}${successPath}`,
    cancel_url: `${env.SITE_URL}/my-alerts`,
    // Collect WhatsApp numbers before launch (optional) - see the WhatsApp waitlist.
    "custom_fields[0][key]": "whatsapp",
    "custom_fields[0][label][type]": "custom",
    "custom_fields[0][label][custom]": "WhatsApp number for alerts (optional)",
    "custom_fields[0][type]": "text",
    "custom_fields[0][optional]": "true",
    "custom_text[submit][message]": `Add a WhatsApp number (with country code, e.g. +41 79 123 45 67) and we'll message you on WhatsApp to switch your alerts on - reply START. One-off payment, no subscription. By paying you agree to our terms and refund policy: ${env.SITE_URL}/terms`,
  });
  for (const [k, v] of Object.entries(item.metadata)) params.set(`metadata[${k}]`, v);
  try {
    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const body: any = await resp.json().catch(() => ({}));
    if (resp.ok && body?.url) return body.url;
    console.error("Stripe checkout session failed:", resp.status, body?.error?.message);
  } catch (e) {
    console.error("Stripe checkout request failed:", e);
  }
  return null;
}

/** Does this subscriber already hold Priority covering this race / this event's tickets? */
async function ownsRacePriority(env: Env, subscriberId: number, eventUrl: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 AS x WHERE EXISTS(SELECT 1 FROM race_priority WHERE subscriber_id = ?1 AND event_url = ?2) OR ${hasSeasonPassSql("?1")}`
  )
    .bind(subscriberId, eventUrl)
    .first<any>());
}

async function ownsTicketPriority(env: Env, subscriberId: number, eventName: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 AS x WHERE ${hasTicketPrioritySql("?1", "?2")}`
  )
    .bind(subscriberId, eventName)
    .first<any>());
}

/** After paying, a brand-new visitor still has to confirm their email (alerts need it). */
function handlePriorityThanks(): Response {
  return page(
    "Payment received",
    `<div class="card">
      <h2>&#10003; Payment received - one last step</h2>
      <p>We've sent you a confirmation link by email. <b>Click it to switch your alerts on</b> - Priority starts the moment you confirm.</p>
      <p><small>Don't see it? Check your spam or junk folder.</small></p>
    </div>`
  );
}

async function handlePriorityCheckout(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const kindRaw = String(form.get("kind") || "");
  const kind: PriorityKind = kindRaw === "season" || kindRaw === "ticket" ? kindRaw : "race";
  const eventUrl = String(form.get("event_url") || "");
  const s = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  const notAvailable = () =>
    page("Not available", `<div class="card"><p>Priority isn't available for this right now. <a href="/my-alerts">Back to my alerts</a></p></div>`);
  if (!s || !priorityOpen(env, s)) return notAvailable();
  const backToMyAlerts = new Response(null, { status: 303, headers: { Location: `${env.SITE_URL}/my-alerts`, "Set-Cookie": sessionCookieHeader(token) } });
  // A season holder already has Priority on everything - never sell them something they own.
  if (await hasSeasonPass(env, s.id)) return backToMyAlerts;

  let item: PriorityItem;
  if (kind === "ticket") {
    const subId = Number(form.get("subscription_id")) || 0;
    const sub = await env.DB.prepare("SELECT event_name FROM subscriptions WHERE id = ? AND subscriber_id = ? AND purchased_at IS NULL").bind(subId, s.id).first<any>();
    if (!sub) return notAvailable();
    if (await ownsTicketPriority(env, s.id, sub.event_name)) return backToMyAlerts;
    item = ticketPriorityItem(env, sub.event_name);
  } else if (kind === "season") {
    item = seasonPriorityItem(env, await seasonPriceFor(env, s.id));
  } else {
    const race = await env.DB.prepare(
      `SELECT sw.event_url, sw.event_title, sw.resolved FROM sale_watchers w
       JOIN sale_watch sw ON sw.event_url = w.event_url WHERE w.subscriber_id = ? AND w.event_url = ?`
    )
      .bind(s.id, eventUrl)
      .first<any>();
    if (!race || race.resolved) return notAvailable();
    if (await ownsRacePriority(env, s.id, eventUrl)) return backToMyAlerts;
    item = racePriorityItem(env, race);
  }
  const url = await startPriorityCheckout(env, s, kind, item, "/my-alerts?priority=success");
  if (!url) return page("Payment unavailable", `<div class="card"><p>We couldn't start the payment just now - nothing was charged. <a href="/my-alerts">Back to my alerts</a></p></div>`);
  return new Response(null, { status: 303, headers: { Location: url } });
}

/** Stripe signs `<timestamp>.<raw body>` with the endpoint secret (HMAC-SHA256) and sends it in
 * the Stripe-Signature header as t=...,v1=.... Requests more than 5 minutes old are refused. */
async function stripeSignatureOk(secret: string, raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1" && v) sigs.push(v);
  }
  const ts = Number(t);
  if (!ts || !sigs.length || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((sig) => sameSecret(sig, hex));
}

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Not configured", { status: 503 });
  const raw = await req.text();
  if (!(await stripeSignatureOk(env.STRIPE_WEBHOOK_SECRET, raw, req.headers.get("Stripe-Signature")))) {
    return new Response("Bad signature", { status: 400 });
  }
  let evt: any;
  try {
    evt = JSON.parse(raw);
  } catch {
    return new Response("ok");
  }
  if (evt?.type !== "checkout.session.completed") return new Response("ok");
  const session = evt.data?.object;
  if (!session || session.payment_status !== "paid") return new Response("ok");
  const waField = (session.custom_fields || []).find((f: any) => f?.key === "whatsapp");
  const waRaw = String(waField?.text?.value || "").trim();
  const waPhone = normalizePhone(waRaw);
  const wantsWhatsApp = waRaw || waField?.dropdown?.value === "yes" ? 1 : 0;
  if (waPhone) await saveWaitlistPhone(env, Number(session.metadata?.subscriber_id) || 0, waPhone);
  else if (waRaw && env.TELEGRAM_CHAT_ID) {
    // Typed something we can't use (usually a missing country code) - the admin can fix it by hand.
    await sendTelegramTo(env, env.TELEGRAM_CHAT_ID, `⚠️ Priority buyer ${session.customer_email || session.metadata?.subscriber_id} gave an unusable WhatsApp number: "${waRaw.slice(0, 40)}"`, "reply");
  }

  if (session.metadata?.kind === "ticket") {
    const holder = await env.DB.prepare("SELECT id, email FROM subscribers WHERE id = ?").bind(Number(session.metadata?.subscriber_id) || 0).first<any>();
    const eventName = String(session.metadata?.event_name || "");
    if (!holder || !eventName) {
      console.error("Stripe ticket payment for an unknown subscriber/event:", session.id);
      if (env.TELEGRAM_CHAT_ID) await sendTelegramTo(env, env.TELEGRAM_CHAT_ID, `⚠️ Stripe payment ${session.id} (ticket) could not be matched to a subscriber - check it in Stripe.`, "reply");
      return new Response("ok");
    }
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO ticket_priority (subscriber_id, event_name, stripe_session_id, amount_cents, currency, livemode, wants_whatsapp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(holder.id, eventName, String(session.id), Number(session.amount_total) || 0, String(session.currency || ""), evt.livemode ? 1 : 0, wantsWhatsApp)
      .run();
    if (res.meta.changes && env.TELEGRAM_CHAT_ID) {
      await sendTelegramTo(env, env.TELEGRAM_CHAT_ID, `💰 Ticket Priority bought: ${eventName} by ${holder.email}${wantsWhatsApp ? " · wants WhatsApp" : ""}${evt.livemode ? "" : " (test mode)"}`, "reply");
    }
    return new Response("ok");
  }

  if (session.metadata?.kind === "season") {
    const holder = await env.DB.prepare("SELECT id, email FROM subscribers WHERE id = ?").bind(Number(session.metadata?.subscriber_id) || 0).first<any>();
    if (!holder) {
      console.error("Stripe season payment for an unknown subscriber:", session.id);
      if (env.TELEGRAM_CHAT_ID) await sendTelegramTo(env, env.TELEGRAM_CHAT_ID, `⚠️ Stripe payment ${session.id} (season) could not be matched to a subscriber - check it in Stripe.`, "reply");
      return new Response("ok");
    }
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO season_pass (subscriber_id, season, valid_until, stripe_session_id, amount_cents, currency, livemode, wants_whatsapp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(holder.id, String(session.metadata?.season || SEASON_LABEL), SEASON_VALID_UNTIL, String(session.id), Number(session.amount_total) || 0, String(session.currency || ""), evt.livemode ? 1 : 0, wantsWhatsApp)
      .run();
    if (res.meta.changes && env.TELEGRAM_CHAT_ID) {
      await sendTelegramTo(env, env.TELEGRAM_CHAT_ID, `💰 Season Priority bought by ${holder.email}${wantsWhatsApp ? " · wants WhatsApp" : ""}${evt.livemode ? "" : " (test mode)"}`, "reply");
    }
    return new Response("ok");
  }

  const subscriberId = Number(session.metadata?.subscriber_id);
  const eventUrl = String(session.metadata?.event_url || "");
  const sub = subscriberId ? await env.DB.prepare("SELECT id, email FROM subscribers WHERE id = ?").bind(subscriberId).first<any>() : null;
  const race = eventUrl ? await env.DB.prepare("SELECT event_title FROM sale_watch WHERE event_url = ?").bind(eventUrl).first<any>() : null;
  if (!sub || !race) {
    // Paid for something we can't place - surface it loudly instead of silently swallowing the money.
    console.error("Stripe payment for an unknown subscriber/race:", session.id, subscriberId, eventUrl);
    if (env.TELEGRAM_CHAT_ID) await sendTelegramTo(env, env.TELEGRAM_CHAT_ID, `⚠️ Stripe payment ${session.id} could not be matched to a subscriber/race - check it in Stripe.`, "reply");
    return new Response("ok");
  }
  // A transient DB error must give Stripe a non-200 so it retries the event.
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO race_priority (subscriber_id, event_url, event_title, stripe_session_id, amount_cents, currency, livemode, wants_whatsapp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(sub.id, eventUrl, race.event_title, String(session.id), Number(session.amount_total) || 0, String(session.currency || ""), evt.livemode ? 1 : 0, wantsWhatsApp)
    .run();
  if (res.meta.changes && env.TELEGRAM_CHAT_ID) {
    await sendTelegramTo(env, env.TELEGRAM_CHAT_ID, `💰 Race Priority bought: ${race.event_title} by ${sub.email}${wantsWhatsApp ? " · wants WhatsApp" : ""}${evt.livemode ? "" : " (test mode)"}`, "reply");
  }
  return new Response("ok");
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
  const known = await env.DB.prepare("SELECT title, event_date, on_sale, shop_url FROM event_directory WHERE url = ?").bind(url).first<any>();

  let found: Awaited<ReturnType<typeof resolveEvent>> = null;
  let blocked: unknown = null;
  // Fast path: we already know this race's ticket shop. Country shops (gb.hyrox.com, ...) don't
  // rate-limit us the way hyrox.com does, so most lookups never touch hyrox.com at all.
  if (known?.shop_url) {
    try {
      found = await resolveEvent(known.shop_url);
    } catch (e) {
      if (!(e instanceof FetchBlocked)) throw e;
    }
  }
  // hyrox.com refuses many requests from Cloudflare but usually answers a moment later.
  for (let attempt = 0; !found && attempt < 3; attempt++) {
    if (attempt) await pause(attempt * 1500);
    try {
      found = await resolveEvent(url);
      blocked = null;
      break;
    } catch (e) {
      if (!(e instanceof FetchBlocked)) throw e;
      blocked = e;
    }
  }
  if (found && known && found.shopUrl !== url) {
    await env.DB.prepare("UPDATE event_directory SET shop_url = ? WHERE url = ?").bind(found.shopUrl, url).run();
  }
  if (blocked) {
    // hyrox.com is rate-limiting us. A race our directory knows isn't on sale yet can still be
    // watched (that needs no live data) - otherwise a busy minute would block the sign-up entirely.
    if (known && !known.on_sale) {
      return jsonResponse({ error: "Tickets may not be on sale yet.", not_on_sale: true, event_title: known.title, event_date: known.event_date }, 404);
    }
    return jsonResponse({ error: "HYROX's website is busy right now - please try again in a minute." }, 503);
  }
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
      // Arrived through a friend's referral link (cookie set on the homepage)?
      const refCode = parseCookies(req)[REF_COOKIE] || "";
      const referrer = REF_CODE_RE.test(refCode) ? await env.DB.prepare("SELECT id FROM subscribers WHERE ref_code = ?").bind(refCode).first<any>() : null;
      const src = parseCookies(req)[SRC_COOKIE] || "";
      try {
        await env.DB.prepare(
          "INSERT INTO subscribers (email, verified, verify_token, unsubscribe_token, referred_by, source) VALUES (?, 0, ?, ?, ?, ?)"
        )
          .bind(email, verifyToken, unsubToken, referrer?.id ?? null, /^[a-z0-9_-]{1,20}$/.test(src) ? src : null)
          .run();
      } catch (e) {
        // A sign-up must never fail over tracking (e.g. code deployed before the "source" column exists).
        if (!/no such column: source/.test(String(e))) throw e;
        await env.DB.prepare("INSERT INTO subscribers (email, verified, verify_token, unsubscribe_token, referred_by) VALUES (?, 0, ?, ?, ?)")
          .bind(email, verifyToken, unsubToken, referrer?.id ?? null)
          .run();
      }
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
async function sendVerificationEmailOnly(env: Env, subscriber: any, verifyToken: string): Promise<void> {
  const link = `${env.SITE_URL}/verify?token=${verifyToken}`;
  await sendEmail(
    env,
    subscriber.email,
    "Confirm your RoxRaceAlerts subscription",
    `<p>Click to confirm you want ticket-availability alerts:</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
    `Confirm your subscription: ${link}\n\nIf you didn't request this, ignore this email.`
  );
}

async function sendVerificationEmail(env: Env, subscriber: any, verifyToken: string): Promise<Response> {
  await sendVerificationEmailOnly(env, subscriber, verifyToken);
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

/** Second and last chance, five days after signup, for anyone who ignored
 * the one-day nudge above. Of the ten people who were still unconfirmed on
 * 2026-10-09, eight had already had that nudge and not clicked - most were
 * Outlook/Hotmail/iCloud addresses, where an unknown sender's first email
 * often lands in junk - so this one says to check spam and spells out that
 * no alerts go out until they confirm. Carries the one-click unsubscribe
 * too, as the way out for a mistaken or typo'd signup. Claimed atomically
 * before sending (see sendManualVerificationNotices) and capped at one per
 * subscriber via final_nudge_sent_at. */
async function sendFinalVerificationReminders(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM subscribers
     WHERE verified = 0 AND nudge_sent_at IS NOT NULL AND final_nudge_sent_at IS NULL
       AND created_at <= datetime('now', '-5 days')
     LIMIT 25`
  ).all<any>();

  for (const s of results || []) {
    const claim = await env.DB.prepare(
      "UPDATE subscribers SET final_nudge_sent_at = datetime('now') WHERE id = ? AND final_nudge_sent_at IS NULL"
    )
      .bind(s.id)
      .run();
    if (!claim.meta.changes) continue;

    const { results: races } = await env.DB.prepare(
      `SELECT sw.event_title FROM sale_watchers w JOIN sale_watch sw ON sw.event_url = w.event_url
       WHERE w.subscriber_id = ? ORDER BY sw.event_title`
    )
      .bind(s.id)
      .all<any>();
    const { results: tickets } = await env.DB.prepare(
      "SELECT DISTINCT event_name FROM subscriptions WHERE subscriber_id = ? ORDER BY event_name"
    )
      .bind(s.id)
      .all<any>();
    const watching = [...(races || []).map((r: any) => r.event_title), ...(tickets || []).map((t: any) => t.event_name)];

    const link = `${env.SITE_URL}/verify?token=${s.verify_token}`;
    const unsubLink = `${env.SITE_URL}/unsubscribe?token=${s.unsubscribe_token}`;
    const listHtml = watching.length ? `<p>You asked to be alerted about: <b>${watching.map(escapeHtml).join(", ")}</b>.</p>` : "";
    const listText = watching.length ? `You asked to be alerted about: ${watching.join(", ")}.\n\n` : "";
    try {
      await sendEmail(
        env,
        s.email,
        "Last reminder: confirm to get your HYROX ticket alerts",
        `<p>This is our last reminder. You signed up at roxracealerts.com for HYROX ticket alerts, but until you confirm your email we can't send you any - and a sale could open at any time.</p>${listHtml}<p><b>Click to confirm:</b> <a href="${link}">${link}</a></p><p>Can't find our earlier email? Check your spam or junk folder (Outlook, Hotmail and iCloud often put a first email from a new sender there) and mark it as not spam.</p><p><small>Didn't sign up, or changed your mind? <a href="${unsubLink}">Unsubscribe and delete my address</a>.</small></p>`,
        `This is our last reminder. You signed up at roxracealerts.com for HYROX ticket alerts, but until you confirm your email we can't send you any - and a sale could open at any time.\n\n${listText}Confirm here: ${link}\n\nCan't find our earlier email? Check your spam or junk folder (Outlook, Hotmail and iCloud often put a first email from a new sender there) and mark it as not spam.\n\nDidn't sign up, or changed your mind? Unsubscribe and delete my address: ${unsubLink}`
      );
    } catch (e) {
      console.error(`Failed to send final reminder to ${s.email}:`, e);
    }
  }
}

/** Tells a subscriber the admin activated their alerts by hand (verified = 1
 * with manually_verified_at set, e.g. people who signed up but never clicked
 * their confirmation link). They never saw a "you're confirmed" page, so
 * without this they'd have no idea alerts had started - and no way to say
 * "that wasn't me": the email carries a one-click unsubscribe that deletes
 * the address. Races that opened while they were unverified get called out
 * explicitly, since checkSaleWatches only ever emails watchers who were
 * verified at the moment the sale opened. One attempt per subscriber, success
 * or not (email_log records failures), so a bad address can't retry forever. */
async function sendManualVerificationNotices(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM subscribers
     WHERE verified = 1 AND manually_verified_at IS NOT NULL AND manual_verify_email_sent_at IS NULL
     LIMIT 25`
  ).all<any>();

  for (const s of results || []) {
    // Claim the row before sending, atomically: two overlapping cron
    // invocations both read the same pending list, and stamping *after* the
    // send let one subscriber get the notice twice in the same second.
    const claim = await env.DB.prepare(
      "UPDATE subscribers SET manual_verify_email_sent_at = datetime('now') WHERE id = ? AND manual_verify_email_sent_at IS NULL"
    )
      .bind(s.id)
      .run();
    if (!claim.meta.changes) continue;

    const { results: races } = await env.DB.prepare(
      `SELECT sw.event_title, sw.event_url, sw.resolved FROM sale_watchers w
       JOIN sale_watch sw ON sw.event_url = w.event_url WHERE w.subscriber_id = ? ORDER BY sw.event_title`
    )
      .bind(s.id)
      .all<any>();
    const { results: tickets } = await env.DB.prepare(
      "SELECT event_name, ticket_name FROM subscriptions WHERE subscriber_id = ? AND purchased_at IS NULL ORDER BY event_name, ticket_name"
    )
      .bind(s.id)
      .all<any>();

    const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${s.unsubscribe_token}`;
    const unsubLink = `${env.SITE_URL}/unsubscribe?token=${s.unsubscribe_token}`;
    const raceHtml = (races || [])
      .map((r: any) =>
        r.resolved
          ? `<li><b>${escapeHtml(r.event_title)}</b> &mdash; tickets are <b>already on sale</b>: <a href="${escapeHtml(r.event_url)}">${escapeHtml(r.event_url)}</a></li>`
          : `<li><b>${escapeHtml(r.event_title)}</b> &mdash; we'll email you the moment tickets open</li>`
      )
      .join("");
    const ticketHtml = (tickets || [])
      .map((t: any) => `<li>${escapeHtml(t.event_name)} &mdash; ${escapeHtml(t.ticket_name)} (we'll email you if it becomes available)</li>`)
      .join("");
    const raceText = (races || [])
      .map((r: any) => (r.resolved ? `- ${r.event_title}: tickets are already on sale: ${r.event_url}` : `- ${r.event_title}: we'll email you the moment tickets open`))
      .join("\n");
    const ticketText = (tickets || []).map((t: any) => `- ${t.event_name} - ${t.ticket_name}`).join("\n");

    try {
      await sendEmail(
        env,
        s.email,
        "Your RoxRaceAlerts alerts are now active",
        `<p>You signed up at roxracealerts.com for HYROX ticket alerts but hadn't clicked the confirmation link, so no alerts were being sent to you. We've switched them on so you don't miss a sale - nothing else for you to do.</p><p>You're watching:</p><ul>${raceHtml}${ticketHtml}</ul>${IG_FOLLOW_HTML}<p><small><a href="${myAlertsLink}">Manage my alerts</a> &middot; Didn't sign up, or don't want these? <a href="${unsubLink}">Unsubscribe and delete my address</a>.</small></p>`,
        `You signed up at roxracealerts.com for HYROX ticket alerts but hadn't clicked the confirmation link, so no alerts were being sent to you. We've switched them on so you don't miss a sale - nothing else for you to do.\n\nYou're watching:\n${raceText}${raceText && ticketText ? "\n" : ""}${ticketText}${IG_FOLLOW_TEXT}\n\nManage my alerts: ${myAlertsLink}\nDidn't sign up, or don't want these? Unsubscribe and delete my address: ${unsubLink}`
      );
    } catch (e) {
      console.error(`Failed to send activation notice to ${s.email}:`, e);
    }
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

// ---------------------------------------------------------------------------
// Referrals: every subscriber has a personal link (/?ref=CODE). A friend counts once they signed
// up through it, confirmed their email and watch something. 5 friends unlock Season Priority
// (WhatsApp included), 10 unlock it for life. Variants of one inbox (Gmail dots, "+tags") count
// once. Rewards are season_pass rows with livemode = 2 ("granted", never counted as sales).
// ---------------------------------------------------------------------------
const REF_COOKIE = "rra_ref";
const SRC_COOKIE = "rra_src"; // traffic source from ?src=..., stored as subscribers.source
const REF_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const REFERRAL_SEASON_AT = 5;
const REFERRAL_LIFETIME_AT = 10;
const LIFETIME_VALID_UNTIL = "2099-12-31";

function refLink(env: Env, code: string): string {
  return `${env.SITE_URL}/?ref=${code}`;
}

/** The subscriber's referral code, created on first use. */
async function ensureRefCode(env: Env, subscriber: any): Promise<string> {
  if (subscriber.ref_code) return subscriber.ref_code;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 5; i++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join("");
    try {
      await env.DB.prepare("UPDATE subscribers SET ref_code = ? WHERE id = ? AND ref_code IS NULL").bind(code, subscriber.id).run();
    } catch {
      continue; // taken by someone else (unique index) - try another
    }
    const row = await env.DB.prepare("SELECT ref_code FROM subscribers WHERE id = ?").bind(subscriber.id).first<any>();
    if (row?.ref_code) {
      subscriber.ref_code = row.ref_code;
      return row.ref_code;
    }
  }
  throw new Error("could not create a referral code");
}

/** One key per real inbox: "j.o.e+hyrox@gmail.com" and "joe@gmail.com" are the same person. */
function inboxKey(email: string): string {
  const [user, domain = ""] = email.toLowerCase().split("@");
  const base = user.split("+")[0];
  return domain === "gmail.com" || domain === "googlemail.com" ? `${base.replace(/\./g, "")}@gmail.com` : `${base}@${domain}`;
}

async function referralCount(env: Env, subscriber: { id: number; email: string }): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT s.email FROM subscribers s
     WHERE s.referred_by = ? AND s.verified = 1
       AND (EXISTS(SELECT 1 FROM sale_watchers w WHERE w.subscriber_id = s.id) OR EXISTS(SELECT 1 FROM subscriptions t WHERE t.subscriber_id = s.id))`
  )
    .bind(subscriber.id)
    .all<any>();
  const own = inboxKey(subscriber.email);
  return new Set((results || []).map((r: any) => inboxKey(r.email)).filter((k) => k !== own)).size;
}

/** Called when a referred friend confirms: grants the next reward level the referrer has reached. */
async function checkReferralReward(env: Env, referrerId: number): Promise<void> {
  const ref = await env.DB.prepare("SELECT id, email, unsubscribe_token, referral_level FROM subscribers WHERE id = ?").bind(referrerId).first<any>();
  if (!ref) return;
  const n = await referralCount(env, ref);
  const level = n >= REFERRAL_LIFETIME_AT ? 2 : n >= REFERRAL_SEASON_AT ? 1 : 0;
  if (level <= (Number(ref.referral_level) || 0)) return;
  const claim = await env.DB.prepare("UPDATE subscribers SET referral_level = ? WHERE id = ? AND referral_level < ?").bind(level, ref.id, level).run();
  if (!claim.meta.changes) return;
  const lifetime = level === 2;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO season_pass (subscriber_id, season, valid_until, stripe_session_id, amount_cents, currency, livemode, wants_whatsapp)
     VALUES (?, ?, ?, ?, 0, '', 2, 1)`
  )
    .bind(ref.id, lifetime ? "lifetime" : SEASON_LABEL, lifetime ? LIFETIME_VALID_UNTIL : SEASON_VALID_UNTIL, `referral-${level}-${ref.id}`)
    .run();
  const myAlerts = `${env.SITE_URL}/my-alerts?token=${ref.unsubscribe_token}`;
  const what = lifetime
    ? "Priority, WhatsApp alerts included, is now yours for life."
    : `Priority is now on for every race and ticket you watch until ${SEASON_END_LABEL}, WhatsApp alerts included. Keep sharing: at ${REFERRAL_LIFETIME_AT} friends it's yours for life.`;
  try {
    await sendEmail(
      env,
      ref.email,
      lifetime ? "Priority for life - thank you! 🎉" : "You've unlocked Priority 🎉",
      `<p>${n} friends joined RoxRaceAlerts with your link - thank you!</p><p>${escapeHtml(what)}</p><p>Turn on WhatsApp alerts from <a href="${myAlerts}">My alerts</a>.</p><p>Francesco</p>`,
      `${n} friends joined RoxRaceAlerts with your link - thank you!\n\n${what}\n\nTurn on WhatsApp alerts from My alerts: ${myAlerts}\n\nFrancesco`,
      { fromName: "Francesco from RoxRaceAlerts", replyTo: SUPPORT_EMAIL }
    );
  } catch (e) {
    console.error("referral reward email failed:", e);
  }
  await pingAdmin(env, `🎁 Referral reward: ${ref.email} brought ${n} friends - ${lifetime ? "Priority for life" : "Season Priority"} switched on.`);
}

/** "Get Priority + WhatsApp free" card for signed-in, confirmed subscribers: link, share buttons, progress. */
async function renderInviteCard(env: Env, subscriber: any): Promise<string> {
  if (!subscriber?.verified) return "";
  let code: string;
  try {
    code = await ensureRefCode(env, subscriber);
  } catch {
    return "";
  }
  const link = refLink(env, code);
  const n = await referralCount(env, subscriber);
  const level = Number(subscriber.referral_level) || 0;
  const status =
    level >= 2
      ? `🎉 ${n} friends joined - Priority is yours for life. Thank you!`
      : level === 1
        ? `🎉 Priority unlocked for this season. ${Math.max(0, REFERRAL_LIFETIME_AT - n)} more friend(s) and it's yours for life.`
        : `${n} of ${REFERRAL_SEASON_AT} friends joined`;
  const share = `I use RoxRaceAlerts to get alerted the second HYROX tickets go on sale or come back. It's free: ${link}`;
  return `<div class="card" id="inviteCard">
    <h2>Get Priority + WhatsApp free</h2>
    <p>Share your link with your training partners and in your HYROX WhatsApp groups.</p>
    <ul><li><b>${REFERRAL_SEASON_AT} friends</b> sign up: Priority + WhatsApp for the season</li><li><b>${REFERRAL_LIFETIME_AT} friends</b> sign up: free for life</li></ul>
    <input type="text" readonly value="${escapeHtml(link)}" onclick="this.select()">
    <p><button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(link)}');this.textContent='Copied!'">Copy link</button>
    <a href="https://wa.me/?text=${encodeURIComponent(share)}" target="_blank" rel="noopener"><button type="button">Share on WhatsApp</button></a></p>
    <p class="hint">${escapeHtml(status)}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// One-off update email to every subscriber, confirmed or not (Priority, WhatsApp, referral link, feedback).
// Started from the admin's Telegram (/update_test, /update_send); the frequent checks then send
// it in small batches, only in the morning (UPDATE_EMAIL_SWISS_HOURS) and at most
// UPDATE_EMAIL_PER_DAY per Swiss day, so the alerts themselves keep room in the email provider's
// daily limit. update_email_sent_at makes it once per subscriber.
// ---------------------------------------------------------------------------
const UPDATE_EMAIL_PER_DAY = 50;
const UPDATE_EMAIL_SWISS_HOURS = [9, 10]; // sends start at 09:00 Swiss time, none after 10:00

/** Minutes Swiss time is ahead of UTC right now (60 in winter, 120 in summer). */
function zurichOffsetMinutes(now = new Date()): number {
  const wall = (tz: string) => Date.parse(new Date(now.toLocaleString("en-US", { timeZone: tz })).toISOString());
  return Math.round((wall("Europe/Zurich") - wall("UTC")) / 60000);
}
const UPDATE_EMAIL_SUBJECT = "Priority alerts + WhatsApp alerts";

async function updateEmailContent(env: Env, s: any): Promise<{ subject: string; html: string; text: string }> {
  const link = refLink(env, await ensureRefCode(env, s));
  const linkLabel = link.replace(/^https?:\/\//, "");
  const myAlerts = `${env.SITE_URL}/my-alerts?token=${s.unsubscribe_token}`;
  const unsub = `${env.SITE_URL}/unsubscribe?token=${s.unsubscribe_token}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`I use RoxRaceAlerts to get alerted the second HYROX tickets go on sale or come back. It's free: ${link}`)}`;
  const intro =
    "I'm Francesco. I am HYROX Pro athlete, I used my coding skills to build RoxRaceAlerts out of pure frustration as I kept not having a simple free tool to monitors races and tickets and decided to make it available to anyone. Thanks for being one of the first to use it!";
  const news: [string, string][] = [
    ["Priority alerts:", "since so many people monitor the same races, we have introduced Priority. With just $3 per race you can receive notifications of some tickets available before others."],
    ["WhatsApp alerts:", "with Priority you also get WhatsApp notifications."],
    ["Telegram alerts:", "free for everyone. Get your alerts on Telegram too."],
    ["Easier interface:", "we made the interface easier."],
  ];
  const rewards = [
    `At least ${REFERRAL_SEASON_AT} friends sign up and use RoxRaceAlerts: Priority + WhatsApp free for the season.`,
    `Share it in your HYROX WhatsApp groups: if at least ${REFERRAL_LIFETIME_AT} people sign up, you get all these benefits free for life.`,
  ];
  const feedback = "Tell me what to improve or what you would like to see. Just reply to this email, it comes straight to me.";
  // Never-confirmed subscribers get it too, with their confirm link: until they click it, no alerts go out.
  const confirmLink = !s.verified && s.verify_token ? `${env.SITE_URL}/verify?token=${s.verify_token}` : "";
  const confirmNote = "P.S. You haven't confirmed your email yet, so your alerts are not switched on. Confirm here:";
  // Layout for skimming (the words are the admin's own and stay as written): short paragraphs, clear
  // headings, key numbers in bold, the link as plain text (a big link button looked like spam), and a
  // Share on WhatsApp button. Inline styles - email clients
  // ignore <style> blocks.
  const h = (t: string) => `<h2 style="font-size:18px;margin:28px 0 10px;color:#111">${t}</h2>`;
  const li = (t: string) => `<li style="margin:0 0 10px">${t}</li>`;
  const boldNumbers = (t: string) => escapeHtml(t).replace(/(At least \d+ friends|at least \d+ people|free for life)/g, "<b>$1</b>");
  const [introA, introB] = intro.split(/(?<=available to anyone\.) /);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#222;max-width:560px">
<p>Hi HYROX athlete,</p>
<p>${escapeHtml(introA)}</p>
${introB ? `<p>${escapeHtml(introB)}</p>` : ""}
${h("What's new")}
<ul style="padding-left:20px;margin:0">${news.map(([k, v]) => li(`<b>${k}</b> ${escapeHtml(v)}`)).join("")}</ul>
${h("Priority + WhatsApp for free")}
<p style="margin:0 0 12px">Share your personal link: <a href="${link}"><b>${escapeHtml(linkLabel)}</b></a></p>
<ul style="padding-left:20px;margin:0">${rewards.map((r) => li(boldNumbers(r))).join("")}</ul>
<p style="margin:6px 0 0"><a href="${wa}" style="display:inline-block;background:#25d366;color:#fff;font-weight:bold;padding:10px 16px;border-radius:8px;text-decoration:none">Share on WhatsApp</a></p>
${h("Feedback")}
<p>${escapeHtml(feedback)}</p>
<p style="margin-top:24px">Francesco</p>
${confirmLink ? `<p style="margin-top:20px"><b>${escapeHtml(confirmNote)}</b> <a href="${confirmLink}">${confirmLink}</a></p>` : ""}
<p style="margin-top:28px;font-size:12px;color:#888"><a href="${myAlerts}" style="color:#888">Manage my alerts</a> &middot; <a href="${unsub}" style="color:#888">Unsubscribe</a></p>
</div>`;
  const text = `Hi HYROX athlete,

${intro}

What's new
${news.map(([k, v]) => `- ${k} ${v}`).join("\n")}

Priority + WhatsApp for free
Share your personal link: ${link}
${rewards.map((r) => `- ${r}`).join("\n")}

Feedback
${feedback}

Francesco
${confirmLink ? `\n${confirmNote} ${confirmLink}\n` : ""}
Manage my alerts: ${myAlerts}
Unsubscribe: ${unsub}`;
  return { subject: UPDATE_EMAIL_SUBJECT, html, text };
}

async function sendUpdateEmailTo(env: Env, s: any): Promise<void> {
  const c = await updateEmailContent(env, s);
  await sendEmail(env, s.email, c.subject, c.html, c.text, { fromName: "Francesco from RoxRaceAlerts", replyTo: SUPPORT_EMAIL });
}

async function updateEmailState(env: Env): Promise<{ status: string; started_at?: string } | null> {
  const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'update_email'").first<any>();
  try {
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

/** Subscribers who existed when the send started and haven't had it yet. */
async function updateEmailPending(env: Env, startedAt: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE update_email_sent_at IS NULL AND created_at <= ?").bind(startedAt).first<any>();
  return Number(r?.n) || 0;
}

/** Part of the frequent checks: sends the next batch while a send is running. */
async function sendUpdateEmails(env: Env): Promise<void> {
  const state = await updateEmailState(env);
  if (state?.status !== "sending" || !state.started_at) return;
  const offset = zurichOffsetMinutes();
  const hour = new Date(Date.now() + offset * 60000).getUTCHours();
  if (hour < UPDATE_EMAIL_SWISS_HOURS[0] || hour >= UPDATE_EMAIL_SWISS_HOURS[1]) return;
  const today = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM subscribers WHERE date(update_email_sent_at, ?1) = date('now', ?1)"
  )
    .bind(`+${offset} minutes`)
    .first<any>();
  const room = Math.min(15, UPDATE_EMAIL_PER_DAY - (Number(today?.n) || 0));
  if (room <= 0) return;
  const { results } = await env.DB.prepare(
    "SELECT * FROM subscribers WHERE update_email_sent_at IS NULL AND created_at <= ? ORDER BY id LIMIT ?"
  )
    .bind(state.started_at, room)
    .all<any>();
  if (!results?.length) {
    await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('update_email', ?)").bind(JSON.stringify({ ...state, status: "done", done_at: new Date().toISOString() })).run();
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE update_email_sent_at IS NOT NULL").first<any>();
    await pingAdmin(env, `📨 Update email finished: sent to ${Number(sent?.n) || 0} subscribers.`);
    return;
  }
  for (const s of results) {
    const claim = await env.DB.prepare("UPDATE subscribers SET update_email_sent_at = datetime('now') WHERE id = ? AND update_email_sent_at IS NULL").bind(s.id).run();
    if (!claim.meta.changes) continue;
    try {
      await sendUpdateEmailTo(env, s);
    } catch (e) {
      console.error(`update email to ${s.email} failed:`, e); // in email_log; not retried
    }
    await pause(600); // the email API allows a couple of requests a second
  }
}

/** Admin's Telegram: /update_test sends the email to ADMIN_EMAIL, /update_send asks to start the
 * send (with a confirm button), /update_status shows progress. */
async function handleUpdateCommand(env: Env, text: string): Promise<void> {
  const reply = (t: string, markup?: object) =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: t, ...(markup ? { reply_markup: markup } : {}) }),
    });
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const state = await updateEmailState(env);
  if (cmd === "/update_test") {
    const me = env.ADMIN_EMAIL ? await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(env.ADMIN_EMAIL.toLowerCase()).first<any>() : null;
    if (!me) {
      await reply(`${env.ADMIN_EMAIL || "ADMIN_EMAIL"} isn't a subscriber, so there's no personal link to show. Sign up with it first.`);
      return;
    }
    await sendUpdateEmailTo(env, me);
    await reply(`Test sent to ${me.email}. Send /update_send when it looks right.`);
    return;
  }
  if (cmd === "/update_send") {
    if (state?.status === "sending") {
      await reply("It's already sending. /update_status shows progress.");
      return;
    }
    const n = await updateEmailPending(env, new Date().toISOString().replace("T", " ").slice(0, 19));
    await reply(`Send the update email to all ${n} subscribers? It goes out from ${UPDATE_EMAIL_SWISS_HOURS[0]}:00 Swiss time, ${UPDATE_EMAIL_PER_DAY} a day at most.`, {
      inline_keyboard: [[{ text: `📨 Send to ${n}`, callback_data: "upd:send" }]],
    });
    return;
  }
  if (cmd === "/update_status") {
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE update_email_sent_at IS NOT NULL").first<any>();
    const left = state?.started_at ? await updateEmailPending(env, state.started_at) : 0;
    await reply(`Update email: ${state?.status || "not started"} · sent ${Number(sent?.n) || 0} · left ${left}\n\n${await updateEmailStats(env, state?.started_at)}`);
  }
}

// ---------------------------------------------------------------------------
// Email analytics: Resend reports what happened to each email (delivered, opened, clicked,
// bounced, marked as spam) to /resend/webhook. Opens need "open tracking" on in Resend and are
// approximate (Apple Mail opens everything; some clients block the pixel).
// ---------------------------------------------------------------------------

/** Resend signs webhooks the Svix way: HMAC-SHA256 of "id.timestamp.body" with the whsec_ key. */
async function verifyResendWebhook(req: Request, body: string, secret: string): Promise<boolean> {
  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const sigs = req.headers.get("svix-signature");
  if (!id || !ts || !sigs || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return sigs.split(" ").some((s) => {
    const [version, sig] = s.split(",");
    return version === "v1" && !!sig && sameSecret(sig, expected);
  });
}

async function handleResendWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.RESEND_WEBHOOK_SECRET) return new Response("Not configured", { status: 503 });
  const body = await req.text();
  if (!(await verifyResendWebhook(req, body, env.RESEND_WEBHOOK_SECRET))) return new Response("Forbidden", { status: 403 });
  let evt: any;
  try {
    evt = JSON.parse(body);
  } catch {
    return new Response("ok");
  }
  const type = String(evt?.type || "").replace(/^email\./, "");
  const emailId = String(evt?.data?.email_id || "");
  if (type && emailId) {
    // First event of each type per email: "opened" counts people, not repeat opens.
    await env.DB.prepare("INSERT OR IGNORE INTO email_events (resend_id, type, created_at) VALUES (?, ?, ?)")
      .bind(emailId, type, String(evt.created_at || new Date().toISOString()))
      .run();
  }
  return new Response("ok");
}

/** Numbers for the update email: what Resend reported, plus what the email led to. */
async function updateEmailStats(env: Env, startedAt?: string): Promise<string> {
  const ev = await env.DB.prepare(
    `SELECT e.type, COUNT(DISTINCT e.resend_id) AS n FROM email_events e
     JOIN email_log l ON l.resend_id = e.resend_id WHERE l.subject = ? GROUP BY e.type`
  )
    .bind(UPDATE_EMAIL_SUBJECT)
    .all<any>();
  const by = Object.fromEntries((ev.results || []).map((r: any) => [r.type, Number(r.n) || 0]));
  const tracked = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE subject = ? AND resend_id IS NOT NULL").bind(UPDATE_EMAIL_SUBJECT).first<any>();
  const t = Number(tracked?.n) || 0;
  const pct = (n: number) => (t ? ` (${Math.round((100 * n) / t)}%)` : "");
  const since = startedAt || "9999";
  const friends = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE referred_by IS NOT NULL AND created_at >= ?").bind(since).first<any>();
  const confirmed = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE referred_by IS NOT NULL AND verified = 1 AND created_at >= ?").bind(since).first<any>();
  const bought = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM race_priority WHERE livemode = 1 AND created_at >= ?1) + (SELECT COUNT(*) FROM ticket_priority WHERE livemode = 1 AND created_at >= ?1)
       + (SELECT COUNT(*) FROM season_pass WHERE livemode = 1 AND created_at >= ?1) AS n`
  )
    .bind(since)
    .first<any>();
  return [
    `📊 Tracked emails: ${t}${t ? "" : " (tracking starts with the next batch)"}`,
    `Delivered ${by.delivered || 0}${pct(by.delivered || 0)} · Opened ${by.opened || 0}${pct(by.opened || 0)} · Clicked ${by.clicked || 0}${pct(by.clicked || 0)}`,
    `Bounced ${by.bounced || 0} · Marked spam ${by.complained || 0}`,
    `Since the send: ${Number(friends?.n) || 0} friends signed up via links (${Number(confirmed?.n) || 0} confirmed) · ${Number(bought?.n) || 0} Priority bought`,
  ].join("\n");
}

async function handleUpdateButton(env: Env, cb: any): Promise<void> {
  const answer = (t: string) =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id, text: t }),
    });
  if (!env.TELEGRAM_CHAT_ID || String(cb.from?.id) !== String(env.TELEGRAM_CHAT_ID) || cb.data !== "upd:send") {
    await answer("Not allowed.");
    return;
  }
  const state = await updateEmailState(env);
  if (state?.status === "sending") {
    await answer("Already sending.");
    return;
  }
  const value = { status: "sending", started_at: new Date().toISOString().replace("T", " ").slice(0, 19) };
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('update_email', ?)").bind(JSON.stringify(value)).run();
  await answer("Sending started.");
  await pingAdmin(env, `📨 Update email: sending started (from ${UPDATE_EMAIL_SWISS_HOURS[0]}:00 Swiss time, ${UPDATE_EMAIL_PER_DAY} a day at most). /update_status shows progress.`);
}

// ---------------------------------------------------------------------------
// Priority nudge (2026-11-02): one email per free user who watches something, at least a day after
// they started watching - "many people are monitoring these tickets, Priority is alerted first".
// Switched on from the admin's Telegram (/nudge_test, /nudge_start, /nudge_stop, /nudge_status);
// once on it keeps going for new watchers. nudge_sent makes it once per person. Mornings only and
// NUDGE_PER_DAY at most, like the update email, so alerts keep room in the email provider's limit.
// ---------------------------------------------------------------------------
const NUDGE_SUBJECT = "Many people are watching the same HYROX tickets";
const NUDGE_PER_DAY = 40;

/** Free, confirmed users with a live watch started at least a day ago who haven't had the nudge. */
const NUDGE_CANDIDATES_SQL = `SELECT s.* FROM subscribers s
  WHERE s.verified = 1
    AND NOT EXISTS(SELECT 1 FROM nudge_sent n WHERE n.subscriber_id = s.id)
    AND NOT EXISTS(SELECT 1 FROM race_priority r WHERE r.subscriber_id = s.id)
    AND NOT EXISTS(SELECT 1 FROM ticket_priority t WHERE t.subscriber_id = s.id)
    AND NOT EXISTS(SELECT 1 FROM season_pass p WHERE p.subscriber_id = s.id AND p.valid_until >= date('now'))
    AND (EXISTS(SELECT 1 FROM subscriptions x WHERE x.subscriber_id = s.id AND x.purchased_at IS NULL
                AND (x.event_date IS NULL OR x.event_date >= date('now')) AND x.created_at <= datetime('now', '-1 day'))
      OR EXISTS(SELECT 1 FROM sale_watchers y JOIN sale_watch w ON w.event_url = y.event_url
                WHERE y.subscriber_id = s.id AND w.resolved = 0 AND (w.event_date IS NULL OR w.event_date >= date('now'))
                  AND y.created_at <= datetime('now', '-1 day')))
  ORDER BY s.id`;

async function ensureNudgeTable(env: Env): Promise<void> {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS nudge_sent (subscriber_id INTEGER PRIMARY KEY, sent_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
}

/** The email for one person: the race (and tickets) of theirs that most people watch. */
async function nudgeEmailContent(env: Env, s: any): Promise<{ subject: string; html: string; text: string } | null> {
  const ticketRace = await env.DB.prepare(
    `SELECT x.event_name, group_concat(x.ticket_name, '||') AS tickets,
            (SELECT COUNT(DISTINCT o.subscriber_id) FROM subscriptions o WHERE o.event_name = x.event_name AND o.purchased_at IS NULL) AS watchers
     FROM subscriptions x WHERE x.subscriber_id = ? AND x.purchased_at IS NULL AND (x.event_date IS NULL OR x.event_date >= date('now'))
     GROUP BY x.event_name ORDER BY watchers DESC LIMIT 1`
  )
    .bind(s.id)
    .first<any>();
  const saleRace = ticketRace
    ? null
    : await env.DB.prepare(
        `SELECT w.event_title, (SELECT COUNT(*) FROM sale_watchers o WHERE o.event_url = w.event_url) AS watchers
         FROM sale_watchers y JOIN sale_watch w ON w.event_url = y.event_url
         WHERE y.subscriber_id = ? AND w.resolved = 0 AND (w.event_date IS NULL OR w.event_date >= date('now'))
         ORDER BY watchers DESC LIMIT 1`
      )
        .bind(s.id)
        .first<any>();
  if (!ticketRace && !saleRace) return null;
  const race = shortRaceName(String(ticketRace?.event_name || saleRace?.event_title)).name;
  const tickets = ticketRace
    ? String(ticketRace.tickets).split("||").map((t) => t.replace(/^HYROX /i, ""))
    : [];
  const ticketLine = tickets.length ? `${tickets.slice(0, 3).join(", ")}${tickets.length > 3 ? ` and ${tickets.length - 3} more` : ""}` : "";
  const multiRace = (await watchedRaceCount(env, s.id)) >= 2;
  const myAlerts = `${env.SITE_URL}/my-alerts?token=${s.unsubscribe_token}`;
  const unsub = `${env.SITE_URL}/unsubscribe?token=${s.unsubscribe_token}`;
  // No per-race numbers (the admin's call): most races have few watchers; "many people" is true site-wide.
  const what = ticketRace ? `${race} tickets (${ticketLine})` : `${race} tickets`;
  const firstLine = ticketRace
    ? `Many people are monitoring these tickets. When a ticket comes back, Priority members get the alert first.`
    : `Many people are waiting for these tickets. When the sale opens, Priority members get the alert first.`;
  const season = `${multiRace ? "Watching several races? " : "Racing more than once this season? "}Season Priority covers every race and ticket you watch until ${SEASON_END_LABEL} for ${SEASON_PRICE_LABEL}.`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#222;max-width:560px">
<p>Hi HYROX athlete,</p>
<p>You're watching ${escapeHtml(what)}.</p>
<p><b>${escapeHtml(firstLine)}</b></p>
<p><a href="${myAlerts}" style="display:inline-block;background:#111;color:#fff;font-weight:bold;padding:10px 16px;border-radius:8px;text-decoration:none">&#9889; Get Priority for ${PRIORITY_PRICE_LABEL}</a></p>
<p>${escapeHtml(season)}</p>
<p><a href="${myAlerts}" style="display:inline-block;background:#f5b400;color:#111;font-weight:bold;padding:10px 16px;border-radius:8px;text-decoration:none">&#9889; All races this season - ${SEASON_PRICE_LABEL}</a></p>
<p style="font-size:14px;color:#555">One-off payments, no subscription. Priority speeds up your alert; it doesn't reserve a ticket.</p>
<p style="margin-top:24px">Francesco</p>
<p style="margin-top:28px;font-size:12px;color:#888"><a href="${myAlerts}" style="color:#888">Manage my alerts</a> &middot; <a href="${unsub}" style="color:#888">Unsubscribe</a></p>
</div>`;
  const text = `Hi HYROX athlete,

You're watching ${what}.

${firstLine}

Get Priority for ${PRIORITY_PRICE_LABEL}: ${myAlerts}

${season}
All races this season - ${SEASON_PRICE_LABEL}: ${myAlerts}

One-off payments, no subscription. Priority speeds up your alert; it doesn't reserve a ticket.

Francesco

Unsubscribe: ${unsub}`;
  return { subject: NUDGE_SUBJECT, html, text };
}

async function sendNudgeTo(env: Env, s: any): Promise<boolean> {
  const c = await nudgeEmailContent(env, s);
  if (!c) return false;
  await sendEmail(env, s.email, c.subject, c.html, c.text, { fromName: "Francesco from RoxRaceAlerts", replyTo: SUPPORT_EMAIL });
  return true;
}

/** Part of the frequent checks: while switched on, sends the next few nudges in the morning. */
async function sendNudgeEmails(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'nudge_email'").first<any>();
  if (row?.value !== "on" || !priorityPublic(env)) return;
  const offset = zurichOffsetMinutes();
  const hour = new Date(Date.now() + offset * 60000).getUTCHours();
  if (hour < UPDATE_EMAIL_SWISS_HOURS[0] || hour >= UPDATE_EMAIL_SWISS_HOURS[1]) return;
  await ensureNudgeTable(env);
  const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM nudge_sent WHERE date(sent_at, ?1) = date('now', ?1)").bind(`+${offset} minutes`).first<any>();
  const room = Math.min(10, NUDGE_PER_DAY - (Number(today?.n) || 0));
  if (room <= 0) return;
  const { results } = await env.DB.prepare(`${NUDGE_CANDIDATES_SQL} LIMIT ?`).bind(room).all<any>();
  for (const s of results || []) {
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO nudge_sent (subscriber_id) VALUES (?)").bind(s.id).run();
    if (!claim.meta.changes) continue;
    try {
      await sendNudgeTo(env, s);
    } catch (e) {
      console.error(`nudge email to ${s.email} failed:`, e); // in email_log; not retried
    }
    await pause(600);
  }
}

/** Admin's Telegram: /nudge_test sends the email to ADMIN_EMAIL (as if they were a free watcher),
 * /nudge_start asks to switch it on (confirm button), /nudge_stop, /nudge_status. */
async function handleNudgeCommand(env: Env, text: string): Promise<void> {
  const reply = (t: string, markup?: object) =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: t, ...(markup ? { reply_markup: markup } : {}) }),
    });
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  await ensureNudgeTable(env);
  const waiting = async () => Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${NUDGE_CANDIDATES_SQL})`).first<any>())?.n) || 0;
  if (cmd === "/nudge_test") {
    const me = env.ADMIN_EMAIL ? await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(env.ADMIN_EMAIL.toLowerCase()).first<any>() : null;
    if (!me) return void (await reply(`${env.ADMIN_EMAIL || "ADMIN_EMAIL"} isn't a subscriber. Sign up with it first.`));
    const sent = await sendNudgeTo(env, me);
    await reply(sent ? `Test sent to ${me.email}. Send /nudge_start when it looks right.` : `${me.email} doesn't watch anything right now, so there's nothing to show. Watch a ticket first.`);
    return;
  }
  if (cmd === "/nudge_start") {
    const n = await waiting();
    await reply(
      `Switch on the Priority email? ${n} free users get it now (from ${UPDATE_EMAIL_SWISS_HOURS[0]}:00 Swiss time, ${NUDGE_PER_DAY} a day at most), then every new watcher once, a day after they start watching. /nudge_stop stops it.`,
      { inline_keyboard: [[{ text: `📨 Switch on (${n} now)`, callback_data: "nud:start" }]] }
    );
    return;
  }
  if (cmd === "/nudge_stop") {
    await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('nudge_email', 'off')").run();
    await reply("Priority email switched off. Nothing more goes out.");
    return;
  }
  if (cmd === "/nudge_status") {
    const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'nudge_email'").first<any>();
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(sent_at) AS first FROM nudge_sent").first<any>();
    const bought = sent?.first
      ? await env.DB.prepare(
          `SELECT COUNT(DISTINCT n.subscriber_id) AS n FROM nudge_sent n WHERE EXISTS(SELECT 1 FROM race_priority r WHERE r.subscriber_id = n.subscriber_id AND r.created_at >= n.sent_at)
             OR EXISTS(SELECT 1 FROM ticket_priority t WHERE t.subscriber_id = n.subscriber_id AND t.created_at >= n.sent_at)
             OR EXISTS(SELECT 1 FROM season_pass p WHERE p.subscriber_id = n.subscriber_id AND p.created_at >= n.sent_at)`
        ).first<any>()
      : null;
    await reply(`Priority email: ${row?.value === "on" ? "on" : "off"} · sent ${Number(sent?.n) || 0} · waiting ${await waiting()} · bought Priority after it: ${Number(bought?.n) || 0}`);
  }
}

async function handleNudgeButton(env: Env, cb: any): Promise<void> {
  const answer = (t: string) =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id, text: t }),
    });
  if (!env.TELEGRAM_CHAT_ID || String(cb.from?.id) !== String(env.TELEGRAM_CHAT_ID) || cb.data !== "nud:start") {
    await answer("Not allowed.");
    return;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('nudge_email', 'on')").run();
  await answer("Switched on.");
  await pingAdmin(env, `📨 Priority email switched on (from ${UPDATE_EMAIL_SWISS_HOURS[0]}:00 Swiss time, ${NUDGE_PER_DAY} a day at most). /nudge_status shows progress, /nudge_stop stops it.`);
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
  {
    const picked = ticketValues.map(decodeTicket).filter(Boolean) as any[];
    const names = picked.map((t) => t.ticket_name).join(", ");
    await pingAdmin(
      env,
      `🎫 Ticket watch: ${subscriber.email}${needsVerification ? " (new - not yet confirmed)" : ""}\n${picked[0]?.event_name || "?"}: ${names}${form.get("priority") === "1" || form.get("priority") === "season" ? "\n⚡ chose Priority - going to checkout" : ""}`
    );
  }

  // Chose "Watch first" (this race) or the season - the free watch is saved above either way.
  const first = ticketValues.map(decodeTicket).find(Boolean);
  const choice = String(form.get("priority") || "");
  let pick: { kind: PriorityKind; item: PriorityItem } | null = null;
  if (first && (choice === "1" || choice === "season") && priorityOfferedTo(env, subscriber) && !(await hasSeasonPass(env, subscriber.id))) {
    if (choice === "season") {
      pick = { kind: "season", item: seasonPriorityItem(env, await seasonPriceFor(env, subscriber.id)) };
    } else if (!(await ownsTicketPriority(env, subscriber.id, first.event_name))) {
      pick = { kind: "ticket", item: ticketPriorityItem(env, first.event_name) };
    }
    // What they picked, so the Stripe payments list shows it (Description column).
    if (pick) {
      const names = (ticketValues.map(decodeTicket).filter(Boolean) as any[]).map((t) => String(t.ticket_name).replace(/^HYROX /i, ""));
      pick.item.note = `${pick.item.name} - ${names.join(", ")}`;
    }
  }
  if (pick) {
    if (needsVerification) {
      // Never take money from someone we can't reach to confirm their email.
      try {
        await sendVerificationEmailOnly(env, subscriber, verifyToken);
      } catch {
        return page("Try again", `<div class="card"><p>We couldn't send your confirmation email just now - please try again in a minute. Nothing was charged. <a href="/">Back</a></p></div>`);
      }
    }
    const url = await startPriorityCheckout(env, subscriber, pick.kind, pick.item, needsVerification ? "/priority/thanks" : "/my-alerts?priority=success");
    const cookie = { "Set-Cookie": sessionCookieHeader(subscriber.unsubscribe_token) };
    if (url) return new Response(null, { status: 303, headers: { Location: url, ...cookie } });
    return page(
      "Payment unavailable",
      `<div class="card"><p>We couldn't start the payment just now - nothing was charged. Your free alert is saved${needsVerification ? " - confirm your email (we've sent a link) to switch it on" : ""}. <a href="/my-alerts">My alerts</a></p></div>`,
      cookie
    );
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
  if (form.get("next_edition") === "1") {
    // Set from a finished race's page: the row may still carry last season's date and "resolved"
    // (its sale happened), which would make the checks skip it forever. Re-arm it, dateless.
    await env.DB.prepare("UPDATE sale_watch SET resolved = 0, event_date = NULL, updated_at = datetime('now') WHERE event_url = ?").bind(eventUrl).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO sale_watchers (subscriber_id, event_url) VALUES (?, ?)")
    .bind(subscriber.id, eventUrl)
    .run();
  await pingAdmin(
    env,
    `🏁 Race watch: ${subscriber.email}${needsVerification ? " (new - not yet confirmed)" : ""}\n${eventTitle}${form.get("priority") === "1" || form.get("priority") === "season" ? "\n⚡ chose Priority - going to checkout" : ""}`
  );

  // Chose "Notify me first" (this race) or the season - the free watch is saved above either way.
  const choice = String(form.get("priority") || "");
  if ((choice === "1" || choice === "season") && priorityOfferedTo(env, subscriber) && !(await hasSeasonPass(env, subscriber.id))) {
    let pick: { kind: PriorityKind; item: PriorityItem } | null = null;
    if (choice === "season") {
      pick = { kind: "season", item: seasonPriorityItem(env, await seasonPriceFor(env, subscriber.id)) };
    } else {
      const race = await env.DB.prepare("SELECT event_url, event_title, resolved FROM sale_watch WHERE event_url = ?").bind(eventUrl).first<any>();
      if (race && !race.resolved && !(await ownsRacePriority(env, subscriber.id, eventUrl))) pick = { kind: "race", item: racePriorityItem(env, race) };
    }
    if (pick) {
      if (needsVerification) {
        // Never take money from someone we can't reach to confirm their email.
        try {
          await sendVerificationEmailOnly(env, subscriber, verifyToken);
        } catch {
          return jsonResponse({ error: "We couldn't send your confirmation email just now - please try again in a minute. Nothing was charged." }, 502);
        }
      }
      const url = await startPriorityCheckout(env, subscriber, pick.kind, pick.item, needsVerification ? "/priority/thanks" : "/my-alerts?priority=success");
      return new Response(
        JSON.stringify(
          url
            ? { checkout_url: url }
            : { error: `We couldn't start the payment just now - nothing was charged. Your free alert is saved${needsVerification ? "; confirm your email (we've sent a link) to switch it on" : ""}.` }
        ),
        { status: url ? 200 : 502, headers: { "content-type": "application/json", "Set-Cookie": sessionCookieHeader(subscriber.unsubscribe_token) } }
      );
    }
  }

  if (needsVerification) {
    return sendVerificationEmail(env, subscriber, verifyToken);
  }

  if (priorityOpen(env, subscriber) && (await priorityCandidates(env, subscriber.id, eventUrl)).length) {
    return new Response(null, {
      status: 303,
      headers: { Location: `${env.SITE_URL}/watching?event=${encodeURIComponent(eventUrl)}`, "Set-Cookie": sessionCookieHeader(subscriber.unsubscribe_token) },
    });
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
  await pingAdmin(env, `✅ Email confirmed: ${subscriber.email}${subscriber.referred_by ? " (invited by a friend)" : ""}`);
  if (subscriber.referred_by) {
    try {
      await checkReferralReward(env, Number(subscriber.referred_by));
    } catch (e) {
      console.error("referral check failed:", e);
    }
  }
  const offers = priorityOpen(env, { ...subscriber, verified: 1 }) ? await priorityCandidates(env, subscriber.id) : [];
  return page(
    "Confirmed",
    `<div class="card"><p>You're confirmed! You'll get an email the moment your selected ticket(s) become available.</p><p><a href="/my-alerts">Manage my alerts</a></p></div>
    ${offers.length ? priorityOfferCard(env, subscriber.unsubscribe_token, offers[0], (await watchedRaceCount(env, subscriber.id)) >= 2) : ""}`,
    { "Set-Cookie": sessionCookieHeader(subscriber.unsubscribe_token) }
  );
}

async function handleUnsubscribe(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This unsubscribe link is invalid.</p></div>`);
  }
  // Deleting the subscriber also deletes their paid Priority passes (ON DELETE CASCADE). Free users
  // keep one-click unsubscribe; someone who paid gets one confirmation, with the way to a refund.
  const paid = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM race_priority WHERE subscriber_id = ?1) + (SELECT COUNT(*) FROM ticket_priority WHERE subscriber_id = ?1)
       + (SELECT COUNT(*) FROM season_pass WHERE subscriber_id = ?1 AND valid_until >= date('now')) AS n`
  )
    .bind(subscriber.id)
    .first<any>();
  if ((Number(paid?.n) || 0) > 0 && new URL(req.url).searchParams.get("confirm") !== "1") {
    return page(
      "Unsubscribe?",
      `<div class="card">
        <h2>Unsubscribe from everything?</h2>
        <p>You have <b>Priority</b> on your alerts. Unsubscribing deletes your account, all your alerts and your Priority - it can't be undone. Nothing renews either way: your payment was one-off.</p>
        <p>Want your money back instead? Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> - see our <a href="/terms">refund policy</a>.</p>
        <p><a href="/unsubscribe?token=${encodeURIComponent(token)}&confirm=1"><button type="button">Yes, unsubscribe and delete everything</button></a></p>
        <p><a href="/my-alerts?token=${encodeURIComponent(token)}">No, keep my alerts</a></p>
      </div>`
    );
  }
  await env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(subscriber.id).run();
  await pingAdmin(env, `👋 Unsubscribed: ${subscriber.email}${(Number(paid?.n) || 0) > 0 ? " (had Priority - may ask for a refund)" : ""}`);
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
      await notifyAdminTelegram(env, email, `🔑 Sign-in link requested.\n${link}`);
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

  const seasonActive = await hasSeasonPass(env, subscriber.id);
  const multiRace = (await watchedRaceCount(env, subscriber.id)) >= 2;
  const rows = await renderTicketRows(subscriber.id, subscriber.unsubscribe_token, env, priorityOpen(env, subscriber), seasonActive);
  const saleRows = await renderSaleWatchRows(subscriber.id, subscriber.unsubscribe_token, env, priorityOpen(env, subscriber), seasonActive);
  const counts = await getWatchCounts(subscriber.id, env);
  const paidBanner =
    url.searchParams.get("priority") === "success"
      ? `<div class="verify-banner" style="background:#e6f4ea;border-color:#bfe0c9;color:#1e7e34"><p><b>Payment received.</b> Priority shows on your alerts below within a few seconds - refresh if it isn't there yet.</p></div>`
      : "";
  const saleSections: string[] = [];
  if (saleRows.live) saleSections.push(`<h2>Live now</h2>${saleRows.live}`);
  if (saleRows.soon) saleSections.push(`<h2>Going live soon</h2>${saleRows.soon}`);
  if (saleRows.waiting || saleSections.length === 0) {
    saleSections.push(`<h2>Waiting for tickets to go on sale</h2>${saleRows.waiting || "<p>None yet.</p>"}`);
  }
  if (seasonActive) {
    saleSections.push(`<p class="consent">&#9889; <b>Season Priority active</b> until ${SEASON_END_LABEL}: you're notified before everyone else for every race you watch.</p>`);
  } else if (priorityOpen(env, subscriber)) {
    saleSections.push(
      `<p class="consent">&#9889; ${priorityExplainer(env, true)}</p>${priorityForm(subscriber.unsubscribe_token, "season", `&#9889; ${seasonButtonLabel(await seasonPriceFor(env, subscriber.id))}`)}`
    );
  }
  const verifyBanner = subscriber.verified
    ? ""
    : `<div class="verify-banner">
      <p><b>Confirm your email to start receiving alerts</b> — until you do, nothing below is actually being checked.</p>
      <p>We sent a confirmation link to ${escapeHtml(subscriber.email)}. Don't see it? Check your spam folder.</p>
    </div>`;

  return page(
    "My Alerts",
    `${navBar("/my-alerts", subscriber, counts.tickets + counts.races, false, env)}
    ${verifyBanner}
    ${paidBanner}
    <div class="layout">
      <div class="main-col">
        <div class="card">
          <h2>Your watched tickets</h2>
          ${rows.active}
          ${saleSections.join("\n")}
        </div>
        ${rows.purchased ? `<div class="card"><h2>Purchased</h2>${rows.purchased}</div>` : ""}
        ${pastEventsSection(rows.past, saleRows.past)}
        <div class="card">
          <p>Want to track another ticket? <a href="/">Search on the homepage</a>.</p>
          <p><a href="/unsubscribe?token=${escapeHtml(subscriber.unsubscribe_token)}">Unsubscribe from everything</a></p>
        </div>
      </div>
      <div class="sidebar side-compact">
        ${await renderInviteCard(env, subscriber)}
        ${renderWhatsAppCard(env, subscriber)}
        ${renderTelegramCard(env, subscriber)}
      </div>
    </div>`,
    {},
    true
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

/** Race-level equivalent of handleMarkPurchased - a sale_watch entry has no
 * specific ticket_name (it's "notify me when this race goes on sale", not a
 * specific ticket type), so there's nothing to flip a purchased_at flag on.
 * Instead this creates a normal subscriptions row using the ticket type they
 * picked from TICKET_TYPE_OPTIONS, already marked purchased - reuses the
 * existing "Purchased" section and /admin/subscribers count as-is, no new
 * schema needed. The race watch itself is then removed, since they've got
 * what they were watching for. */
async function handleMarkRacePurchased(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  const watcherId = String(form.get("watcher_id") || "");
  const ticketType = String(form.get("ticket_type") || "");
  if (!TICKET_TYPE_OPTIONS.includes(ticketType)) {
    return page("Something went wrong", `<div class="card"><p>Please pick a ticket type. <a href="/my-alerts">Go back</a></p></div>`);
  }

  const subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?").bind(token).first<any>();
  if (!subscriber) {
    return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  }
  const watch = await env.DB.prepare(
    `SELECT sw.event_title, sw.event_date FROM sale_watchers w
     JOIN sale_watch sw ON sw.event_url = w.event_url
     WHERE w.id = ? AND w.subscriber_id = ?`
  )
    .bind(watcherId, subscriber.id)
    .first<any>();
  if (!watch) {
    return page("Not found", `<div class="card"><p>This link is invalid.</p></div>`);
  }

  await env.DB.prepare(
    "INSERT INTO subscriptions (subscriber_id, event_name, ticket_name, shop_url, event_date) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(subscriber_id, event_name, ticket_name) DO NOTHING"
  )
    .bind(subscriber.id, watch.event_title, ticketType, watch.event_date)
    .run();
  await env.DB.prepare(
    "UPDATE subscriptions SET purchased_at = datetime('now') WHERE subscriber_id = ? AND event_name = ? AND ticket_name = ?"
  )
    .bind(subscriber.id, watch.event_title, ticketType)
    .run();
  await env.DB.prepare("DELETE FROM sale_watchers WHERE id = ? AND subscriber_id = ?").bind(watcherId, subscriber.id).run();

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
    let event;
    try {
      event = await getEventData(row.event_id, row.shop_url);
    } catch (e) {
      if (!(e instanceof FetchBlocked)) throw e;
      console.warn("Ticket shop rate-limited us; stopping ticket checks this round:", e.message);
      break;
    }
    if (!event) continue;
    const ticket = event.tickets.find((t) => t.name === row.ticket_name);
    if (!ticket) continue;
    const newStatus = ticketStatus(ticket);

    if (row.last_status === "sold_out" && newStatus === "available") {
      // Kept for the public "tickets that came back" page and the homepage numbers.
      await env.DB.prepare("INSERT INTO ticket_returns (event_name, ticket_name, shop_url) VALUES (?, ?, ?)")
        .bind(row.event_name, row.ticket_name, row.shop_url)
        .run()
        .catch((e) => console.error("ticket_returns insert failed:", e));
      await notifyTicketReturned(env, row);
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
    `SELECT sw.*,
       (SELECT live_at_utc FROM ig_flagged_posts
        WHERE event_url = sw.event_url AND status = 'approved' AND live_at_utc IS NOT NULL
        ORDER BY live_at_utc DESC LIMIT 1) AS announced_live_at
     FROM sale_watch sw
     WHERE sw.resolved = 0 AND (sw.event_date IS NULL OR sw.event_date >= ?)
       AND EXISTS (
         SELECT 1 FROM sale_watchers w JOIN subscribers s ON s.id = w.subscriber_id
         WHERE s.verified = 1 AND w.event_url = sw.event_url
       )
     -- Longest-unchecked first, so a round cut short by rate limiting never starves the same races.
     ORDER BY sw.last_checked_at IS NOT NULL, sw.last_checked_at`
  )
    .bind(todayIso())
    .all<any>();
  let blocked = 0;
  let first = true;
  for (const row of results || []) {
    // Some ticket shops are provisioned with real, buyable inventory well
    // before the organizer's own site publicly reveals/links to it (seen
    // live with HYROX Milan - the checkout page already had live stock
    // hours before hyrox.com's own countdown reached zero). Detecting that
    // public reveal itself isn't possible here (it's rendered by
    // client-side JS the Worker's plain fetch() never sees), so instead we
    // hold off alerting until the announced go-live time from a matched
    // Instagram post has passed, if we have one - same time the countdown
    // reminders below are already counting down to.
    if (row.announced_live_at && Date.now() < Date.parse(row.announced_live_at)) continue;

    if (!first) await pause(HYROX_REQUEST_GAP_MS);
    first = false;
    let found;
    try {
      found = await resolveEvent(row.event_url);
    } catch (e) {
      if (!(e instanceof FetchBlocked)) throw e;
      // Refused: leave last_checked_at alone so this race is first in line next round, and try
      // the next race (a later request often gets through). A round that keeps getting refused
      // stops, so we don't keep the limit tripped.
      if (++blocked >= MAX_BLOCKED_PER_ROUND) {
        console.warn("hyrox.com rate-limited us repeatedly; stopping sale checks this round:", e.message);
        break;
      }
      continue;
    }
    await env.DB.prepare("UPDATE sale_watch SET last_checked_at = datetime('now') WHERE event_url = ?").bind(row.event_url).run();
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
    // Now we know the shop's own event name (what ticket watches are keyed by), link any
    // "This race" Priority to it so it also covers this race's sold-out tickets.
    await env.DB.prepare("UPDATE race_priority SET event_name = ? WHERE event_url = ? AND event_name IS NULL").bind(found.event.name, row.event_url).run();
    if (found.shopUrl !== row.event_url) {
      await env.DB.prepare("UPDATE event_directory SET shop_url = ? WHERE url = ? AND shop_url IS NULL").bind(found.shopUrl, row.event_url).run();
    }

    const { results: watchers } = await env.DB.prepare(
      `SELECT s.email, s.unsubscribe_token, s.whatsapp_phone, s.telegram_chat_id,
         ${hasRacePrioritySql("s.id", "w.event_url")} AS has_priority
       FROM subscribers s
       JOIN sale_watchers w ON w.subscriber_id = s.id
       WHERE s.verified = 1 AND w.event_url = ?`
    )
      .bind(row.event_url)
      .all<any>();

    // Priority holders go first. Free watchers are held back only when somebody holds
    // Priority for this race (and a delay is configured) - see "Priority alerts" below.
    const all = watchers || [];
    const paid = all.filter((w: any) => w.has_priority);
    const delayMs = priorityDelayMs(env);
    const holdBack = delayMs > 0 && paid.length > 0 && paid.length < all.length;
    if (holdBack) {
      await env.DB.prepare("UPDATE sale_watch SET detected_at = datetime('now'), free_alert_after = ? WHERE event_url = ?")
        .bind(sqlTime(Date.now() + delayMs), row.event_url)
        .run();
    }
    for (const watcher of holdBack ? paid : all) await sendSaleWatchAlert(env, row, watcher, watcher.has_priority ? null : 0);
  }
}

/** Box added to a free subscriber's alert email, once Priority is on sale: how much earlier Priority
 * members were told (only when they really were - minutesBehind 0 means nobody was ahead) and the
 * way to get it. */
function priorityUpsell(env: Env, token: string, minutesBehind: number): { html: string; text: string } {
  if (!priorityPublic(env)) return { html: "", text: "" };
  const link = `${env.SITE_URL}/my-alerts?token=${token}`;
  const lead =
    minutesBehind > 0 ? `Priority members got this alert ${minutesBehind} minute${minutesBehind === 1 ? "" : "s"} before you.` : "Want to be first next time?";
  const pitch = `Priority alerts reach you the instant we spot a change - before everyone else - plus WhatsApp notifications. ${PRIORITY_PRICE_LABEL} per race.`;
  return {
    html: `<p style="background:#fff6e0;border:1px solid #f0c36d;border-radius:8px;padding:10px 12px">&#9889; <b>${lead}</b> ${pitch} <a href="${link}">Get Priority</a></p>`,
    text: `\n\n⚡ ${lead} ${pitch} Get Priority: ${link}`,
  };
}

/** Whole minutes since a D1 datetime('now') timestamp, at least 1. */
function minutesSince(sqlTs: string): number {
  return Math.max(1, Math.round((Date.now() - Date.parse(String(sqlTs).replace(" ", "T") + "Z")) / 60_000));
}

/** The "tickets are now on sale" alert to one watcher, on every channel they've set up.
 * upsellMinutes: null for Priority holders (no upsell), else how far behind Priority they were. */
async function sendSaleWatchAlert(env: Env, row: { event_title: string; event_url: string }, watcher: any, upsellMinutes: number | null = null): Promise<void> {
  const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${watcher.unsubscribe_token}`;
  const up = upsellMinutes === null ? { html: "", text: "" } : priorityUpsell(env, watcher.unsubscribe_token, upsellMinutes);
  if (watcher.whatsapp_phone) await sendWhatsAppAlert(env, watcher.whatsapp_phone, row.event_title, "tickets are now on sale!", row.event_url);
  await sendTelegramAlert(env, watcher.telegram_chat_id, row.event_title, "tickets are now on sale!", row.event_url);
  try {
    await sendEmail(
      env,
      watcher.email,
      `Tickets on sale now: ${row.event_title}`,
      `<p><b>${escapeHtml(row.event_title)}</b> tickets are now on sale!</p><p><a href="${row.event_url}">${row.event_url}</a></p><p>Come back to RoxRaceAlerts to pick specific tickets to watch for sold-out alerts too.</p>${up.html}${IG_FOLLOW_HTML}<p><small><a href="${myAlertsLink}">Manage my alerts</a></small></p>`,
      `${row.event_title} tickets are now on sale!\n${row.event_url}\n\nCome back to RoxRaceAlerts to pick specific tickets to watch for sold-out alerts too.${up.text}${IG_FOLLOW_TEXT}\n\nManage my alerts: ${myAlertsLink}`
    );
    await notifyAdminTelegram(env, watcher.email, `🎟️ ${row.event_title} tickets are now on sale!\n${row.event_url}`);
  } catch (e) {
    console.error(`Failed to email ${watcher.email}:`, e);
  }
}

/** Sends the held-back free alerts once their delay is up. Only watchers who were already
 * watching when the shop was detected get it (a later joiner can see on-sale status themselves),
 * and the claim is atomic so two overlapping cron ticks can't both send. */
async function sendDueFreeSaleAlerts(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT event_url, event_title, detected_at FROM sale_watch WHERE free_alert_after IS NOT NULL AND free_alert_after <= datetime('now')"
  ).all<any>();
  for (const row of results || []) {
    const claim = await env.DB.prepare("UPDATE sale_watch SET free_alert_after = NULL WHERE event_url = ? AND free_alert_after IS NOT NULL")
      .bind(row.event_url)
      .run();
    if (!claim.meta.changes) continue;
    const { results: watchers } = await env.DB.prepare(
      `SELECT s.email, s.unsubscribe_token, s.whatsapp_phone, s.telegram_chat_id FROM subscribers s
       JOIN sale_watchers w ON w.subscriber_id = s.id
       WHERE s.verified = 1 AND w.event_url = ? AND w.created_at <= ?
         AND NOT ${hasRacePrioritySql("s.id", "w.event_url")}`
    )
      .bind(row.event_url, row.detected_at)
      .all<any>();
    const behind = minutesSince(row.detected_at);
    for (const watcher of watchers || []) await sendSaleWatchAlert(env, row, watcher, behind);
  }
}

/** Keeps the browsable homepage list's on-sale status fresh for *every*
 * known event, not just ones someone explicitly asked to be notified
 * about (that's sale_watch, unchanged, above). Once on_sale flips to true
 * it essentially never needs to flip back (a live shop doesn't disappear),
 * so unconfirmed (on_sale=0) events are checked first, soonest race date
 * first within that group - the ones someone's most likely checking on
 * roxracealerts.com right now. Confirmed on_sale=1 events only get
 * re-checked once the unconfirmed backlog is empty.
 *
 * On top of that, an event whose Instagram-estimated presale_live_at has
 * already passed jumps to the very front regardless of race date - a
 * far-future race (e.g. HYROX Milan's actual race is in December) would
 * otherwise sit behind every soon-racing event in the queue for hours even
 * though its announced sale time just passed and the sidebar is actively
 * showing a stale "going live soon" countdown for it right now. */
async function refreshEventDirectorySaleStatus(env: Env): Promise<void> {
  const today = todayIso();
  const nowIso = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT url, shop_url, presale_live_at, presale_is_live FROM event_directory
     WHERE (event_date IS NULL OR event_date >= ?)
     -- On-sale races whose shop we don't know yet come first: once known, ticket lookups for
     -- them skip hyrox.com entirely (see handleResolve).
     ORDER BY (on_sale = 1 AND shop_url IS NULL) DESC, on_sale ASC, (presale_live_at IS NOT NULL AND presale_live_at <= ?) DESC,
       event_date IS NULL, event_date ASC, last_sale_check IS NOT NULL, last_sale_check ASC
     LIMIT ?`
  )
    .bind(today, nowIso, SALE_STATUS_BATCH_SIZE)
    .all<any>();

  let blocked = 0;
  let first = true;
  for (const row of results || []) {
    if (!first) await pause(HYROX_REQUEST_GAP_MS);
    first = false;
    // resolveEvent() failing can mean "genuinely no shop live yet" or just a
    // transient fetch hiccup against hyrox.com/vivenu - retry once before
    // concluding "not on sale", since a false negative here persists until
    // this event's next rotation (~16 min) rather than self-correcting.
    // A rate-limit refusal is not a "no": stop this round without touching the row, so an
    // on-sale race is never flipped back to "not on sale" just because hyrox.com was busy.
    let found;
    try {
      if (row.shop_url) found = await resolveEvent(row.shop_url);
      if (!found) found = await resolveEvent(row.url);
      if (!found) found = await resolveEvent(row.url);
    } catch (e) {
      if (!(e instanceof FetchBlocked)) throw e;
      // Refused is not "not on sale": row untouched, so it stays at the front of the queue.
      if (++blocked >= MAX_BLOCKED_PER_ROUND) {
        console.warn("hyrox.com rate-limited us repeatedly; stopping directory checks this round:", e.message);
        break;
      }
      continue;
    }
    // Only stamp on_sale_since when this row was genuinely being counted
    // down (a known presale_live_at, or an active pre-sale) right before
    // confirmation - i.e. it's transitioning out of the sidebar's "Going
    // live soon"/"Live now" buckets, not an event whose shop just happened
    // to already be open when the daily sitemap crawl first found it.
    const wasCountingDown = row.presale_live_at || row.presale_is_live ? 1 : 0;
    // Prefer the announced go-live time itself over "whenever we happened
    // to confirm it" - the real shop can be live for minutes before our
    // rotating check (every ~2 min, sometimes longer if other events are
    // queued ahead of it) actually catches up and marks it confirmed, so
    // "confirmed at" reads as later than the sale actually went live. Only
    // falls back to nowIso when there's no announced time at all (a live
    // pre-sale with no specific date ever given).
    const wentLiveAt = row.presale_live_at || nowIso;
    // Once the real shop is confirmed live, clear any Instagram-derived
    // presale info too - it's stale next to the real "on sale" status.
    // wentLiveAt/nowIso are both proper "...T...Z" ISO strings (same as
    // presale_live_at) rather than SQLite's datetime('now') - that produces
    // a space-separated "YYYY-MM-DD HH:MM:SS" string which browsers parse
    // as *local* time, not UTC, silently shifting the displayed time by
    // the viewer's own timezone offset.
    if (found) {
      if (found.shopUrl !== row.url && found.shopUrl !== row.shop_url) {
        await env.DB.prepare("UPDATE event_directory SET shop_url = ? WHERE url = ?").bind(found.shopUrl, row.url).run();
      }
      // presale_timezone is deliberately kept (not nulled like the other
      // presale_* fields) - it's the only record of the event's own local
      // zone, needed to show "just went on sale" at a sensible local time
      // instead of a bare UTC timestamp nobody thinks in.
      await env.DB.prepare(
        `UPDATE event_directory SET on_sale = 1, last_sale_check = datetime('now'),
         on_sale_since = CASE WHEN ? THEN COALESCE(on_sale_since, ?) ELSE on_sale_since END,
         presale_note = NULL, presale_live_at = NULL, presale_is_live = 0
         WHERE url = ?`
      )
        .bind(wasCountingDown, wentLiveAt, row.url)
        .run();
    } else {
      await env.DB.prepare("UPDATE event_directory SET on_sale = 0, last_sale_check = datetime('now') WHERE url = ?")
        .bind(row.url)
        .run();
    }
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
async function notifySaleWatchers(
  env: Env,
  eventUrl: string,
  bannerText: string,
  postUrl: string,
  source: "instagram" | "newsletter" = "instagram"
): Promise<void> {
  const eventRow = await env.DB.prepare("SELECT event_title FROM sale_watch WHERE event_url = ?").bind(eventUrl).first<any>();
  if (!eventRow) return;
  const { results: watchers } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token, s.whatsapp_phone, s.telegram_chat_id FROM subscribers s
     JOIN sale_watchers w ON w.subscriber_id = s.id
     WHERE s.verified = 1 AND w.event_url = ?`
  )
    .bind(eventUrl)
    .all<any>();

  for (const watcher of watchers || []) {
    const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${watcher.unsubscribe_token}`;
    const eventTitle = eventRow.event_title;
    if (watcher.whatsapp_phone) await sendWhatsAppAlert(env, watcher.whatsapp_phone, eventTitle, bannerText, postUrl);
    await sendTelegramAlert(env, watcher.telegram_chat_id, eventTitle, bannerText, postUrl);
    try {
      await sendEmail(
        env,
        watcher.email,
        // Newsletter-sourced updates used to go out labelled "Instagram
        // update ... check the post" with just the event page as the link,
        // which read as wrong to anyone who'd never seen an Instagram post.
        source === "newsletter" ? `HYROX update on ${eventTitle} tickets` : `Instagram update on ${eventTitle} tickets`,
        `<p><b>${escapeHtml(eventTitle)}</b>: ${escapeHtml(bannerText)}</p><p><a href="${escapeHtml(postUrl)}">${escapeHtml(postUrl)}</a></p><p><small>${source === "newsletter" ? "From an official HYROX newsletter. " : ""}This may not be the full public sale yet - check ${source === "newsletter" ? "the event page" : "the post"} for details. We'll still alert you the moment the shop itself is live.</small></p>${IG_FOLLOW_HTML}<p><small><a href="${myAlertsLink}">Manage my alerts</a></small></p>`,
        `${eventTitle}: ${bannerText}\n${postUrl}\n\n${source === "newsletter" ? "From an official HYROX newsletter. " : ""}This may not be the full public sale yet - check ${source === "newsletter" ? "the event page" : "the post"} for details. We'll still alert you the moment the shop itself is live.${IG_FOLLOW_TEXT}\n\nManage my alerts: ${myAlertsLink}`
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
  liveAtTimezone: string | null
): Promise<void> {
  const eventRow = await env.DB.prepare("SELECT event_title FROM sale_watch WHERE event_url = ?").bind(eventUrl).first<any>();
  if (!eventRow) return;
  const { results: watchers } = await env.DB.prepare(
    `SELECT s.email, s.unsubscribe_token, s.whatsapp_phone, s.telegram_chat_id FROM subscribers s
     JOIN sale_watchers w ON w.subscriber_id = s.id
     WHERE s.verified = 1 AND w.event_url = ?`
  )
    .bind(eventUrl)
    .all<any>();

  const eventTitle = eventRow.event_title;
  const liveAtLabel = formatInTimezone(liveAtUtc, liveAtTimezone);
  for (const watcher of watchers || []) {
    const myAlertsLink = `${env.SITE_URL}/my-alerts?token=${watcher.unsubscribe_token}`;
    if (watcher.whatsapp_phone) await sendWhatsAppAlert(env, watcher.whatsapp_phone, eventTitle, `${label} (expected around ${liveAtLabel}).`, eventUrl);
    await sendTelegramAlert(env, watcher.telegram_chat_id, eventTitle, `${label} (expected around ${liveAtLabel}).`, eventUrl);
    try {
      await sendEmail(
        env,
        watcher.email,
        `${eventTitle} tickets: ${label}`,
        `<p><b>${escapeHtml(eventTitle)}</b> ${escapeHtml(label)} (expected around ${escapeHtml(liveAtLabel)}).</p><p><a href="${escapeHtml(eventUrl)}">${escapeHtml(eventUrl)}</a></p><p><small>This is a best-effort estimate from an official HYROX announcement, not a guarantee - we'll still alert you the moment the actual shop is live.</small></p>${IG_FOLLOW_HTML}<p><small><a href="${myAlertsLink}">Manage my alerts</a></small></p>`,
        `${eventTitle} ${label} (expected around ${liveAtLabel}).\n${eventUrl}\n\nThis is a best-effort estimate, not a guarantee - we'll still alert you the moment the actual shop is live.${IG_FOLLOW_TEXT}\n\nManage my alerts: ${myAlertsLink}`
      );
      await notifyAdminTelegram(env, watcher.email, `⏰ ${eventTitle} ${label} (expected around ${liveAtLabel}).\n${eventUrl}`);
    } catch (e) {
      console.error(`Failed to email reminder to ${watcher.email}:`, e);
    }
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

/** Fires countdown reminders (1 day / 1 hour / 5 minutes / right now) for
 * any announcement whose caption gave a specific expected go-live time -
 * dispatched from the same 2-minute Cron Trigger as the ticket checks, so
 * even the "right now" one is never missed by more than a couple of
 * minutes. Each threshold is a one-shot flag on the row, so a tick that's
 * already past a threshold just skips it rather than re-sending. If the
 * whole thing is more than 6 hours overdue (e.g. after extended downtime),
 * marks the reminder sent without emailing - a stale countdown isn't
 * useful. The "right now" reminder is a best-effort estimate, same as the
 * others - checkSaleWatches is still the one that confirms the shop is
 * actually live. */
async function checkAnnouncementReminders(env: Env): Promise<void> {
  const now = Date.now();
  // Announcements come from two sources - Instagram posts AND the regional
  // newsletters read by handleIncomingEmail() - and the newest one per event
  // wins, so a correction ("[Rettifica] ...") replaces an earlier time
  // instead of both counting down. Guards, all from real newsletter data:
  //  - newsletter rows with presale_is_live = 1 are "registration closes" /
  //    "price goes up" notices carrying a deadline, not a go-live time;
  //  - a time of exactly T00:00:00Z is what the AI fills in when the
  //    email only gives a date, and would otherwise override a precise
  //    earlier time (Warsaw: 12:00 CET, then a date-only follow-up).
  const { results } = await env.DB.prepare(
    `SELECT event_url, live_at_utc, live_at_timezone FROM (
       SELECT event_url, live_at_utc, live_at_timezone, detected_at AS seen_at FROM ig_flagged_posts
         WHERE status = 'approved' AND event_url IS NOT NULL AND live_at_utc IS NOT NULL
           AND live_at_utc NOT LIKE '%T00:00:00Z'
       UNION ALL
       SELECT event_url, live_at_utc, live_at_timezone, received_at AS seen_at FROM newsletter_flagged_emails
         WHERE status = 'approved' AND event_url IS NOT NULL AND live_at_utc IS NOT NULL
           AND presale_is_live = 0 AND live_at_utc NOT LIKE '%T00:00:00Z'
     ) ORDER BY seen_at ASC`
  ).all<any>();
  const latest = new Map<string, any>();
  for (const r of results || []) latest.set(r.event_url, r);

  const steps: [string, number, string][] = [
    ["1d", ONE_DAY_MS, "is expected to go live in about 1 day"],
    ["1h", ONE_HOUR_MS, "is expected to go live in about 1 hour"],
    ["5m", FIVE_MIN_MS, "is expected to go live in about 5 minutes"],
    ["0m", 0, "should be going live right now"],
  ];

  for (const row of latest.values()) {
    const liveAt = Date.parse(row.live_at_utc);
    if (isNaN(liveAt)) continue;
    const msUntil = liveAt - now;
    // Nothing due yet, or too stale to bother (e.g. after extended downtime).
    if (msUntil > ONE_DAY_MS || msUntil < -6 * ONE_HOUR_MS) continue;

    // 10-minute buckets so two sources quoting the same time a few seconds
    // apart count as one; a corrected time gets a new key and so a new
    // countdown. countdown_sent's primary key is what stops repeats - the
    // INSERT only changes a row the first time.
    const liveKey = Math.round(liveAt / (10 * 60 * 1000));
    for (const [step, threshold, label] of steps) {
      if (msUntil > threshold) continue;
      const mark = await env.DB.prepare("INSERT OR IGNORE INTO countdown_sent (event_url, live_key, step) VALUES (?, ?, ?)")
        .bind(row.event_url, liveKey, step)
        .run();
      if (mark.meta.changes) {
        await sendCountdownReminder(env, row.event_url, label, row.live_at_utc, row.live_at_timezone);
      }
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
      await notifyAdminTelegram(env, env.ADMIN_EMAIL, `📸 ${flaggedCount} new Instagram post(s) published.\n${logLink}`);
    } catch (e) {
      console.error("Failed to send admin IG digest email:", e);
    }
  }
}

/** Finds and GETs a double-opt-in confirmation link inside an incoming
 * email, if the subject looks like one. Newsletter platforms (Mailin/
 * Sendinblue, Mailchimp, etc.) confirm a subscription with a plain GET to a
 * token-bearing URL, so a server-side fetch has the same effect as a human
 * clicking the button - which matters here since alerts@ has no real inbox
 * a person could open to click it themselves. Only runs when the subject
 * itself signals a confirmation email, so it never fetches arbitrary links
 * out of a genuine ticket-sale newsletter. */
async function tryAutoConfirmSubscription(
  subject: string,
  text: string,
  html: string
): Promise<{ attempted: boolean; confirmed: boolean; url?: string }> {
  if (!/confirm|verify|activate|opt.?in/i.test(subject)) return { attempted: false, confirmed: false };

  // "unsubscribe" contains "subscri" - without excluding it explicitly, a
  // footer opt-out link scores identically to the real confirm button and
  // can win the tie-break (first match wins on equal score), silently
  // confirming nothing while still reporting "confirmed".
  const isUnsubscribe = (s: string) => /unsubscrib|opt.?out/i.test(s);

  const candidates: { url: string; score: number }[] = [];
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const url = decodeHtmlEntities(m[1]);
    const anchorText = m[2].replace(/<[^>]+>/g, " ");
    if (!/^https?:\/\//i.test(url)) continue;
    if (isUnsubscribe(url) || isUnsubscribe(anchorText)) continue;
    let score = 0;
    if (/confirm|verify|activate|subscri/i.test(url)) score += 2;
    if (/confirm|verify|activate|subscri|yes|click here/i.test(anchorText)) score += 1;
    if (score > 0) candidates.push({ url, score });
  }
  // Plain-text fallback for ESPs that send a text-only confirmation email.
  if (candidates.length === 0) {
    const urlRe = /https?:\/\/[^\s)>\]]+/gi;
    let um: RegExpExecArray | null;
    while ((um = urlRe.exec(text))) {
      if (isUnsubscribe(um[0])) continue;
      if (/confirm|verify|activate|subscri/i.test(um[0])) candidates.push({ url: um[0], score: 2 });
    }
  }
  if (candidates.length === 0) return { attempted: false, confirmed: false };

  candidates.sort((a, b) => b.score - a.score);
  const target = candidates[0].url;
  try {
    // Same browser-like UA used for resolveEvent()'s fetches (see resolve.ts)
    // - several ESPs block requests carrying no/unusual User-Agent as bot
    // traffic, which silently killed some auto-confirm attempts before this.
    const res = await fetch(target, { method: "GET", redirect: "follow", headers: HEADERS });
    console.log(`Auto-confirm subscription GET ${res.status}: ${target}`);
    return { attempted: true, confirmed: res.ok, url: target };
  } catch (e) {
    console.error("Failed to auto-confirm newsletter subscription:", target, e);
    return { attempted: true, confirmed: false, url: target };
  }
}

/** Cloudflare Email Routing invokes this directly whenever an email arrives
 * at alerts@roxracealerts.com - the newsletter-monitoring counterpart to
 * checkInstagramAnnouncements() above, reusing the exact same AI parser
 * (parseAnnouncementWithAI) on the email body instead of an Instagram
 * caption. Newsletters are first-party HYROX comms rather than something an
 * AI has to guess the relevance of from a social caption, so once the admin
 * subscribes alerts@ to each regional site's newsletter, this should be a
 * materially more reliable signal than Instagram scraping alone. No human
 * approval gate, same as Instagram - a bad match can be spotted from the
 * newsletter_flagged_emails table if it ever comes up. */
async function handleIncomingEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  let parsed;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch (e) {
    console.error("Failed to parse incoming newsletter email:", e);
    return;
  }

  const messageId = message.headers.get("message-id") || null;
  const fromAddress = message.from;
  const subject = parsed.subject || "";

  // Regional HYROX sites almost all gate their newsletter with a double
  // opt-in "confirm your subscription" email - but alerts@ has no real
  // inbox a human can open to click that link, so the Worker clicks it
  // itself the moment the email lands. See tryAutoConfirmSubscription().
  const confirmResult = await tryAutoConfirmSubscription(subject, parsed.text || "", parsed.html || "");
  if (confirmResult.attempted && env.ADMIN_EMAIL) {
    const label = confirmResult.confirmed
      ? `✅ Auto-confirmed a newsletter subscription\nSubject: "${subject}"\nFrom: ${fromAddress}`
      : `⚠️ Saw a subscription-confirmation email but couldn't auto-confirm it - may need a manual resubscribe\nSubject: "${subject}"\nFrom: ${fromAddress}`;
    await notifyAdminTelegram(env, env.ADMIN_EMAIL, label);
  }

  // Keep the AI call cheap on what can be a long, image-heavy newsletter -
  // the sale-relevant sentence is almost always near the top.
  const body = (parsed.text || parsed.html || "").slice(0, 8000);
  if (!body.trim()) return;

  const { results } = await env.DB.prepare(
    "SELECT title, url FROM event_directory WHERE event_date IS NULL OR event_date >= ?"
  )
    .bind(todayIso())
    .all<any>();
  const candidateEvents = results || [];

  const ai = await parseAnnouncementWithAI(env, `Subject: ${subject}\n\n${body}`, new Date().toISOString(), candidateEvents);

  await env.DB.prepare(
    `INSERT INTO newsletter_flagged_emails (message_id, from_address, subject, status, banner_text, event_url, live_at_utc, live_at_timezone, presale_is_live, confirm_link, confirm_result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO NOTHING`
  )
    .bind(
      messageId,
      fromAddress,
      subject,
      ai && ai.isRaceTicketSale ? "approved" : "ignored",
      ai?.bannerText || null,
      ai?.eventUrl || null,
      ai?.liveAtUtc || null,
      ai?.liveAtTimezone || null,
      ai?.presaleIsLive ? 1 : 0,
      confirmResult.url || null,
      confirmResult.attempted ? (confirmResult.confirmed ? "confirmed" : "failed") : null
    )
    .run();

  if (!ai || !ai.isRaceTicketSale || !ai.eventUrl) return;

  const { bannerText, eventUrl, liveAtUtc, liveAtTimezone } = ai;
  const presaleIsLive = ai.presaleIsLive ? 1 : 0;

  await notifySaleWatchers(env, eventUrl, bannerText, eventUrl, "newsletter");
  await env.DB.prepare(
    "UPDATE event_directory SET presale_note = ?, presale_live_at = ?, presale_timezone = ?, presale_is_live = ? WHERE url = ?"
  )
    .bind(bannerText, liveAtUtc, liveAtTimezone, presaleIsLive, eventUrl)
    .run();
  await env.DB.prepare(
    "UPDATE sale_watch SET presale_note = ?, presale_live_at = ?, presale_timezone = ?, presale_is_live = ? WHERE event_url = ?"
  )
    .bind(bannerText, liveAtUtc, liveAtTimezone, presaleIsLive, eventUrl)
    .run();

  if (env.ADMIN_EMAIL) {
    await notifyAdminTelegram(env, env.ADMIN_EMAIL, `📧 ${bannerText}\n(from newsletter: "${subject}")`);
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

/** Last race day and venue from an event page. The end date sits in "event_date_3" next to the
 * start date ("- 13. Dec. 2026"), the address in "event_map_address", and many pages follow the
 * address with a button named after the venue (checked on Nashville, Houston, London, Utrecht,
 * 2026-11-10). Whatever a page doesn't have stays null - nothing is guessed. */
function parseEventDetails(html: string): { endDate: string | null; venueName: string | null; venueAddress: string | null } {
  const clean = (t: string, max: number) => {
    const v = decodeHtmlEntities(t).replace(/\s+/g, " ").trim();
    // "VENUE INFORMATION COMING SOON" (New York, 2026-11-10) and the like are not a venue.
    return v && v.length <= max && !/coming soon|announced soon|\btb[acd]\b|to be (announced|confirmed|determined)/i.test(v) ? v : null;
  };
  let endDate: string | null = null;
  const end = html.match(/event_date_3[^>]*>(?:\s*<span class="w-post-elm-before">[^<]*<\/span>)?\s*<span class="w-post-elm-value">([^<]+)</i);
  const d = end ? end[1].match(/(\d{1,2})\.\s*([A-Za-z]+)\.?\s*(\d{4})/) : null;
  if (d) {
    const month = MONTH_ABBR[d[2].slice(0, 3).toLowerCase()];
    if (month) endDate = `${d[3]}-${month}-${d[1].padStart(2, "0")}`;
  }
  const addr = html.match(/event_map_address[^>]*>(?:\s*<span class="w-post-elm-before">[^<]*<\/span>)?\s*<span class="w-post-elm-value">([^<]+)<\/span>\s*<\/div>(?:\s*<div class="w-btn-wrapper[^"]*">\s*<a [^>]*>\s*<span class="w-btn-label">([^<]+)<)?/i);
  // The button after the address is usually just the venue's name ("Music City Center"), sometimes
  // "More informations about Riocentro" (Rio, Buenos Aires): keep the name, drop a generic label.
  let venueName = addr && addr[2] ? clean(addr[2], 80) : null;
  if (venueName) venueName = venueName.replace(/^more info(rmation)?s?\s+(about|on)\s+/i, "").trim() || null;
  if (venueName && /^(more info|venue|website|directions?|map|click|learn|find|view|get|here|visit|see)\b/i.test(venueName)) venueName = null;
  return { endDate, venueAddress: addr ? clean(addr[1], 200) : null, venueName };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Same fallback problem as the homepage's client-side formatLocal (see
// RESOLVE_SCRIPT above, kept in sync with this table) - Intl's 'short'
// timeZoneName silently degrades to a bare "GMT-3"/"GMT+8" offset for
// most zones outside Europe, so countdown-reminder emails need their own
// lookup for real acronyms.
const TZ_ABBR: Record<string, string | [string, string]> = {
  "America/Sao_Paulo": "BRT",
  "America/Argentina/Buenos_Aires": "ART",
  "America/Buenos_Aires": "ART",
  "America/Bogota": "COT",
  "America/Mexico_City": "CST",
  "America/Lima": "PET",
  "America/Santiago": "CLT",
  "America/Los_Angeles": ["PST", "PDT"],
  "America/Vancouver": ["PST", "PDT"],
  "America/Denver": ["MST", "MDT"],
  "America/Phoenix": "MST",
  "America/Chicago": ["CST", "CDT"],
  "America/New_York": ["EST", "EDT"],
  "America/Toronto": ["EST", "EDT"],
  "Europe/London": ["GMT", "BST"],
  "Europe/Dublin": ["GMT", "IST"],
  "Europe/Istanbul": "TRT",
  "Asia/Shanghai": "CST",
  "Asia/Taipei": "CST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "Asia/Singapore": "SGT",
  "Asia/Kuala_Lumpur": "MYT",
  "Asia/Bangkok": "ICT",
  "Asia/Kolkata": "IST",
  "Asia/Riyadh": "AST",
  "Asia/Dubai": "GST",
  "Australia/Sydney": ["AEST", "AEDT"],
  "Australia/Melbourne": ["AEST", "AEDT"],
  "Australia/Brisbane": "AEST",
  "Australia/Perth": "AWST",
  "Pacific/Auckland": ["NZST", "NZDT"],
  "Africa/Johannesburg": "SAST",
  "Africa/Cairo": "EET",
};

function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), p.hour === "24" ? 0 : Number(p.hour), Number(p.minute), Number(p.second));
  return (asUtc - date.getTime()) / 60000;
}

function tzAbbr(utcIso: string, tz: string): string | null {
  const entry = TZ_ABBR[tz];
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  const date = new Date(utcIso);
  const jan = tzOffsetMinutes(new Date(Date.UTC(date.getUTCFullYear(), 0, 15)), tz);
  const jul = tzOffsetMinutes(new Date(Date.UTC(date.getUTCFullYear(), 6, 15)), tz);
  const std = Math.min(jan, jul);
  const dst = Math.max(jan, jul);
  if (std === dst) return entry[0];
  const actual = tzOffsetMinutes(date, tz);
  return actual === dst ? entry[1] : entry[0];
}

/** Renders a UTC timestamp in the event's own local time (e.g. "Thu, 6 Aug
 * 2026, 12:00 CEST") instead of GMT/UTC, which reads as a foreign,
 * confusing time to most people. Falls back to UTC if the timezone is
 * missing or Claude returned something Intl doesn't recognize, rather than
 * throwing. */
function formatInTimezone(utcIso: string, timezone: string | null): string {
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return utcIso;
  const abbr = timezone ? tzAbbr(utcIso, timezone) : null;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: abbr ? undefined : "short",
  };
  try {
    const out = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: timezone || "UTC" }).format(d);
    return abbr ? `${out} ${abbr}` : out;
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZoneName: "short", timeZone: "UTC" }).format(d);
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
      const details = parseEventDetails(html);
      await env.DB.prepare(
        `INSERT INTO event_directory (url, title, event_date, event_end_date, venue_name, venue_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(url) DO UPDATE SET title = excluded.title, event_date = excluded.event_date, updated_at = excluded.updated_at,
           event_end_date = excluded.event_end_date,
           venue_name = CASE WHEN excluded.venue_address IS NOT NULL THEN excluded.venue_name ELSE venue_name END,
           venue_address = COALESCE(excluded.venue_address, venue_address)`
      )
        .bind(url, title, eventDate, eventDate && details.endDate && details.endDate >= eventDate ? details.endDate : null, details.venueName, details.venueAddress)
        .run();
      if (!existingMap.has(url) && eventDate && eventDate >= todayIso()) await moveNextEditionWatches(env, url, title, eventDate);
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
  // Past events stay in event_directory (never deleted), so without this
  // filter a finished race with the same title as its next season (two
  // "BYD HYROX Bangkok" rows) is offered too - picking the dead one creates
  // a watch the checks skip forever, which is how a subscriber waited on
  // Bangkok and never heard anything.
  const { results } = await env.DB.prepare(
    "SELECT url, title FROM event_directory WHERE title LIKE ? AND (event_date IS NULL OR event_date >= ?) ORDER BY title LIMIT 8"
  )
    .bind(`%${q}%`, todayIso())
    .all<any>();
  return jsonResponse({ results: results || [] });
}

/** Full browsable list for the homepage dropdown: every not-yet-passed
 * event, sorted by race date, with the cached on-sale status kept fresh by
 * refreshEventDirectorySaleStatus(). Undated entries (date not parsed yet)
 * sort last rather than being hidden, since they're still real events. */
async function handleListEvents(env: Env): Promise<Response> {
  return jsonResponse({ results: await listDirectoryEvents(env) });
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

/** Manual trigger for sendDailyIgPostReminder, same pattern as
 * /admin/reindex - useful for testing without waiting on the daily cron. */
async function handleSendIgPostReminder(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  await sendDailyIgPostReminder(env);
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
  return `<div class="card"><h2>Latest HYROX ticket news</h2>${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Search engines: the homepage carries the race list, a plain-text summary and a FAQ in its HTML
// (not only via script), plus description / canonical / schema.org data. Audit of 2026-10-27:
// Google's AI described the site as an "Instagram monitoring tool" because the static HTML held
// little else than the Instagram news box.
// ---------------------------------------------------------------------------
interface DirectoryEvent {
  url: string;
  title: string;
  event_date: string | null;
  on_sale: number;
  on_sale_since: string | null;
  presale_note: string | null;
  presale_live_at: string | null;
  presale_timezone: string | null;
  presale_is_live: number;
  shop_url: string | null;
  // From the official event page (parseEventDetails), filled by the nightly indexing; null until then.
  event_end_date?: string | null;
  venue_name?: string | null;
  venue_address?: string | null;
  slug?: string; // its page: /hyrox/<slug>
}

/** Upcoming races in the directory, soonest first, each with its page slug (the /events feed,
 * the homepage HTML, the race pages and the sitemap). */
async function listDirectoryEvents(env: Env): Promise<DirectoryEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT url, title, event_date, on_sale, on_sale_since, presale_note, presale_live_at, presale_timezone, presale_is_live, shop_url, event_end_date, venue_name, venue_address FROM event_directory
     WHERE event_date IS NULL OR event_date >= ?
     ORDER BY event_date IS NULL, event_date, title`
  )
    .bind(todayIso())
    .all<DirectoryEvent>();
  return assignSlugs(results || []);
}

/** URL part of a race page: the city ("COMMANDO HYROX Mexico City" -> "mexico-city"). */
function citySlug(title: string): string {
  return shortRaceName(title)
    .city.toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Two editions of one city (Helsinki in December and again in April): the soonest keeps the plain
 * slug, later ones get the year appended. Expects the soonest-first order of listDirectoryEvents. */
function assignSlugs(events: DirectoryEvent[]): DirectoryEvent[] {
  const taken = new Set<string>();
  for (const ev of events) {
    const base = citySlug(ev.title) || "race";
    let slug = base;
    if (taken.has(slug)) slug = `${base}-${(ev.event_date || "").slice(0, 4) || "next"}`;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${(ev.event_date || "").slice(0, 4) || "next"}-${n}`;
    taken.add(slug);
    ev.slug = slug;
  }
  return events;
}

/** Alternative names people type: "hyrox nyc tickets" is searched far more than "hyrox new york
 * tickets" (keyword research 2026-11-09), so the alias goes into the title and H1. */
const CITY_ALIASES: Record<string, string> = { "new york": "NYC", "washington dc": "DC", "washington": "DC" };

/** Year for titles: the race year; else the season from the shop address (".../season-26-27-...");
 * else the current HYROX season (September to August). A race without a date used to leave a hole
 * in the title ("HYROX New York  Tickets") while people search "hyrox nyc 2026 tickets". */
function raceYearLabel(ev: DirectoryEvent): string {
  if (ev.event_date) return ev.event_date.slice(0, 4);
  const m = /season-(\d{2})-(\d{2})/i.exec(ev.shop_url || "");
  if (m) return `20${m[1]}/${m[2]}`;
  return currentSeasonLabel();
}

/** The running HYROX season (September to August): "2026/27". */
function currentSeasonLabel(): string {
  const now = new Date();
  const start = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${start}/${String(start + 1).slice(2)}`;
}

/** Cities whose last race is over and whose next edition isn't listed yet: one row per city, the
 * most recent edition. Their pages stay up ("next edition not announced yet" + the alert) so the
 * ranking survives the gap between seasons - /hyrox/birmingham was indexed in October 2026 and
 * vanished the day after the race, while "hyrox birmingham tickets" is searched ~1,000 times a
 * month (keyword research 2026-11-09). Youngstars editions are skipped. */
async function listPastRaces(env: Env, upcoming: DirectoryEvent[]): Promise<DirectoryEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT url, title, event_date, on_sale, on_sale_since, presale_note, presale_live_at, presale_timezone, presale_is_live, shop_url, event_end_date, venue_name, venue_address
     FROM event_directory WHERE event_date < ? AND title NOT LIKE '%Youngstars%' ORDER BY event_date DESC, title`
  )
    .bind(todayIso())
    .all<DirectoryEvent>();
  const taken = new Set(upcoming.map((e) => e.slug));
  const out: DirectoryEvent[] = [];
  for (const ev of results || []) {
    const slug = citySlug(ev.title) || "race";
    if (taken.has(slug)) continue; // a newer edition of this city is listed - its page serves
    taken.add(slug);
    ev.slug = slug;
    out.push(ev);
  }
  return out;
}

/** People who set an alert on a finished race's page watched the old event URL. When a new
 * edition of that city appears in the directory (new URL), their watch moves to it; a reused URL
 * needs no move, the watch on it is checked as usual. */
async function moveNextEditionWatches(env: Env, newUrl: string, title: string, eventDate: string): Promise<void> {
  const city = citySlug(title);
  if (!city || /youngstars/i.test(title)) return;
  const { results } = await env.DB.prepare(
    `SELECT sw.event_url, d.title FROM sale_watch sw JOIN event_directory d ON d.url = sw.event_url
     WHERE sw.event_date IS NULL AND d.event_date < ? AND sw.event_url != ?`
  )
    .bind(todayIso(), newUrl)
    .all<any>();
  const old = (results || []).filter((r: any) => citySlug(r.title) === city);
  if (!old.length) return;
  await env.DB.prepare("INSERT OR IGNORE INTO sale_watch (event_url, event_title, event_date) VALUES (?, ?, ?)").bind(newUrl, title, eventDate).run();
  let moved = 0;
  for (const r of old) {
    const res = await env.DB.prepare("INSERT OR IGNORE INTO sale_watchers (subscriber_id, event_url) SELECT subscriber_id, ? FROM sale_watchers WHERE event_url = ?")
      .bind(newUrl, r.event_url)
      .run();
    moved += res.meta?.changes || 0;
    await env.DB.prepare("UPDATE sale_watch SET resolved = 1, updated_at = datetime('now') WHERE event_url = ?").bind(r.event_url).run();
  }
  if (moved) await pingAdmin(env, `🔁 ${moved} next-edition watcher(s) moved from the finished ${city} race to ${title} (${eventDate})`);
}

/** /hyrox/<city> for a city whose last race is over and whose next edition isn't announced:
 * what happened, that nothing is on sale, and the alert for when the next edition opens. */
async function nextEditionPage(req: Request, env: Env, ev: DirectoryEvent, upcoming: DirectoryEvent[], past: DirectoryEvent[]): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const counts = subscriber ? await getWatchCounts(subscriber.id, env) : { tickets: 0, races: 0 };
  const { name, city } = shortRaceName(ev.title);
  const alias = CITY_ALIASES[city.toLowerCase()];
  const cityShown = alias ? `${city} (${alias})` : city;
  const lastYear = (ev.event_date || "").slice(0, 4);
  const nextYear = String(Number(lastYear) + 1);
  const lastDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ev.event_date}T00:00:00Z`));
  const official = `<a href="${escapeHtml(ev.url)}" rel="noopener">hyrox.com</a>`;
  const faq: [string, string][] = [
    [
      `When do HYROX ${city} ${nextYear} tickets go on sale?`,
      `Not announced yet. The last ${name} took place on ${lastDay}. HYROX usually announces the next edition of a city some months after the race and the ticket sale date a few weeks ahead. Set a free alert and you get an email the moment the next ${city} sale opens.`,
    ],
    [
      `Is HYROX ${city} coming back in ${nextYear}?`,
      `HYROX hasn't announced it. Most cities return every season, but nothing is confirmed until it appears on hyrox.com. We watch the official ${city} event page around the clock and tell you when it changes.`,
    ],
    [
      `Is there a HYROX ${city} waitlist for the next edition?`,
      `Not an official one before the race is announced. A free RoxRaceAlerts alert does the job: one email when the next edition's tickets (or a pre-sale) open, then you buy on hyrox.com as usual.`,
    ],
    [
      `Are there HYROX ${city} spectator tickets?`,
      `At most HYROX races spectators need a ticket, sold on the official HYROX shop next to the race tickets once the sale opens, often with free entry for young children. Spectator tickets sell out at the big events too; once the sale is open you can set an alert for them here like for any other ticket type.`,
    ],
    [
      `Where do I buy HYROX ${city} tickets?`,
      `Only on the official HYROX shop (hyrox.com). RoxRaceAlerts is an independent alert service built by a HYROX athlete; we never sell or reserve tickets.`,
    ],
  ];
  const title = `HYROX ${cityShown} ${nextYear} Tickets: Not Announced Yet, Release Date & Alerts | RoxRaceAlerts`;
  const description = `HYROX ${city} ${nextYear} tickets are not on sale: the next edition hasn't been announced. The last ${name} was on ${lastDay}. Free alert the moment the next ${city} ticket sale opens.`;
  const pageUrl = `${env.SITE_URL}/hyrox/${ev.slug}`;
  const seo: PageSeo = {
    description,
    canonical: pageUrl,
    ownH1: true,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "HYROX races", item: `${env.SITE_URL}/` },
          { "@type": "ListItem", position: 2, name: `HYROX ${city}`, item: pageUrl },
        ],
      },
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
    ],
  };
  const others = upcoming.slice(0, 10);
  return page(
    title,
    `${navBar("/", subscriber, counts.tickets + counts.races, !subscriber, env)}
    <div class="hero">
      <h1>HYROX ${escapeHtml(cityShown)} ${nextYear} tickets: next edition not announced yet</h1>
      <p class="hero-sub">The last ${escapeHtml(name)} was on ${escapeHtml(lastDay)}. Nothing is on sale for ${escapeHtml(city)} right now.</p>
    </div>
    <div class="card">
      <h2>Ticket status</h2>
      <ul class="status-list">
        <li><span>Status</span><span class="event-badge off">Next edition not announced</span></li>
        <li><span>Last race</span><span>${escapeHtml(lastDay)}</span></li>
        <li><span>Official event page</span><span>${official}</span></li>
      </ul>
      <form method="POST" action="/watch-sale">
        <input type="hidden" name="event_url" value="${escapeHtml(ev.url)}"><input type="hidden" name="event_title" value="${escapeHtml(ev.title)}">
        <input type="hidden" name="event_date" value=""><input type="hidden" name="next_edition" value="1">
        ${subscriber ? "" : `<label>Your email<input type="email" name="email" required placeholder="you@example.com"></label>`}
        <button type="submit" name="priority" value="0">Alert me when HYROX ${escapeHtml(city)} tickets go on sale – free</button>
        <p class="consent">One email the moment the next ${escapeHtml(city)} edition opens its ticket sale or a pre-sale. Unsubscribe any time. Coming to watch? Spectator tickets go on sale at the same time - you can watch those too once the shop is open.</p>
      </form>
    </div>
    <div class="card faq"><h2>HYROX ${escapeHtml(city)} ${nextYear} tickets: questions</h2>${faq.map(([q, a]) => faqItem(q, a)).join("")}</div>
    <div class="card race-links"><h2>HYROX races on sale or coming up</h2>
      ${others.map((o) => `<a href="/hyrox/${o.slug}">HYROX ${escapeHtml(shortRaceName(o.title).city)}${o.event_date ? ` (${escapeHtml(o.event_date)})` : ""}</a>`).join("")}
      ${countryLineHtml(ev, racesByCountry(upcoming, past))}
      <p><a href="/">All ${upcoming.length} upcoming HYROX races</a></p>
    </div>
    ${countryLinksHtml(racesByCountry(upcoming, past))}`,
    {},
    false,
    seo
  );
}

/** Links to the cities waiting for their next edition, for the bottom of race pages and the homepage. */
function pastRaceLinksHtml(past: DirectoryEvent[]): string {
  if (!past.length) return "";
  return `<div class="card race-links"><h2>Waiting for the next edition</h2>
      <p class="hint">These cities raced recently and haven't announced the next date yet. Set an alert and hear first.</p>
      ${past.map((o) => `<a href="/hyrox/${o.slug}">HYROX ${escapeHtml(shortRaceName(o.title).city)}</a>`).join("")}
    </div>`;
}

// ---------------------------------------------------------------------------
// Country pages (/hyrox/<country>): every race of one country on one page. "hyrox canada" is
// searched 2,900 times a month in Canada alone (keyword research 2026-11-10) and the competitor
// has a page per country; we had none. A country gets a page once two of its cities are in the
// directory - with a single city the race page already says everything. A city page wins the
// address when a city and a country share a name (Singapore, Hong Kong have no entry here).
// A city missing from this list simply appears on no country page: add it to its country.
// ---------------------------------------------------------------------------
interface Country {
  name: string;
  local?: string; // what people there type ("hyrox deutschland"); shown in the title
  the?: boolean; // "in the Netherlands"
  cities: string[]; // city slugs, as citySlug() makes them
}
const COUNTRIES: Record<string, Country> = {
  usa: {
    name: "USA",
    local: "United States",
    the: true,
    cities: ["new-york", "washington-d-c", "washington-dc", "washington", "salt-lake-city", "boston", "tampa", "denver", "dallas", "anaheim", "nashville", "chicago", "phoenix", "las-vegas", "miami-beach", "miami", "houston", "atlanta", "san-diego", "portland", "los-angeles", "charlotte", "fort-lauderdale", "austin", "san-francisco", "seattle", "philadelphia", "orlando", "st-louis", "minneapolis"],
  },
  canada: { name: "Canada", cities: ["toronto", "vancouver", "ottawa", "montreal", "calgary"] },
  uk: { name: "UK", local: "United Kingdom", the: true, cities: ["london", "birmingham", "manchester", "glasgow", "cardiff", "liverpool", "edinburgh", "belfast", "newcastle", "leeds"] },
  ireland: { name: "Ireland", cities: ["dublin", "cork"] },
  germany: { name: "Germany", local: "Deutschland", cities: ["karlsruhe", "hamburg", "dusseldorf", "frankfurt", "cologne", "koln", "berlin", "stuttgart", "munich", "munchen", "leipzig", "hannover", "dortmund", "essen", "nuremberg", "bremen"] },
  netherlands: { name: "Netherlands", local: "Nederland", the: true, cities: ["maastricht", "utrecht", "amsterdam", "rotterdam", "heerenveen", "eindhoven", "the-hague"] },
  belgium: { name: "Belgium", cities: ["gent", "ghent", "mechelen", "brussels", "antwerp"] },
  france: { name: "France", cities: ["bordeaux", "nice", "paris", "toulouse", "lyon", "marseille", "lille", "nantes"] },
  spain: { name: "Spain", local: "España", cities: ["tenerife", "valencia", "barcelona", "bilbao", "madrid", "malaga", "sevilla", "seville"] },
  italy: { name: "Italy", local: "Italia", cities: ["rome", "milan", "verona", "bari", "rimini", "turin", "bologna"] },
  switzerland: { name: "Switzerland", local: "Schweiz", cities: ["geneva", "basel", "zurich", "st-gallen"] },
  austria: { name: "Austria", local: "Österreich", cities: ["vienna", "graz", "salzburg"] },
  poland: { name: "Poland", local: "Polska", cities: ["gdansk", "poznan", "katowice", "warsaw", "krakow", "wroclaw"] },
  sweden: { name: "Sweden", cities: ["stockholm", "gothenburg", "malmo"] },
  portugal: { name: "Portugal", cities: ["lisbon", "porto"] },
  turkey: { name: "Turkey", cities: ["izmir", "istanbul"] },
  mexico: { name: "Mexico", local: "México", cities: ["acapulco", "mexico-city", "cancun", "guadalajara", "monterrey", "puebla"] },
  brazil: { name: "Brazil", local: "Brasil", cities: ["sao-paulo", "rio-de-janeiro", "porto-alegre"] },
  australia: { name: "Australia", cities: ["perth", "melbourne", "brisbane", "sydney", "adelaide"] },
  japan: { name: "Japan", cities: ["chiba", "osaka", "nagoya", "tokyo", "yokohama"] },
  "south-korea": { name: "South Korea", cities: ["seoul", "incheon"] },
  china: { name: "China", cities: ["shenzhen", "beijing", "shanghai", "guangzhou", "sanya", "chengdu", "hangzhou"] },
  india: { name: "India", cities: ["mumbai", "gujarat", "noida", "bengaluru", "delhi", "new-delhi", "hyderabad"] },
  uae: { name: "UAE", local: "United Arab Emirates", the: true, cities: ["dubai", "abu-dhabi"] },
  "south-africa": { name: "South Africa", cities: ["cape-town", "johannesburg", "durban"] },
};

/** Country of a city slug; "paris-grand-palais" counts as Paris. */
function countryOfCity(slug: string): string | null {
  for (const [c, def] of Object.entries(COUNTRIES)) if (def.cities.includes(slug)) return c;
  for (const [c, def] of Object.entries(COUNTRIES)) if (def.cities.some((k) => slug.startsWith(`${k}-`))) return c;
  return null;
}

interface CountryRaces {
  upcoming: DirectoryEvent[]; // soonest first
  past: DirectoryEvent[]; // cities waiting for their next edition
}

/** Races per country, only for countries with two or more cities in the directory. */
function racesByCountry(events: DirectoryEvent[], past: DirectoryEvent[]): Map<string, CountryRaces> {
  const all = new Map<string, CountryRaces & { cities: Set<string> }>();
  const add = (ev: DirectoryEvent, key: "upcoming" | "past") => {
    if (/youngstars/i.test(ev.title)) return;
    const city = citySlug(ev.title);
    const c = countryOfCity(city);
    if (!c) return;
    if (!all.has(c)) all.set(c, { upcoming: [], past: [], cities: new Set() });
    const g = all.get(c)!;
    g[key].push(ev);
    g.cities.add(COUNTRIES[c].cities.find((k) => city === k || city.startsWith(`${k}-`)) || city);
  };
  for (const ev of events) add(ev, "upcoming");
  for (const ev of past) add(ev, "past");
  const out = new Map<string, CountryRaces>();
  // Same order as COUNTRIES, so the list of links reads the same everywhere.
  for (const c of Object.keys(COUNTRIES)) {
    const g = all.get(c);
    if (g && g.cities.size >= 2) out.set(c, { upcoming: g.upcoming, past: g.past });
  }
  return out;
}

/** "in the UK" / "in Canada". */
function inCountry(def: Country): string {
  return `${def.the ? "the " : ""}${def.name}`;
}

/** Links to every country page, for the homepage and the bottom of race pages. */
function countryLinksHtml(byCountry: Map<string, CountryRaces>, except = ""): string {
  const links = [...byCountry.keys()].filter((c) => c !== except);
  if (!links.length) return "";
  return `<div class="card race-links"><h2>HYROX races by country</h2>
      ${links.map((c) => `<a href="/hyrox/${c}">HYROX ${escapeHtml(COUNTRIES[c].name)}</a>`).join("")}
    </div>`;
}

/** "All HYROX races in Canada" link for a race page, when its country has a page. */
function countryLineHtml(ev: DirectoryEvent, byCountry: Map<string, CountryRaces>): string {
  const c = countryOfCity(citySlug(ev.title));
  return c && byCountry.has(c) ? `<p><a href="/hyrox/${c}">All HYROX races in ${escapeHtml(inCountry(COUNTRIES[c]))}</a></p>` : "";
}

/** "Waiting for the next edition" plus the country links: the bottom of the homepage and race pages. */
function raceFooterLinksHtml(events: DirectoryEvent[], past: DirectoryEvent[]): string {
  return pastRaceLinksHtml(past) + countryLinksHtml(racesByCountry(events, past));
}

function listWords(items: string[]): string {
  const u = [...new Set(items)];
  return u.length <= 1 ? u.join("") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
}

async function countryPage(req: Request, env: Env, slug: string, byCountry: Map<string, CountryRaces>): Promise<Response> {
  const def = COUNTRIES[slug];
  const g = byCountry.get(slug)!;
  const subscriber = await getSessionSubscriber(req, env);
  const counts = subscriber ? await getWatchCounts(subscriber.id, env) : { tickets: 0, races: 0 };
  const season = currentSeasonLabel();
  const where = inCountry(def);
  const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  const dates = (ev: DirectoryEvent) =>
    !ev.event_date ? "date to be announced" : ev.event_end_date && ev.event_end_date > ev.event_date ? `${day(ev.event_date)} to ${day(ev.event_end_date)}` : day(ev.event_date);
  const status = (ev: DirectoryEvent) =>
    ev.on_sale
      ? { badge: "On sale now", cls: "on" }
      : ev.presale_is_live
        ? { badge: "Pre-sale live", cls: "on" }
        : ev.presale_live_at
          ? { badge: "Sale date announced", cls: "soon" }
          : { badge: "Not on sale yet", cls: "off" };
  const cityOf = (ev: DirectoryEvent) => shortRaceName(ev.title).city;
  const upcomingCities = g.upcoming.map(cityOf);
  const pastCities = g.past.map(cityOf);
  const onSale = g.upcoming.filter((e) => e.on_sale);
  const announced = g.upcoming.filter((e) => !e.on_sale && e.presale_live_at);
  const next = g.upcoming[0];
  const nameShown = def.local ? `${def.name} (${def.local})` : def.name;

  const faq: [string, string][] = [
    [
      `When is the next HYROX race in ${where}?`,
      next
        ? `The next one is HYROX ${cityOf(next)}${next.event_date ? `, ${dates(next)}` : " (date to be announced)"}${next.venue_name ? ` at ${next.venue_name}` : ""}. Tickets: ${status(next).badge.toLowerCase()}.`
        : `No upcoming HYROX race in ${where} is listed on hyrox.com right now. Set a free alert on a city's page and you hear the moment its next edition opens.`,
    ],
    [
      `Which cities host HYROX in ${where}?`,
      `${upcomingCities.length ? `Coming up: ${listWords(upcomingCities)}. ` : ""}${pastCities.length ? `Raced recently, next date not announced yet: ${listWords(pastCities)}. ` : ""}The list follows the official race calendar on hyrox.com and updates on its own.`,
    ],
    [
      `Are HYROX ${def.name} tickets sold out?`,
      onSale.length
        ? `${onSale.length} of the ${g.upcoming.length} upcoming races in ${where} ${onSale.length === 1 ? "has" : "have"} tickets on sale right now (${listWords(onSale.map(cityOf))}). Popular ticket types sell out quickly, but sold-out tickets come back regularly when people's plans change: a free alert tells you the moment one does.`
        : `No race in ${where} has its ticket sale open right now, so nothing is sold out. Once a sale opens, the race's page shows which ticket types are available or sold out.`,
    ],
    [
      `When do HYROX ${def.name} tickets go on sale?`,
      `Every race has its own sale date, usually announced a few weeks ahead and often with a pre-sale first. ${
        announced.length ? `Announced so far: ${announced.map((e) => `${cityOf(e)} on ${formatInTimezone(e.presale_live_at!, e.presale_timezone)}`).join("; ")}. ` : ""
      }Set a free alert on a race's page and you get an email the moment its sale opens.`,
    ],
    [
      `Where do I buy tickets for HYROX races in ${where}?`,
      `Only on the official HYROX shop (hyrox.com). RoxRaceAlerts is an independent alert service built by a HYROX athlete; we never sell or reserve tickets.`,
    ],
  ];
  const title = `HYROX ${nameShown} ${season}: Races, Dates & Tickets | RoxRaceAlerts`;
  const description = `Every HYROX race in ${where} for ${season}: ${listWords([...upcomingCities, ...pastCities])}. Dates, venues and live ticket status, with a free alert when tickets go on sale or come back.`;
  const pageUrl = `${env.SITE_URL}/hyrox/${slug}`;
  const seo: PageSeo = {
    description,
    canonical: pageUrl,
    ownH1: true,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "HYROX races", item: `${env.SITE_URL}/` },
          { "@type": "ListItem", position: 2, name: `HYROX ${def.name}`, item: pageUrl },
        ],
      },
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: `HYROX races in ${where} ${season}`,
        itemListElement: g.upcoming.map((e, i) => ({ "@type": "ListItem", position: i + 1, name: `HYROX ${cityOf(e)}`, url: `${env.SITE_URL}/hyrox/${e.slug}` })),
      },
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
    ],
  };
  const row = (ev: DirectoryEvent, line: string, badge: string, cls: string) =>
    `<li><span><a href="/hyrox/${ev.slug}"><b>HYROX ${escapeHtml(cityOf(ev))}</b></a><br><span class="hint">${escapeHtml(line)}</span></span><span class="event-badge ${cls}" style="align-self:center">${badge}</span></li>`;
  return page(
    title,
    `${navBar("/", subscriber, counts.tickets + counts.races, !subscriber, env)}
    <div class="hero">
      <h1>HYROX ${escapeHtml(nameShown)} ${season}: races, dates and tickets</h1>
      <p class="hero-sub">${
        g.upcoming.length
          ? `${g.upcoming.length} upcoming HYROX race${g.upcoming.length === 1 ? "" : "s"} in ${escapeHtml(where)}: ${escapeHtml(listWords(upcomingCities))}. ${onSale.length} on sale now.`
          : `No upcoming HYROX race in ${escapeHtml(where)} is listed right now. Set an alert for the next edition of your city.`
      }</p>
    </div>
    ${
      g.upcoming.length
        ? `<div class="card"><h2>Upcoming HYROX races in ${escapeHtml(where)}</h2>
      <ul class="status-list">${g.upcoming.map((e) => row(e, `${dates(e)}${e.venue_name ? ` · ${e.venue_name}` : ""}`, status(e).badge, status(e).cls)).join("")}</ul>
      <p class="hint">Open a race for its tickets, venue and a free alert: we email you the moment its sale opens or a sold-out ticket comes back. Buying happens on hyrox.com.</p></div>`
        : ""
    }
    ${
      g.past.length
        ? `<div class="card"><h2>Waiting for the next edition</h2>
      <ul class="status-list">${g.past.map((e) => row(e, `Last race: ${e.event_date ? day(e.event_date) : "this season"}`, "Next edition not announced", "off")).join("")}</ul>
      <p class="hint">These cities raced recently and haven't announced the next date. Open one to set an alert and hear first.</p></div>`
        : ""
    }
    <div class="card faq"><h2>HYROX ${escapeHtml(def.name)}: questions</h2>${faq.map(([q, a]) => faqItem(q, a)).join("")}</div>
    ${countryLinksHtml(byCountry, slug)}
    <div class="card race-links"><p><a href="/">All upcoming HYROX races worldwide</a></p></div>`,
    {},
    false,
    seo
  );
}

// ---------------------------------------------------------------------------
// Race pages (/hyrox/<city>): one page per upcoming race - dates, ticket status, the tickets we
// track, the alert form and a race-specific FAQ. These are the pages that can rank for
// "hyrox <city> tickets"; the competitor that owns those searches has exactly this.
// ---------------------------------------------------------------------------
async function handleRacePage(req: Request, env: Env, slug: string): Promise<Response> {
  const events = await listDirectoryEvents(env);
  const ev = events.find((e) => e.slug === slug);
  const past = await listPastRaces(env, events);
  if (!ev) {
    const gone = past.find((e) => e.slug === slug);
    if (gone) return nextEditionPage(req, env, gone, events, past);
    const byCountry = racesByCountry(events, past);
    if (byCountry.has(slug)) return countryPage(req, env, slug, byCountry);
    const r = page("Race not found", `<div class="card"><p>We don't know an upcoming HYROX race at that address. <a href="/">See all upcoming HYROX races</a>.</p></div>`);
    return new Response(r.body, { status: 404, headers: r.headers });
  }
  const subscriber = await getSessionSubscriber(req, env);
  const counts = subscriber ? await getWatchCounts(subscriber.id, env) : { tickets: 0, races: 0 };
  const { name, city } = shortRaceName(ev.title);
  const year = raceYearLabel(ev);
  const alias = CITY_ALIASES[city.toLowerCase()];
  const cityShown = alias ? `${city} (${alias})` : city;
  const raceDay = ev.event_date
    ? new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ev.event_date}T00:00:00Z`))
    : "date to be announced";
  // Race days and venue as the official event page states them (2026-11-10: the competitor ranks
  // for the plain city name with exactly this information; our pages only talked about tickets).
  const endDate = ev.event_date && ev.event_end_date && ev.event_end_date > ev.event_date ? ev.event_end_date : null;
  const lastDay = endDate
    ? new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${endDate}T00:00:00Z`))
    : "";
  const raceDays = endDate ? `${raceDay} to ${lastDay}` : raceDay;
  const venueLine =
    ev.venue_name && ev.venue_address && !ev.venue_address.toLowerCase().includes(ev.venue_name.toLowerCase())
      ? `${ev.venue_name}, ${ev.venue_address}`
      : ev.venue_address || ev.venue_name || "";
  const saleWhen = ev.presale_live_at ? formatInTimezone(ev.presale_live_at, ev.presale_timezone) : "";
  const status = ev.on_sale
    ? { badge: "On sale now", cls: "on", short: "on sale now", sentence: `${name} tickets are on sale now on the official HYROX shop.` }
    : ev.presale_is_live
      ? { badge: "Pre-sale live", cls: "on", short: "pre-sale live", sentence: `A pre-sale for ${name} is live now${ev.presale_note ? `: ${truncate(ev.presale_note, 120)}` : "."}` }
      : ev.presale_live_at
        ? { badge: "Sale date announced", cls: "soon", short: "sale date announced", sentence: `${name} tickets go on sale ${saleWhen}.` }
        : { badge: "Not on sale yet", cls: "off", short: "not on sale yet", sentence: `${name} tickets are not on sale yet. HYROX usually announces the sale date a few weeks ahead.` };

  // Ticket types we track for this race (someone watches them), with their last known status.
  const shopPath = ev.shop_url ? ev.shop_url.split("?")[0] : "";
  const { results: trackedRows } = await env.DB.prepare(
    // Prefix match written with substr: D1 rejects LIKE patterns as long as a shop URL.
    "SELECT ticket_name, last_status FROM community_tickets WHERE (event_date IS NULL OR event_date >= ?1) AND (instr(event_name, ?2) > 0 OR substr(shop_url, 1, length(?3)) = ?3) ORDER BY ticket_name"
  )
    .bind(todayIso(), `HYROX ${city}`, shopPath || "\u0000")
    .all<any>();
  const tracked = new Map<string, string>();
  for (const t of trackedRows || []) if (!tracked.has(t.ticket_name)) tracked.set(t.ticket_name, t.last_status);
  const soldOut = [...tracked].filter(([, s]) => s === "sold_out").map(([n]) => n);
  const ticketsHtml = tracked.size
    ? `<div class="card"><h2>Ticket availability at ${escapeHtml(name)}</h2>
      <p class="hint">Ticket types athletes are watching here, with the last status we saw in the shop. Sold out is not the end: we alert watchers the moment one comes back.</p>
      <ul class="status-list">${[...tracked]
        .map(([n, s]) => `<li><span>${escapeHtml(n)}</span><span class="event-badge ${s === "sold_out" ? "off" : "on"}">${s === "sold_out" ? "Sold out" : "Available"}</span></li>`)
        .join("")}</ul></div>`
    : "";

  const official = `<a href="${escapeHtml(ev.url)}" rel="noopener">hyrox.com</a>`;
  // Same Free / Priority choice as on the homepage; handleWatchSale takes priority=1/season to checkout.
  const hasPriority = !!subscriber && (await ownsRacePriority(env, subscriber.id, ev.url));
  const offerPriority = priorityOfferedTo(env, subscriber) && !hasPriority;
  const seasonLabel = seasonButtonLabel(await seasonPriceFor(env, subscriber?.id));
  const saleButtons = offerPriority
    ? priorityChoiceHtml(
        env,
        "race",
        `<button type="submit" name="priority" value="0">Alert me - free</button>`,
        `<button type="submit" name="priority" value="1">&#9889; Notify me first - ${PRIORITY_PRICE_LABEL}</button>`,
        `<button type="submit" name="priority" value="season">&#9889; ${seasonLabel}</button>`
      )
    : `<button type="submit" name="priority" value="0">Alert me when ${escapeHtml(city)} tickets go on sale – free</button>`;
  // On sale: both choices lead to the ticket picker, which ends with the same Free / Priority buttons.
  const pickUrl = `/?event=${encodeURIComponent(ev.url)}`;
  const cta = ev.on_sale
    ? `${
        offerPriority
          ? priorityChoiceHtml(
              env,
              "ticket",
              `<a href="${pickUrl}"><button type="button">Watch - free</button></a>`,
              `<a href="${pickUrl}"><button type="button">&#9889; Watch first - ${PRIORITY_PRICE_LABEL}</button></a>`,
              `<a href="${pickUrl}"><button type="button">&#9889; ${seasonLabel}</button></a>`
            )
          : `<p><a href="${pickUrl}"><button type="button">Watch sold-out ${escapeHtml(city)} tickets – free</button></a></p>`
      }
       <p class="hint">${hasPriority ? "&#9889; You have Priority for this race. " : ""}Next you pick the ticket types you want (Singles, Doubles, Relay, Pro, Spectator...) and we alert you the moment one is available again. Coming to watch? Spectator tickets sell out too. Buying happens on ${official}.</p>`
    : `<form method="POST" action="/watch-sale">
        <input type="hidden" name="event_url" value="${escapeHtml(ev.url)}"><input type="hidden" name="event_title" value="${escapeHtml(ev.title)}">
        <input type="hidden" name="event_date" value="${escapeHtml(ev.event_date || "")}">
        ${subscriber ? "" : `<label>Your email<input type="email" name="email" required placeholder="you@example.com"></label>`}
        ${saleButtons}
        <p class="consent">${hasPriority ? "&#9889; You have Priority for this race: you're alerted first, also on WhatsApp. " : ""}One email the moment the sale opens. Unsubscribe any time. Coming to watch? Spectator tickets sell out too - once the sale opens you can watch those as well.</p>
      </form>`;

  // Spectator tickets get their own section: "hyrox <city> spectator tickets" is a search of its own
  // (1,000/month for NYC alone), and the generic FAQ answer was all the page said about them.
  const spectatorTracked = [...tracked].filter(([n]) => /spectator/i.test(n));
  const spectatorHtml = `<div class="card"><h2>HYROX ${escapeHtml(city)} spectator tickets</h2>
      ${
        spectatorTracked.length
          ? `<ul class="status-list">${spectatorTracked
              .map(([n, s]) => `<li><span>${escapeHtml(n)}</span><span class="event-badge ${s === "sold_out" ? "off" : "on"}">${s === "sold_out" ? "Sold out" : "Available"}</span></li>`)
              .join("")}</ul>`
          : ""
      }
      <p class="hint">${
        ev.on_sale
          ? `Spectator tickets for ${escapeHtml(name)} are sold on the official HYROX shop next to the race tickets`
          : `Spectator tickets for ${escapeHtml(name)} go on sale on the official HYROX shop together with the race tickets`
      }, usually with free entry for young children. They sell out at the big races too: ${
        ev.on_sale ? `<a href="${pickUrl}">watch the spectator ticket</a>` : "set the alert above"
      } and we tell you the moment one is available. <a href="/guides/hyrox-spectator-tickets">How HYROX spectator tickets work</a>.</p></div>`;

  const faq: [string, string][] = [
    [
      `HYROX ${city} ${year} ticket release date: when do tickets go on sale?`,
      ev.on_sale
        ? `They are on sale now. Buy on the official HYROX shop; if your ticket type is sold out, set a free alert here and we tell you when it comes back.`
        : ev.presale_live_at
          ? `The public sale opens ${saleWhen}. Popular races sell out within minutes, so set a free alert and be ready at that time.`
          : `HYROX hasn't announced the sale date yet. Sale dates are usually announced a few weeks ahead; set a free alert and you get an email the moment tickets open.`,
    ],
    [
      `Is there a HYROX ${city} ${year} presale?`,
      ev.presale_is_live
        ? `Yes, a pre-sale is live now${ev.presale_note ? `: ${truncate(ev.presale_note, 120)}` : "."} Pre-sale spots usually go fast; buy on the official HYROX shop.`
        : ev.on_sale
          ? `The pre-sale is over and tickets are on general sale now on the official HYROX shop.`
          : `HYROX often opens a pre-sale (for example for newsletter or community members) shortly before the public sale. Set a free alert and we email you the moment a pre-sale or the public sale opens.`,
    ],
    [
      `Is HYROX ${city} ${year} sold out?`,
      soldOut.length
        ? `${soldOut.length} of the ${tracked.size} ticket types we track here are currently sold out (${soldOut.slice(0, 4).join(", ")}${soldOut.length > 4 ? "..." : ""}). Sold-out HYROX tickets come back regularly when people's plans change, and we alert watchers the moment they do.`
        : ev.on_sale
          ? `Not that we have seen: the ticket types we track are available. Sold-out tickets usually come back at some point, so a free alert is worth setting if yours is gone.`
          : `Tickets aren't on sale yet, so nothing is sold out. Once the sale opens, this page shows which ticket types are available or sold out.`,
    ],
    [
      `How do I get a HYROX ${city} ticket if it's sold out?`,
      `Set a free alert for the ticket type you want. We check the official HYROX shop around the clock and email you (or message you on Telegram) the moment a spot is available again - then you buy it on hyrox.com as usual. Priority alerts you before everyone else.`,
    ],
    [
      `Is there a HYROX ${city} waitlist?`,
      `Some sold-out HYROX races offer an official notification list on the event page, depending on the region; joining it doesn't reserve a spot. A free RoxRaceAlerts alert works like a waitlist for the exact ticket type you want: we tell you the second one is back in the shop.`,
    ],
    [
      `Can I buy HYROX ${city} resale tickets?`,
      `Only through the official HYROX shop and its transfer or resale option, where HYROX offers one for this race. Avoid paying strangers in Facebook groups or chats - that's where ticket scams happen. Returned tickets reappear in the official shop, and an alert gets you there first.`,
    ],
    [
      `How much are HYROX ${city} tickets?`,
      `Prices are set per race and ticket type on the official HYROX shop: Singles is the cheapest athlete ticket, Doubles and Relay are priced per team, and spectator tickets cost much less than an athlete ticket. At some races the price goes up as the event gets closer, so buying at release is the cheapest way in - a free alert tells you the moment the sale opens.`,
    ],
    [
      `Are there HYROX ${city} spectator tickets?`,
      `At most HYROX races spectators need a ticket, often with free entry for young children. They are sold on the official HYROX shop next to the race tickets. Spectator tickets can sell out at the biggest events; you can set a free alert for them like for any other ticket type.`,
    ],
    [
      `Where do I buy HYROX ${city} tickets?`,
      `Only on the official HYROX shop (hyrox.com). RoxRaceAlerts is an independent alert service built by a HYROX athlete; we never sell or reserve tickets.`,
    ],
  ];
  // "When" and "where" lead the questions: they are what people who type just the city want to know.
  if (venueLine) faq.unshift([`Where is HYROX ${city} ${year} held?`, `${name} ${year} is held at ${venueLine}, according to the official event page on hyrox.com.`]);
  if (ev.event_date)
    faq.unshift([
      `When is HYROX ${city} ${year}?`,
      `${name} ${year} takes place ${endDate ? `from ${raceDay} to ${lastDay}` : `on ${raceDay}`}${ev.venue_name ? ` at ${ev.venue_name}` : ""}. Which division races on which day is published on the official event page closer to the race.`,
    ]);
  const infoHtml =
    ev.event_date && (endDate || venueLine)
      ? `<div class="card"><h2>HYROX ${escapeHtml(city)} ${year}: dates and venue</h2>
      <p>${escapeHtml(name)} ${year} takes place ${endDate ? `from <b>${escapeHtml(raceDay)}</b> to <b>${escapeHtml(lastDay)}</b>` : `on <b>${escapeHtml(raceDay)}</b>`}${venueLine ? ` at <b>${escapeHtml(venueLine)}</b>` : ""}. ${escapeHtml(status.sentence)}</p>
      <p class="hint">Dates and venue as published on the official event page on ${official}. Start times per division are announced there closer to the race.</p></div>`
      : "";
  const others = events.filter((e) => e !== ev).slice(0, 10);
  const supporters = await listSupporters(env, ev.slug);
  const supportersHtml = `<div class="card"><h2>Gyms supporting HYROX ${escapeHtml(city)} athletes</h2>${
    supporters.length ? `<div class="sponsors">${supporterTiles(supporters)}</div>` : `<p class="hint">No supporting gym listed for ${escapeHtml(city)} yet.</p>`
  }<p class="hint">Gym or club in ${escapeHtml(city)}? Put the live ticket widget on your website and get a free tile here: <a href="/supporters?race=${ev.slug}">how it works</a>.</p>
    <textarea readonly rows="3" style="width:100%;padding:8px;font-family:monospace;font-size:0.8rem;border:1px solid #ddd;border-radius:6px;box-sizing:border-box" onclick="this.select()">${escapeHtml(widgetSnippet(env, ev.slug!, city))}</textarea></div>`;
  // Search phrase first, then the brand (what people type: "<city> tickets sold out", "release
  // date", "waitlist"); each part only where it's true for this race.
  // "presale" added 2026-11-02: Search Console showed "<city> 2027 tickets presale" finding race pages.
  const titleTail = ev.on_sale ? "On Sale, Sold Out & Waitlist" : ev.presale_live_at ? "Presale, Release Date & Alerts" : "Presale, Release Date & Waitlist";
  const title = `HYROX ${cityShown} ${year} Tickets: ${titleTail} | RoxRaceAlerts`;
  const description = `${status.sentence} Race day${endDate ? "s" : ""}: ${raceDays}${ev.venue_name ? ` at ${ev.venue_name}` : ""}. Free alert the second ${city} tickets go on sale or a sold-out ticket comes back.`;
  const pageUrl = `${env.SITE_URL}/hyrox/${ev.slug}`;
  const seo: PageSeo = {
    description,
    canonical: pageUrl,
    ownH1: true,
    // Google rejects an Event without a start date (Search Console 2026-11-10: /hyrox/new-york
    // failed the Events check), so a race HYROX hasn't dated yet carries no event data at all.
    jsonLd: [
      ...(ev.event_date ? [{
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        name: `${name} ${year}`.trim(),
        description,
        startDate: ev.event_date,
        endDate: endDate || ev.event_date,
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        eventStatus: "https://schema.org/EventScheduled",
        location: { "@type": "Place", name: ev.venue_name || name, address: { "@type": "PostalAddress", addressLocality: city, ...(ev.venue_address ? { streetAddress: ev.venue_address } : {}) } },
        organizer: { "@type": "Organization", name: "HYROX", url: "https://hyrox.com" },
        url: ev.url,
        offers: {
          "@type": "Offer",
          url: ev.url,
          ...(ev.on_sale ? { availability: "https://schema.org/InStock" } : ev.presale_live_at ? { availability: "https://schema.org/PreOrder", validFrom: ev.presale_live_at } : {}),
        },
      }] : []),
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "HYROX races", item: `${env.SITE_URL}/` },
          { "@type": "ListItem", position: 2, name: `HYROX ${city}`, item: pageUrl },
        ],
      },
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
    ],
  };
  return page(
    title,
    `${navBar("/", subscriber, counts.tickets + counts.races, !subscriber, env)}
    <div class="hero">
      <h1>HYROX ${escapeHtml(cityShown)} ${year} tickets: ${escapeHtml(status.short)}</h1>
      <p class="hero-sub">${escapeHtml(status.sentence)}</p>
    </div>
    <div class="card">
      <h2>Ticket status</h2>
      <ul class="status-list">
        <li><span>Status</span><span class="event-badge ${status.cls}">${status.badge}</span></li>
        <li><span>${endDate ? "Race days" : "Race day"}</span><span>${escapeHtml(raceDays)}</span></li>
        ${venueLine ? `<li><span>Venue</span><span>${escapeHtml(venueLine)}</span></li>` : ""}
        ${saleWhen && !ev.on_sale ? `<li><span>Tickets go on sale</span><span>${escapeHtml(saleWhen)}</span></li>` : ""}
        <li><span>Official event page</span><span>${official}</span></li>
      </ul>
      ${cta}
    </div>
    ${infoHtml}
    ${ticketsHtml}
    ${spectatorHtml}
    <div class="card faq"><h2>HYROX ${escapeHtml(city)} tickets: questions</h2>${faq.map(([q, a]) => faqItem(q, a)).join("")}</div>
    ${supportersHtml}
    <div class="card race-links"><h2>Other upcoming HYROX races</h2>
      ${others.map((o) => `<a href="/hyrox/${o.slug}">HYROX ${escapeHtml(shortRaceName(o.title).city)}${o.event_date ? ` (${escapeHtml(o.event_date)})` : ""}</a>`).join("")}
      ${countryLineHtml(ev, racesByCountry(events, past))}
      <p><a href="/">All ${events.length} upcoming HYROX races</a></p>
    </div>
    ${raceFooterLinksHtml(events, past)}`,
    {},
    false,
    seo
  );
}

// "HYROX race alerts" (the brand words, and what the old heading said) and "ticket alerts" both
// stay in the title and H1: the 2026-10-27 rewrite dropped the first and the brand search slipped.
const HOME_TITLE = "HYROX Race Alerts & Ticket Alerts (Free) | RoxRaceAlerts";
const HOME_DESCRIPTION =
  "Free HYROX race alerts: get notified the second tickets go on sale or a sold-out spot comes back. Every HYROX race worldwide, by email or Telegram. Priority from $3, no subscription.";

/** The race list as HTML, same shape the page script renders, so the page reads the same with
 * and without script. The script replaces it once the live feed has loaded. */
function eventListHtml(events: DirectoryEvent[]): string {
  const row = (ev: DirectoryEvent, badge: string, cls: string, subtitle = "") =>
    `<div class="event-row" data-url="${escapeHtml(ev.url)}"><div><span>Race: ${escapeHtml(ev.event_date || "date TBA")} &mdash; ${escapeHtml(ev.title)}</span>${
      ev.slug ? ` <a class="row-link" href="/hyrox/${ev.slug}">Details</a>` : ""
    }${subtitle ? `<div class="event-subtitle">${escapeHtml(subtitle)}</div>` : ""}</div><div class="event-right"><span class="event-badge ${cls}">${badge}</span><span class="row-chev">&#8250;</span></div></div>`;
  const group = (title: string, rows: string[]) =>
    rows.length ? `<div class="event-group"><h3>${title} (${rows.length})</h3><div class="event-group-rows">${rows.join("")}</div></div>` : "";
  const on = events.filter((e) => e.on_sale).map((e) => row(e, "On sale", "on"));
  const soon = events
    .filter((e) => !e.on_sale && e.presale_live_at)
    .map((e) => row(e, "Public sale (soon live)", "soon", `on ${formatInTimezone(e.presale_live_at!, e.presale_timezone)}`));
  const waiting = events.filter((e) => !e.on_sale && !e.presale_live_at).map((e) => row(e, "Not on sale", "off"));
  return group("On sale now", on) + group("Sale date announced", soon) + group("Not on sale yet", waiting);
}

// Returns were only logged (ticket_returns) from this date; earlier ones are counted from the
// alert emails that went out (one return = one ticket name within one hour).
const RETURNS_LOGGED_SINCE = "2026-11-03";

/** Real numbers for the homepage and the "tickets that came back" page. */
async function siteStats(env: Env): Promise<{ athletes: number; alerts: number; returns: number }> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM subscribers WHERE verified = 1) AS athletes,
            (SELECT COUNT(*) FROM email_log WHERE ok = 1 AND (subject LIKE 'Ticket available:%' OR subject LIKE '%on sale%' OR subject LIKE '%live%'))
              + (SELECT COUNT(*) FROM telegram_log WHERE ok = 1) AS alerts,
            (SELECT COUNT(DISTINCT substr(created_at, 1, 13) || subject) FROM email_log WHERE ok = 1 AND subject LIKE 'Ticket available:%' AND created_at < ?1)
              + (SELECT COUNT(*) FROM ticket_returns WHERE returned_at >= ?1) AS returns`
  )
    .bind(RETURNS_LOGGED_SINCE)
    .first<any>()
    .catch(() => null);
  return { athletes: Number(r?.athletes) || 0, alerts: Number(r?.alerts) || 0, returns: Number(r?.returns) || 0 };
}

/** 333 -> 330, 1234 -> 1200: a rounded-down figure that stays true as "N+". */
function roundDown(n: number): number {
  if (n < 100) return Math.floor(n / 10) * 10;
  const step = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / step) * step;
}

/** Public page: sold-out tickets that came back in the last 30 days, per race - proof that waiting
 * (with an alert) works. Also the live sold-out list. */
async function handleTicketsBackPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const counts = subscriber ? await getWatchCounts(subscriber.id, env) : { tickets: 0, races: 0 };
  const stats = await siteStats(env);
  const { results: recent } = await env.DB.prepare(
    `SELECT event_name, COUNT(*) AS n, MAX(returned_at) AS last_at,
            (SELECT group_concat(t, ', ') FROM (SELECT DISTINCT replace(r2.ticket_name, 'HYROX ', '') AS t FROM ticket_returns r2 WHERE r2.event_name = r.event_name AND r2.returned_at >= datetime('now', '-30 days') LIMIT 4)) AS tickets
     FROM ticket_returns r WHERE returned_at >= datetime('now', '-30 days') GROUP BY event_name ORDER BY n DESC, last_at DESC LIMIT 30`
  ).all<any>();
  const { results: soldOut } = await env.DB.prepare(
    `SELECT event_name, COUNT(*) AS n FROM community_tickets WHERE last_status = 'sold_out' AND (event_date IS NULL OR event_date >= ?)
     GROUP BY event_name ORDER BY n DESC LIMIT 20`
  )
    .bind(todayIso())
    .all<any>();
  const races = await listDirectoryEvents(env);
  const raceHref = (eventName: string) => {
    const city = shortRaceName(eventName).city.toLowerCase();
    const ev = races.find((e) => shortRaceName(e.title).city.toLowerCase() === city);
    return ev ? `/hyrox/${ev.slug}` : `/?q=${encodeURIComponent(city)}`;
  };
  const ago = (iso: string) => {
    const h = Math.max(0, Math.round((Date.now() - Date.parse(`${iso.replace(" ", "T")}Z`)) / 3600_000));
    return h < 1 ? "just now" : h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  };
  const title = "Sold-out HYROX tickets that came back";
  const description = `${roundDown(stats.returns)}+ sold-out HYROX tickets spotted coming back since October 2026. Which races and ticket types returned in the last 30 days, updated automatically, and how to catch the next one with a free alert.`;
  const body = `<div class="hero"><h1>${escapeHtml(title)}</h1><p class="hero-sub">Sold out is not the end. These tickets were sold out and came back, and watchers were alerted the moment they did.</p>
    ${stats.returns >= 10 ? `<p class="stats-line"><b>${roundDown(stats.returns)}+</b> returns spotted since October 2026 &middot; <b>${stats.athletes}</b> athletes watching &middot; checked around the clock</p>` : ""}</div>
    <div class="card"><h2>Came back in the last 30 days</h2>
    ${
      recent?.length
        ? `<ul class="status-list">${recent
            .map((r: any) => `<li><span><a href="${raceHref(r.event_name)}">${escapeHtml(shortRaceName(r.event_name).name)}</a><br><small>${escapeHtml(r.tickets || "")}</small></span><span><b>${r.n}</b> return${r.n === 1 ? "" : "s"}<br><small>last ${escapeHtml(ago(r.last_at))}</small></span></li>`)
            .join("")}</ul>`
        : `<p class="hint">This list started on ${RETURNS_LOGGED_SINCE} and fills up as tickets come back.${stats.returns >= 10 ? ` Before that, our alerts caught ${roundDown(stats.returns)}+ returns.` : ""}</p>`
    }
    <p class="hint">A return is one ticket type (for example Doubles Mixed, Saturday) going from sold out to available in the official HYROX shop. Most are gone again within the hour, which is why watchers get alerted instantly.</p></div>
    <div class="card"><h2>Sold out right now (${(soldOut || []).reduce((s: number, r: any) => s + Number(r.n), 0)} ticket types)</h2>
    ${
      soldOut?.length
        ? `<ul class="status-list">${soldOut.map((r: any) => `<li><span><a href="${raceHref(r.event_name)}">${escapeHtml(shortRaceName(r.event_name).name)}</a></span><span>${r.n} sold out</span></li>`).join("")}</ul>`
        : "<p>None of the tickets being watched are sold out right now.</p>"
    }
    <p class="hint">Only tickets someone is watching are listed. Watch yours and it joins the check.</p></div>
    ${ARTICLE_CTA}`;
  return page(
    `${title} | RoxRaceAlerts`,
    `${navBar("/", subscriber, counts.tickets + counts.races, !subscriber, env)}${body}`,
    {},
    false,
    articleSeo(env, "/tickets-back", title, description, [
      ["Do sold-out HYROX tickets really come back?", `Yes. RoxRaceAlerts has spotted ${roundDown(stats.returns)}+ sold-out ticket types becoming available again since October 2026, from cancellations, expired reservations and extra capacity. This page lists the latest ones.`],
      ["How long does a returned ticket stay available?", "Often minutes, rarely more than an hour at popular races. Set a free alert on the exact ticket type and buy on the official shop as soon as you get it."],
    ])
  );
}

/** One FAQ entry: the question is a line you click to open the answer (2026-11-03: the open
 * lists took too much space). The answer stays in the HTML, so search engines still read it. */
function faqItem(q: string, a: string): string {
  return `<details><summary><h3>${escapeHtml(q)}</h3></summary><p>${escapeHtml(a)}</p></details>`;
}

function eventSummaryLine(events: DirectoryEvent[]): string {
  const on = events.filter((e) => e.on_sale).length;
  const soon = events.filter((e) => !e.on_sale && e.presale_live_at).length;
  return `<p class="hint">Tracking ${events.length} upcoming HYROX races: ${on} on sale now, ${soon} with a sale date announced, ${events.length - on - soon} not on sale yet. Updated around the clock.</p>`;
}

const HOME_FAQ: [string, string][] = [
  [
    "Does \"sold out\" mean a HYROX race is gone for good?",
    "No. Sold-out HYROX tickets come back regularly when people's plans change or the organiser releases extra spots, usually without any announcement. RoxRaceAlerts watches the ticket shop and alerts you the moment your ticket type is available again.",
  ],
  [
    "How do HYROX ticket alerts work?",
    "Pick a race and the tickets you want (Singles, Doubles, Relay, Pro, spectator...). We check the official HYROX ticket shops around the clock and email you the second a sale opens or a sold-out ticket is back. Telegram alerts are free too; Priority members also get WhatsApp.",
  ],
  [
    "Is RoxRaceAlerts free?",
    "Yes. Email and Telegram alerts are free for every race. Priority is optional: a one-off payment per race or per season gets you alerted before everyone else, with a WhatsApp notification. There is no subscription.",
  ],
  [
    "When do HYROX tickets go on sale?",
    "Each race has its own sale date, usually announced a few weeks in advance. The list on this page shows every upcoming race with its status: on sale, sale date announced, or not on sale yet. Watch a race and you get an alert the moment its sale opens.",
  ],
  [
    "Is RoxRaceAlerts official HYROX?",
    "No. RoxRaceAlerts is an independent alert service built by a HYROX athlete and is not affiliated with HYROX or its ticketing provider. We never sell or reserve tickets: when you get an alert, you buy on the official HYROX shop as usual.",
  ],
  [
    "Which HYROX races are covered?",
    "Every HYROX race worldwide, including pre-sales, public sales and sold-out ticket returns. New races are added as soon as HYROX announces them.",
  ],
];

function homeFaqHtml(): string {
  return `<div class="card faq"><h2>HYROX ticket alerts: common questions</h2>${HOME_FAQ.map(([q, a]) => faqItem(q, a)).join("")}</div>`;
}

function homeSeo(env: Env): PageSeo {
  return {
    description: HOME_DESCRIPTION,
    canonical: `${env.SITE_URL}/`,
    ownH1: true,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "RoxRaceAlerts",
        url: env.SITE_URL,
        logo: `${env.SITE_URL}/favicon.svg`,
        sameAs: [IG_PROFILE_URL],
      },
      { "@context": "https://schema.org", "@type": "WebSite", name: "RoxRaceAlerts", url: env.SITE_URL, description: HOME_DESCRIPTION },
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: HOME_FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// About and guide pages: the founder story (search engines and AI answers weigh "who is behind
// this site") and evergreen guides for the questions athletes search for. The sale-dates and
// ticket-types guides fill themselves from the directory data.
// ---------------------------------------------------------------------------
const GUIDE_SLUGS = ["sold-out-hyrox-tickets", "hyrox-ticket-sale-dates", "hyrox-ticket-types", "hyrox-spectator-tickets"] as const;

function articleSeo(env: Env, path: string, title: string, description: string, faq: [string, string][] = []): PageSeo {
  return {
    description,
    canonical: `${env.SITE_URL}${path}`,
    ownH1: true,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: title,
        description,
        url: `${env.SITE_URL}${path}`,
        author: { "@type": "Person", name: "Francesco", description: "HYROX Pro athlete, builder of RoxRaceAlerts" },
        publisher: { "@type": "Organization", name: "RoxRaceAlerts", url: env.SITE_URL },
        dateModified: todayIso(),
      },
      ...(faq.length ? [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }] : []),
    ],
  };
}

const ARTICLE_CTA = `<div class="card"><h2>Never miss a HYROX ticket again</h2><p>Free alerts the second a race goes on sale or a sold-out ticket comes back, for every HYROX race worldwide. Email, Telegram, and WhatsApp with Priority.</p><p><a href="/"><button type="button">Set a free alert</button></a></p></div>`;

async function handleAboutPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const counts = subscriber ? await getWatchCounts(subscriber.id, env) : { tickets: 0, races: 0 };
  const races = await listDirectoryEvents(env);
  const subs = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE verified = 1").first<any>();
  const title = "About RoxRaceAlerts: built by a HYROX Pro athlete";
  const description = "RoxRaceAlerts was built by Francesco, a HYROX Pro athlete, after missing one ticket drop too many. Free alerts for every HYROX race worldwide; independent, not affiliated with HYROX.";
  return page(
    title,
    `${navBar("/", subscriber, counts.tickets + counts.races, !subscriber, env)}
    <div class="hero"><h1>About RoxRaceAlerts</h1><p class="hero-sub">Built by a HYROX athlete who kept missing tickets.</p></div>
    <div class="card">
      <p>Hi, I'm Francesco. I race HYROX in the Pro division, and like everyone else I kept refreshing ticket shops, missing drops, and finding races sold out before I even knew they had opened. There was no simple, free tool that watched the races and tickets for me, so I used my coding skills to build one, out of pure frustration, and decided to make it available to anyone.</p>
      <p>RoxRaceAlerts checks the official HYROX ticket shops around the clock, for every race worldwide (${races.length} upcoming races right now), and alerts you the second a race goes on sale, a pre-sale opens, or a sold-out ticket type becomes available again. Email and Telegram alerts are free, always. Priority, a one-off payment per race or season, gets you alerted before everyone else, with a WhatsApp notification. ${Number(subs?.n) > 50 ? `More than ${Math.floor(Number(subs.n) / 10) * 10} athletes already use it.` : ""}</p>
      <h2>What it is not</h2>
      <p>RoxRaceAlerts is independent and not affiliated with HYROX or its ticketing provider. We never sell, resell or reserve tickets: when you get an alert, you buy on the official HYROX shop like everyone else, just earlier.</p>
      <h2>Get in touch</h2>
      <p>Ideas, complaints, a race we're missing: write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> or <a href="/feedback">leave feedback</a>. Gyms and brands: see <a href="/partners">partner with us</a>. Follow <a href="${IG_PROFILE_URL}" rel="noopener">@roxracealerts on Instagram</a> for upcoming ticket dates.</p>
    </div>
    ${ARTICLE_CTA}`,
    {},
    false,
    { ...articleSeo(env, "/about", title, description), jsonLd: [{ "@context": "https://schema.org", "@type": "AboutPage", name: title, url: `${env.SITE_URL}/about`, description }] }
  );
}

async function handleGuidePage(req: Request, env: Env, slug: string): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const counts = subscriber ? await getWatchCounts(subscriber.id, env) : { tickets: 0, races: 0 };
  const nav = navBar("/", subscriber, counts.tickets + counts.races, !subscriber, env);
  const races = await listDirectoryEvents(env);
  const raceLink = (e: DirectoryEvent) => `<a href="/hyrox/${e.slug}">HYROX ${escapeHtml(shortRaceName(e.title).city)}</a>`;
  const otherGuides = (current: string) =>
    `<div class="card race-links"><h2>More guides</h2>${GUIDE_SLUGS.filter((s) => s !== current)
      .map((s) => `<a href="/guides/${s}">${GUIDE_TITLES[s]}</a>`)
      .join("")}<a href="/about">About RoxRaceAlerts</a></div>`;

  if (slug === "sold-out-hyrox-tickets") {
    const title = GUIDE_TITLES[slug];
    const description = "Sold-out HYROX tickets come back more often than you think. How returns, the waitlist and resale work, how to catch a spot, and how free alerts do the waiting for you.";
    const faq: [string, string][] = [
      ["Do sold-out HYROX tickets come back?", "Yes, regularly. Tickets return when athletes cancel or transfer, when payment reservations expire, and when the organiser releases held or extra spots. There is usually no announcement, and a returned spot can be gone within minutes."],
      ["Does HYROX have an official waitlist?", "Some sold-out event pages offer a notification list run by the ticketing provider; it depends on the race and region. It costs nothing to join, but it does not reserve anything: you still need to be fast when spots appear."],
      ["Can I buy HYROX tickets second-hand?", "Be careful. HYROX tickets are personal and transfers go through the official ticketing provider, where offered. Facebook groups and unofficial resellers are where most ticket scams happen; never pay a stranger up front."],
      ["How fast do I need to be?", "Popular races and categories (Doubles, Pro) can sell out in minutes at launch and returned spots often go within the hour. An alert the moment a spot appears is the difference."],
    ];
    const body = `<div class="hero"><h1>${escapeHtml(title)}</h1><p class="hero-sub">Sold out is not the end. Here is how returned spots work and how to catch one.</p></div>
    <div class="card">
      <h2>Why sold-out HYROX tickets come back</h2>
      <p>Every HYROX race is sold through an official ticket shop per region. Once a ticket type (say Doubles Mixed on Saturday) shows sold out, three things keep putting spots back:</p>
      <ul><li><b>Cancellations and transfers.</b> Injuries, travel plans and partner changes mean athletes give tickets back right up to race week.</li>
      <li><b>Expired reservations.</b> At launch, many tickets sit in carts that are never paid for; those return to the shop minutes to hours later.</li>
      <li><b>Extra capacity.</b> Organisers sometimes add waves or release held allocations, without an announcement.</li></ul>
      <h2>How to actually get one</h2>
      <ol><li><b>Watch the exact ticket type.</b> A returned spot is one category on one day. Set your alert on the specific tickets you would buy, not just the race.</li>
      <li><b>Get alerted instantly, not daily.</b> Returned spots rarely last an hour. RoxRaceAlerts checks the shop around the clock and emails or messages you the moment your ticket is available.</li>
      <li><b>Be ready to pay.</b> Have your account on the HYROX shop logged in and your card ready; the alert links straight to the shop.</li>
      <li><b>Keep the alert on until you have the ticket.</b> If you miss one return, there is usually another.</li></ol>
      <h2>What to avoid</h2>
      <p>Paying strangers in Facebook groups or chats is how most people lose money. Only use the official shop and, where offered, its official transfer feature.</p>
    </div>
    <div class="card faq"><h2>Questions</h2>${faq.map(([q, a]) => faqItem(q, a)).join("")}</div>
    ${ARTICLE_CTA}${otherGuides(slug)}`;
    return page(`${title} | RoxRaceAlerts`, `${nav}${body}`, {}, false, articleSeo(env, `/guides/${slug}`, title, description, faq));
  }

  if (slug === "hyrox-ticket-sale-dates") {
    const title = GUIDE_TITLES[slug];
    const announced = races.filter((e) => !e.on_sale && e.presale_live_at);
    const onSale = races.filter((e) => e.on_sale);
    const notYet = races.filter((e) => !e.on_sale && !e.presale_live_at);
    const description = `When HYROX tickets go on sale, how the pre-sale and public sale work, and every announced sale date: ${announced.length} upcoming sale${announced.length === 1 ? "" : "s"} announced, ${onSale.length} races on sale now. Updated automatically.`;
    const faq: [string, string][] = [
      ["When do HYROX tickets go on sale?", "Each race has its own date, usually announced two to six weeks before. Sales open at a fixed local time, often late morning, first for pre-sale groups and then to the public. The list on this page shows every announced date and is updated automatically."],
      ["What is the HYROX pre-sale?", "Many races open a few hours or days early for a limited group, such as newsletter subscribers, members of partner gyms, or athletes who raced before. Pre-sale allocations are small and can sell out before the public sale."],
      ["Is there a ballot or lottery?", "No. HYROX tickets are first come, first served once a sale opens, which is why popular races sell out in minutes and why an alert at the exact moment matters."],
    ];
    const list = (items: DirectoryEvent[], right: (e: DirectoryEvent) => string) =>
      items.length ? `<ul class="status-list">${items.map((e) => `<li><span>${raceLink(e)}</span><span>${right(e)}</span></li>`).join("")}</ul>` : "<p>None right now.</p>";
    const body = `<div class="hero"><h1>${escapeHtml(title)}</h1><p class="hero-sub">Every announced sale date in one place, updated automatically from the official shops.</p></div>
    <div class="card"><h2>Sale dates announced (${announced.length})</h2>${list(announced, (e) => escapeHtml(formatInTimezone(e.presale_live_at!, e.presale_timezone)))}</div>
    <div class="card"><h2>How a HYROX ticket sale works</h2>
      <ol><li><b>Announcement.</b> HYROX announces the sale date, usually on Instagram, in the newsletter and on the event page, two to six weeks ahead.</li>
      <li><b>Pre-sale.</b> A small allocation opens early for newsletter subscribers, partner gyms or returning athletes.</li>
      <li><b>Public sale.</b> Everything else opens at the announced local time, first come, first served. Doubles and Pro categories at big-city races can be gone within minutes.</li>
      <li><b>Returns.</b> In the weeks after, sold-out tickets come back as plans change; see <a href="/guides/sold-out-hyrox-tickets">how to catch a sold-out ticket</a>.</li></ol>
      <p>Set a free alert on a race and RoxRaceAlerts emails you the moment its pre-sale or public sale opens, so you don't have to remember the time or the time zone.</p></div>
    <div class="card"><h2>On sale now (${onSale.length})</h2>${list(onSale, (e) => `Race ${escapeHtml(e.event_date || "TBA")}`)}</div>
    <div class="card"><h2>Not on sale yet (${notYet.length})</h2>${list(notYet, (e) => `Race ${escapeHtml(e.event_date || "TBA")}`)}</div>
    <div class="card faq"><h2>Questions</h2>${faq.map(([q, a]) => faqItem(q, a)).join("")}</div>
    ${ARTICLE_CTA}${otherGuides(slug)}`;
    return page(`${title} | RoxRaceAlerts`, `${nav}${body}`, {}, false, articleSeo(env, `/guides/${slug}`, title, description, faq));
  }

  if (slug === "hyrox-ticket-types") {
    const title = GUIDE_TITLES[slug];
    // Which categories sell out most, from the tickets athletes are watching.
    const { results: cats } = await env.DB.prepare(
      `SELECT CASE WHEN upper(ticket_name) LIKE '%RELAY%' THEN 'Relay' WHEN upper(ticket_name) LIKE '%DOUBLES%' THEN 'Doubles' WHEN upper(ticket_name) LIKE '%PRO%' THEN 'Pro' WHEN upper(ticket_name) LIKE '%ADAPTIVE%' THEN 'Adaptive' WHEN upper(ticket_name) LIKE '%SPECTATOR%' THEN 'Spectator' ELSE 'Open (Singles)' END AS cat,
              SUM(last_status = 'sold_out') AS sold, COUNT(*) AS n
       FROM community_tickets WHERE event_date IS NULL OR event_date >= ? GROUP BY cat ORDER BY sold DESC`
    )
      .bind(todayIso())
      .all<any>();
    const description = "HYROX ticket types explained: Open (Singles), Pro, Doubles, Relay, Adaptive, Youngstars and spectator tickets, who they are for, and which ones sell out first.";
    const faq: [string, string][] = [
      ["What is the difference between HYROX Open and Pro?", "Same course, heavier weights. Pro uses heavier sled push and pull, higher wall balls, heavier farmers carry, sandbag lunges and kettlebells. Open is the standard division most athletes race; Pro is for experienced athletes chasing a competitive time."],
      ["How do HYROX Doubles tickets work?", "Doubles is two athletes sharing the workout stations while both run every 1 km. Each athlete needs a ticket; the shop usually sells a Doubles ticket plus an 'Athlete 2' partner ticket, and Doubles categories (Men, Women, Mixed, Pro) are among the first to sell out."],
      ["Which HYROX tickets sell out first?", "Typically Doubles and the Saturday slots at big-city races, then Open Men and Women on the most popular days. Relay and weekday slots last longer. Sold-out tickets come back regularly, so a free alert on the one you want is worth setting."],
      ["Do spectators need a ticket?", "Yes, at most races spectators need a ticket, often with free entry for young children. Spectator tickets are usually plentiful but can sell out at the biggest events."],
    ];
    const body = `<div class="hero"><h1>${escapeHtml(title)}</h1><p class="hero-sub">Who each ticket is for, and which ones disappear first.</p></div>
    <div class="card">
      <h2>The HYROX ticket types</h2>
      <ul><li><b>Open (Singles), Men and Women.</b> The standard race: 8 km of running and 8 workout stations, standard weights. The most common ticket.</li>
      <li><b>Pro.</b> Same format with heavier weights and higher wall balls. For experienced, competitive athletes; also the division used for elite qualification.</li>
      <li><b>Doubles (Men, Women, Mixed, Pro Doubles).</b> Two athletes: both run every 1 km, then split the work at each station. Each needs a ticket, usually sold as a ticket plus a partner ("Athlete 2") ticket.</li>
      <li><b>Relay (Men, Women, Mixed).</b> A team of four; each member runs 1 km and does one station, twice. The most accessible way in and the slowest to sell out.</li>
      <li><b>Adaptive.</b> Divisions for athletes with physical disabilities, with adapted stations.</li>
      <li><b>Youngstars.</b> Separate races for kids and teens, usually on their own day or event.</li>
      <li><b>Spectator.</b> Entry for supporters; often free for young children.</li></ul>
      <p>Most tickets exist once per race day (Friday, Saturday, Sunday...), so "HYROX Doubles Mixed | Saturday" and "| Sunday" are separate tickets with separate availability.</p>
    </div>
    ${
      cats?.length
        ? `<div class="card"><h2>What sells out most</h2><p class="hint">Ticket types athletes are watching on RoxRaceAlerts right now, and how many of them are sold out.</p><ul class="status-list">${cats
            .map((c: any) => `<li><span>${escapeHtml(c.cat)}</span><span>${c.sold} of ${c.n} sold out</span></li>`)
            .join("")}</ul></div>`
        : ""
    }
    <div class="card faq"><h2>Questions</h2>${faq.map(([q, a]) => faqItem(q, a)).join("")}</div>
    ${ARTICLE_CTA}${otherGuides(slug)}`;
    return page(`${title} | RoxRaceAlerts`, `${nav}${body}`, {}, false, articleSeo(env, `/guides/${slug}`, title, description, faq));
  }

  if (slug === "hyrox-spectator-tickets") {
    // 2026-11-02: spectator tickets were sold out at several races and families were paying for
    // alerts on them - nobody else writes for the people who come to watch.
    const title = GUIDE_TITLES[slug];
    const { results: spec } = await env.DB.prepare(
      `SELECT event_name, SUM(last_status = 'sold_out') AS sold, COUNT(*) AS n FROM community_tickets
       WHERE upper(ticket_name) LIKE '%SPECTATOR%' AND (event_date IS NULL OR event_date >= ?) GROUP BY event_name ORDER BY sold DESC, event_name LIMIT 15`
    )
      .bind(todayIso())
      .all<any>();
    const soldOutRaces = (spec || []).filter((r: any) => Number(r.sold) > 0);
    const description = "Do HYROX spectator tickets sell out? Yes, at the big races. Who needs one, what they cost, kids, buying at the door, and how to get alerted when sold-out spectator tickets come back.";
    const sellOutAnswer = `Yes, at the biggest races. ${soldOutRaces.length ? `Right now spectator tickets are sold out at ${soldOutRaces.slice(0, 3).map((r: any) => shortRaceName(r.event_name).name).join(", ")}${soldOutRaces.length > 3 ? " and more" : ""}.` : "Venues have limited space, and the busiest days (usually Saturday) go first."} Like athlete tickets, they come back when plans change, so a free alert on the day you need is worth setting.`;
    const faq: [string, string][] = [
      ["Do HYROX spectator tickets sell out?", sellOutAnswer],
      ["Can you buy HYROX spectator tickets at the door?", "Don't count on it. Spectator tickets are sold online in the official HYROX shop, per race day. Where an event sells them on site at all, it is only while that day isn't sold out - and the popular days are. Buy online before you travel."],
      ["Will HYROX release more spectator tickets?", "Sometimes. Extra spectator tickets are occasionally added closer to the race, and tickets that people give back reappear in the official shop. Neither is announced ahead of time, which is why an alert on the exact day helps."],
      ["Do I need a ticket to watch HYROX?", "At most HYROX races, yes: spectators need a spectator ticket to enter the venue, usually sold per race day in the same official shop as the athlete tickets. A few smaller events let supporters in for free; the event page on hyrox.com says which."],
      ["How much do HYROX spectator tickets cost?", "Typically between about 10 and 25 euros, dollars or pounds per day depending on the city, and often free for young children. Prices are set per event and shown in the official shop."],
      ["Can kids watch HYROX for free?", "Often yes: many events let children under a certain age (commonly under 12 or under 14) in free with a ticketed adult. Check the event page, as the age limit differs by region."],
      ["Can I watch without a spectator ticket?", "Usually not inside the venue. Some events have a free spectator zone or a fan area outside; the finish line and the stations are normally only for ticket holders."],
    ];
    const body = `<div class="hero"><h1>${escapeHtml(title)}</h1><p class="hero-sub">Yes, at the big races they sell out, Saturdays first. For partners, parents and friends who come to cheer: how spectator tickets work and how to get one when they're gone.</p></div>
    <div class="card">
      <h2>Who needs a spectator ticket</h2>
      <p>Everyone who comes to watch and is not racing - some call them supporter or visitor tickets. HYROX races happen indoors in arenas and exhibition halls with limited space, so most events sell a <b>spectator ticket per race day</b> (Friday, Saturday, Sunday...). Athletes don't need one for the day they race; a supporter does.</p>
      <h2>Why they sell out</h2>
      <p>Each athlete brings on average one or two supporters, and Saturday is the busiest day everywhere. At the biggest races the spectator allocation for the popular days goes within days of the athlete tickets. Like every other ticket, spectator tickets <b>come back</b> when people's plans change, usually without any announcement.</p>
      <h2>How to get one when they're sold out</h2>
      <ol><li><b>Watch the exact day.</b> Spectator tickets are per day: watch the day your athlete races, not just the race.</li>
      <li><b>Set a free alert.</b> RoxRaceAlerts checks the official shop around the clock and tells you the moment a spectator ticket for that day is available again. Email and Telegram are free; Priority (${PRIORITY_PRICE_LABEL}, one-off) alerts you first, also on WhatsApp.</li>
      <li><b>Buy fast, on the official shop only.</b> A returned ticket can be gone within the hour. Never pay strangers in Facebook groups.</li></ol>
      <p><a href="/"><button type="button">Set a free spectator-ticket alert</button></a></p>
    </div>
    ${
      spec?.length
        ? `<div class="card"><h2>Spectator tickets being watched right now</h2><p class="hint">Races where supporters are watching spectator tickets on RoxRaceAlerts, and how many of those days are sold out.</p><ul class="status-list">${spec
            .map((r: any) => `<li><span>${escapeHtml(shortRaceName(r.event_name).name)}</span><span>${Number(r.sold) > 0 ? `<span class="event-badge off">${r.sold} of ${r.n} sold out</span>` : `<span class="event-badge on">available</span>`}</span></li>`)
            .join("")}</ul></div>`
        : ""
    }
    <div class="card faq"><h2>Questions</h2>${faq.map(([q, a]) => faqItem(q, a)).join("")}</div>
    <div class="card race-links"><h2>Spectator tickets by race</h2>
      <p class="hint">Races with tickets on sale now. Each page shows whether spectator tickets are available and lets you set an alert.</p>
      ${races
        .filter((e) => e.on_sale && !/youngstars/i.test(e.title))
        .map((e) => `<a href="/hyrox/${e.slug}">HYROX ${escapeHtml(shortRaceName(e.title).city)} spectator tickets</a>`)
        .join("")}
    </div>
    ${ARTICLE_CTA}${otherGuides(slug)}`;
    return page(`${title} | RoxRaceAlerts`, `${nav}${body}`, {}, false, articleSeo(env, `/guides/${slug}`, title, description, faq));
  }

  const r = page("Guide not found", `<div class="card"><p>No such guide. <a href="/guides/sold-out-hyrox-tickets">How to get sold-out HYROX tickets</a></p></div>`);
  return new Response(r.body, { status: 404, headers: r.headers });
}

const GUIDE_TITLES: Record<(typeof GUIDE_SLUGS)[number], string> = {
  "sold-out-hyrox-tickets": "How to get HYROX tickets after they sell out: waitlist, resale & alerts",
  "hyrox-ticket-sale-dates": `HYROX ticket release dates 20${SEASON_LABEL}: when do tickets go on sale?`,
  "hyrox-ticket-types": "HYROX ticket types explained: Open, Pro, Doubles, Relay",
  // 2026-11-10: "do you need one" -> "do they sell out": the page's most-shown search is "do hyrox
  // spectator tickets sell out" (place 7, no clicks). "HYROX spectator tickets" and "sold out" stay.
  "hyrox-spectator-tickets": "HYROX spectator tickets: do they sell out, and what if they're sold out?",
};

// ---------------------------------------------------------------------------
// Supporters: a gym puts our live ticket widget on its website (a plain link to the race page,
// upgraded by widget.js into a small card showing the race's ticket status), and gets a free
// Supporter tile in return - on its city's race page, on the homepage and on /supporters -
// linking to the gym. The widget's data requests carry the gym's page as Referer, which is how
// we see the embed is really there (widget_hits). Supporters never use up the paid partner spots.
// ---------------------------------------------------------------------------
function widgetSnippet(env: Env, slug: string, city: string): string {
  return `<a href="${env.SITE_URL}/hyrox/${slug}" data-rra="${slug}">HYROX ${city} tickets: free alerts</a>\n<script async src="${env.SITE_URL}/widget.js"></script>`;
}

/** The script a gym's page loads: turns every <a data-rra="slug"> into a live card. The link
 * itself stays a normal link (that is what search engines count), the script only dresses it. */
function handleWidgetScript(env: Env): Response {
  const js = `(function(){
  var origin=${JSON.stringify(env.SITE_URL)};
  var els=document.querySelectorAll('a[data-rra]');
  Array.prototype.forEach.call(els,function(a){
    var slug=a.getAttribute('data-rra')||'next';
    fetch(origin+'/widget-data/'+encodeURIComponent(slug)).then(function(r){return r.json()}).then(function(d){
      if(!d||d.error)return;
      a.href=d.url+'?src=widget';a.target='_blank';a.rel='noopener';
      a.style.cssText='display:block;max-width:360px;padding:14px 16px;border:1px solid #e2e2e2;border-radius:12px;background:#fff;color:#1a1a1a;text-decoration:none;font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.35;box-sizing:border-box';
      var badge='<span style="display:inline-block;font-size:12px;padding:2px 9px;border-radius:10px;background:'+(d.cls==='on'?'#e6f4ea':d.cls==='soon'?'#e6eeff':'#f1f1f1')+';color:'+(d.cls==='on'?'#1e7e34':d.cls==='soon'?'#2851b8':'#777')+'">'+d.badge+'</span>';
      a.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:15px">'+d.title+'</b>'+badge+'</div>'
        +(d.line?'<div style="font-size:13px;color:#444;margin-top:6px">'+d.line+'</div>':'')
        +'<div style="font-size:12px;color:#777;margin-top:8px">Free ticket alerts &rarr; roxracealerts.com</div>';
    }).catch(function(){});
  });
})();`;
  return new Response(js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}

const esc = (s: string) => escapeHtml(s);

/** JSON for the widget: one race, or "next" = the soonest announced sale. Counts the embed. */
async function handleWidgetData(req: Request, env: Env, slug: string): Promise<Response> {
  const events = await listDirectoryEvents(env);
  const ev = slug === "next" ? events.find((e) => !e.on_sale && e.presale_live_at) || events.find((e) => e.on_sale) : events.find((e) => e.slug === slug);
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };
  if (!ev) return new Response(JSON.stringify({ error: "unknown race" }), { status: 404, headers });
  // Remember which site shows the widget (its page is the Referer).
  try {
    const ref = req.headers.get("Referer");
    const host = ref ? new URL(ref).hostname.replace(/^www\./, "") : "";
    const own = new URL(env.SITE_URL).hostname.replace(/^www\./, "");
    if (host && host !== own) {
      await env.DB.prepare("INSERT INTO widget_hits (host, slug, day, hits) VALUES (?, ?, ?, 1) ON CONFLICT(host, slug, day) DO UPDATE SET hits = hits + 1")
        .bind(host.slice(0, 120), ev.slug, dayKey())
        .run();
    }
  } catch (e) {
    console.error("widget hit not counted:", e);
  }
  const { city } = shortRaceName(ev.title);
  const year = (ev.event_date || "").slice(0, 4);
  const raceDay = ev.event_date ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ev.event_date}T00:00:00Z`)) : "";
  const data = ev.on_sale
    ? { badge: "On sale now", cls: "on", line: raceDay ? `Race day ${raceDay}` : "" }
    : ev.presale_live_at
      ? { badge: "Sale announced", cls: "soon", line: `Tickets go on sale ${formatInTimezone(ev.presale_live_at, ev.presale_timezone)}` }
      : { badge: "Not on sale yet", cls: "off", line: raceDay ? `Race day ${raceDay}` : "" };
  return new Response(JSON.stringify({ title: esc(`HYROX ${city} ${year}`.trim()), url: `${env.SITE_URL}/hyrox/${ev.slug}`, badge: data.badge, cls: data.cls, line: esc(data.line) }), { headers });
}

/** Active supporters, optionally for one race. */
async function listSupporters(env: Env, slug?: string): Promise<any[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, tagline, location, race_slug FROM sponsors WHERE active = 1 AND kind = 'supporter' ${slug ? "AND race_slug = ?" : ""} ORDER BY sort_order, id LIMIT 30`
  )
    .bind(...(slug ? [slug] : []))
    .all<any>();
  return results || [];
}

function supporterTiles(rows: any[]): string {
  return rows
    .map(
      (s) =>
        `<a class="sponsor" href="/out/${s.id}" target="_blank" rel="noopener"><span class="sp-ico">${escapeHtml(String(s.name).trim().charAt(0).toUpperCase())}</span><span class="sp-body"><b>${escapeHtml(s.name)}</b>${
          s.location ? `<small class="sp-loc">${escapeHtml(s.location)}</small>` : ""
        }${s.tagline ? `<small>${escapeHtml(s.tagline)}</small>` : ""}</span></a>`
    )
    .join("");
}

/** Homepage sidebar card (shown only once there is at least one supporter). */
async function renderSupportersCard(env: Env): Promise<string> {
  const rows = await listSupporters(env);
  if (!rows.length) return "";
  return `<div class="card"><h2>Supporting gyms</h2><div class="sponsors">${supporterTiles(rows.slice(0, 8))}</div><p class="hint"><a href="/supporters">Gym or club? Get your free tile</a></p></div>`;
}

async function handleSupportersPage(req: Request, env: Env, error = "", v: Record<string, string> = {}, status = 200): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  const races = await listDirectoryEvents(env);
  const supporters = await listSupporters(env);
  const pick = v.race || "next";
  const pickedRace = races.find((r) => r.slug === pick);
  const options = [`<option value="next"${pick === "next" ? " selected" : ""}>Next ticket sale (any race)</option>`]
    .concat(races.map((r) => `<option value="${r.slug}"${pick === r.slug ? " selected" : ""}>HYROX ${escapeHtml(shortRaceName(r.title).city)}${r.event_date ? ` (${r.event_date})` : ""}</option>`))
    .join("");
  const snippet = pickedRace ? widgetSnippet(env, pickedRace.slug!, shortRaceName(pickedRace.title).city) : `<a href="${env.SITE_URL}/" data-rra="next">HYROX tickets: free alerts</a>\n<script async src="${env.SITE_URL}/widget.js"></script>`;
  const fieldStyle = "width:100%;padding:10px;font-size:1rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin-top:6px;font-family:inherit";
  const title = "For gyms: free HYROX ticket widget and a Supporter tile";
  const description = "Put live HYROX ticket status on your gym's website (free widget) and get a free Supporter tile on RoxRaceAlerts linking to your gym: on your city's race page and the homepage.";
  const r = page(
    title,
    `${navBar("/", subscriber, 0, !subscriber, env)}
    <div class="hero"><h1>For gyms and clubs: a free ticket widget, and a free tile in return</h1>
      <p class="hero-sub">Your members keep asking when HYROX tickets drop. Put the answer on your website, and we put your gym in front of HYROX athletes.</p></div>
    <div class="card">
      <h2>How it works</h2>
      <ol>
        <li><b>Paste the widget on your website</b> (any page: events, HYROX, community). It shows live ticket status for your city's race and links to free alerts. Two lines of code, no account.</li>
        <li><b>Tell us below.</b> Once we see the widget on your site, your gym gets a <b>Supporter tile</b>: on the HYROX race page of your city, on the RoxRaceAlerts homepage and on this page, each linking to your website.</li>
        <li><b>That's it.</b> No cost, no contract. Athletes looking for a place to train for that race find you; your members never miss a ticket.</li>
      </ol>
      <h2>1. The widget</h2>
      <form method="GET" action="/supporters"><label>Show the race for<select name="race" style="${fieldStyle}" onchange="this.form.submit()">${options}</select></label></form>
      <p>Copy this into your page where you want the box to appear:</p>
      <textarea readonly rows="3" style="${fieldStyle};font-family:monospace;font-size:0.85rem" onclick="this.select()">${escapeHtml(snippet)}</textarea>
      <p class="hint">Preview of what visitors see:</p>
      <div style="padding:12px;background:#f7f7f7;border-radius:8px">${snippet.replace("<script", "<script data-preview").replace(/data-rra/, "data-rra")}</div>
    </div>
    <div class="card">
      <h2>2. Get your Supporter tile</h2>
      ${error ? `<p style="color:#b00"><b>${escapeHtml(error)}</b></p>` : ""}
      <form method="POST" action="/supporters">
        <label>Gym or club name<input type="text" name="name" required maxlength="60" value="${escapeHtml(v.name || "")}"></label>
        <label>Website where the widget is (https://...)<input type="text" name="link" required maxlength="300" value="${escapeHtml(v.link || "")}"></label>
        <label>Your race<select name="race" style="${fieldStyle}">${options.replace('value="next"', 'value=""').replace("Next ticket sale (any race)", "Not tied to one race")}</select></label>
        <label>City and country<input type="text" name="location" maxlength="100" value="${escapeHtml(v.location || "")}" placeholder="e.g. Birmingham, UK"></label>
        <label>One line about your gym (optional, max 80 characters)<input type="text" name="tagline" maxlength="80" value="${escapeHtml(v.tagline || "")}" placeholder="e.g. HYROX prep classes and team training"></label>
        <label>Your email<input type="email" name="email" required maxlength="200" value="${escapeHtml(v.email || "")}"></label>
        <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty <input type="text" name="company_site" tabindex="-1" autocomplete="off"></label></div>
        <p class="consent">We check that the widget is on your site, then switch your tile on and email you. Your email is only used for that.</p>
        <button type="submit">Request my free Supporter tile</button>
      </form>
    </div>
    ${supporters.length ? `<div class="card"><h2>Supporting gyms</h2><div class="sponsors">${supporterTiles(supporters)}</div></div>` : ""}
    <div class="card"><p>Want more than a tile? See the <a href="/partners">partner spots</a>.</p></div>`,
    {},
    false,
    { description, canonical: `${env.SITE_URL}/supporters`, ownH1: true }
  );
  return status === 200 ? r : new Response(r.body, { status, headers: r.headers });
}

/** Stores a supporter request as a partner application (kind 'supporter'); reviewed on /admin/partners. */
async function handleSupportersRequest(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const clip = (x: unknown, n: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  if (clip(form.get("company_site"), 200)) return page("Thanks", `<div class="card"><p>Thanks - we've got your request.</p></div>`);
  const v = { name: clip(form.get("name"), 60), link: clip(form.get("link"), 300), race: clip(form.get("race"), 60), location: clip(form.get("location"), 100), tagline: clip(form.get("tagline"), 80), email: clip(form.get("email"), 200).toLowerCase() };
  const link = normalizePartnerLink(v.link);
  if (!v.name) return handleSupportersPage(req, env, "Please enter your gym or club name.", v, 400);
  if (!link || /instagram\.com/.test(link)) return handleSupportersPage(req, env, "Please enter the website address where the widget is (not an Instagram handle).", v, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return handleSupportersPage(req, env, "Please enter a valid email address.", v, 400);
  const races = await listDirectoryEvents(env);
  const raceSlug = races.some((r) => r.slug === v.race) ? v.race : null;
  const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM partner_applications WHERE created_at >= datetime('now', '-1 day')").first<any>();
  if (Number(today?.n) >= 40) return handleSupportersPage(req, env, "Too many requests today - please try again tomorrow.", v, 429);
  await env.DB.prepare(
    "INSERT INTO partner_applications (name, kind, placement, link, tagline, location, email, message, race_slug) VALUES (?, 'supporter', 'any', ?, ?, ?, ?, '', ?)"
  )
    .bind(v.name, link, v.tagline || null, v.location || null, v.email, raceSlug)
    .run();
  await pingAdmin(env, `🏋️ Supporter request: ${v.name} (${link})${raceSlug ? ` for /hyrox/${raceSlug}` : ""} - review on /admin/partners`);
  return page(
    "Thanks",
    `<div class="card"><p>Thanks! We'll check that the widget is live on <b>${escapeHtml(link)}</b> and switch your Supporter tile on, usually within a day. We'll email <b>${escapeHtml(v.email)}</b>.</p><p><a href="/">Back to RoxRaceAlerts</a></p></div>`
  );
}

async function handleSitemap(env: Env): Promise<Response> {
  const today = todayIso();
  const races = await listDirectoryEvents(env);
  const past = await listPastRaces(env, races);
  const urls = [
    { loc: `${env.SITE_URL}/`, changefreq: "hourly", priority: "1.0" },
    ...races.map((r) => ({ loc: `${env.SITE_URL}/hyrox/${r.slug}`, changefreq: "daily", priority: "0.8" })),
    ...past.map((r) => ({ loc: `${env.SITE_URL}/hyrox/${r.slug}`, changefreq: "weekly", priority: "0.6" })),
    ...[...racesByCountry(races, past).keys()].map((c) => ({ loc: `${env.SITE_URL}/hyrox/${c}`, changefreq: "daily", priority: "0.7" })),
    ...GUIDE_SLUGS.map((s) => ({ loc: `${env.SITE_URL}/guides/${s}`, changefreq: "weekly", priority: "0.7" })),
    { loc: `${env.SITE_URL}/tickets-back`, changefreq: "daily", priority: "0.7" },
    { loc: `${env.SITE_URL}/about`, changefreq: "monthly", priority: "0.5" },
    { loc: `${env.SITE_URL}/supporters`, changefreq: "monthly", priority: "0.5" },
    { loc: `${env.SITE_URL}/partners`, changefreq: "monthly", priority: "0.4" },
    { loc: `${env.SITE_URL}/terms`, changefreq: "yearly", priority: "0.2" },
    { loc: `${env.SITE_URL}/privacy`, changefreq: "yearly", priority: "0.2" },
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join("\n")}
</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

// IndexNow: tells Bing (and DuckDuckGo, Yandex, Naver, which share it) which pages changed, so
// race pages and guides are re-read within hours instead of whenever the crawler returns. The key
// is public by design: search engines verify it by fetching /<key>.txt from this host.
const INDEXNOW_KEY = "8f3c1e7a52b94d06a1c4e9f7b2d8356c";

/** Every URL the sitemap lists. */
async function publicUrls(env: Env): Promise<string[]> {
  const races = await listDirectoryEvents(env);
  const past = await listPastRaces(env, races);
  return [`${env.SITE_URL}/`, ...[...races, ...past].map((r) => `${env.SITE_URL}/hyrox/${r.slug}`), ...[...racesByCountry(races, past).keys()].map((c) => `${env.SITE_URL}/hyrox/${c}`), ...GUIDE_SLUGS.map((s) => `${env.SITE_URL}/guides/${s}`), `${env.SITE_URL}/tickets-back`, `${env.SITE_URL}/about`, `${env.SITE_URL}/supporters`, `${env.SITE_URL}/partners`];
}

/** Submits all public URLs to IndexNow. Production only (the key file must be served on the same
 * host), at most once a day; the API's answer is kept in kv_meta "indexnow_status". */
async function submitIndexNow(env: Env, force = false): Promise<{ status: number; urls: number } | null> {
  const host = new URL(env.SITE_URL).hostname;
  if (!force && host.endsWith("workers.dev")) return null;
  const last = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'indexnow_status'").first<any>();
  if (!force && last?.value) {
    try {
      const prev = JSON.parse(last.value);
      // Daily when the last submission was accepted; hourly retries after a refusal.
      const wait = prev.status >= 200 && prev.status < 300 ? 24 * 3600_000 : 3600_000;
      if (Date.now() - Date.parse(prev.at) < wait) return null;
    } catch {}
  }
  const urlList = await publicUrls(env);
  const body = JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${env.SITE_URL}/${INDEXNOW_KEY}.txt`, urlList });
  // Bing's own endpoint first: api.indexnow.org rate-limits Cloudflare's shared egress addresses
  // (429) while accepting the same request from elsewhere. Either endpoint shares with all engines.
  let status = 0;
  const tried: string[] = [];
  for (const endpoint of ["https://www.bing.com/indexnow", "https://api.indexnow.org/indexnow"]) {
    const resp = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body });
    status = resp.status;
    tried.push(`${new URL(endpoint).hostname}:${status}`);
    if (status >= 200 && status < 300) break;
  }
  const result = { at: new Date().toISOString(), status, urls: urlList.length, tried };
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('indexnow_status', ?)").bind(JSON.stringify(result)).run();
  return { status, urls: urlList.length };
}

// ---------------------------------------------------------------------------
// SEO report (Telegram): every Monday from 09:00 Swiss, Google Search Console + Bing numbers for
// the last 7 days against the 7 before; on other days only a warning when a tracked search drops
// 3+ places. /seo sends the report on demand. Search Console data lags ~3 days, so the week ends
// 3 days ago.
// ---------------------------------------------------------------------------
const SEO_SITE = "roxracealerts.com";
// Last six added 2026-11-10: city ticket searches where RoxRadar sits only at place 7-10 (OpenSEO lookup).
const SEO_TRACKED = [
  "hyrox race alerts", "hyrox alerts", "hyrox ticket alerts", "roxracealerts", "hyrox tickets", "hyrox tickets sold out", "hyrox waitlist", "hyrox ticket release",
  "hyrox nashville tickets", "hyrox nashville 2026 tickets", "hyrox houston 2026 tickets", "hyrox dallas 2026 tickets", "hyrox anaheim 2026 tickets", "hyrox nyc tickets",
];

type GscRow = { keys?: string[]; clicks: number; impressions: number; position: number };
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const SEO_WEEK = () => ({ cur: { start: isoDaysAgo(9), end: isoDaysAgo(3) }, prev: { start: isoDaysAgo(16), end: isoDaysAgo(10) } });

/** OAuth token for the service account in GSC_KEY (signed JWT exchanged at Google). */
async function googleAccessToken(env: Env): Promise<string> {
  const key = JSON.parse(env.GSC_KEY!);
  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const part = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const der = Uint8Array.from(atob(String(key.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const signer = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(unsigned)));
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j: any = await resp.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Google sign-in failed (${resp.status}): ${JSON.stringify(j).slice(0, 150)}`);
  return j.access_token;
}

async function gscQuery(token: string, range: { start: string; end: string }, dimensions: string[], rowLimit = 1000): Promise<GscRow[]> {
  const resp = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(`sc-domain:${SEO_SITE}`)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions, rowLimit }),
  });
  const j: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Search Console ${resp.status}: ${String(j?.error?.message || "").slice(0, 150)}`);
  return j.rows || [];
}

/** Queries of this week and the week before, keyed by query. */
async function gscWeeks(token: string) {
  const { cur, prev } = SEO_WEEK();
  const [now, before] = await Promise.all([gscQuery(token, cur, ["query"]), gscQuery(token, prev, ["query"])]);
  const map = (rows: GscRow[]) => new Map(rows.map((r) => [String(r.keys?.[0] || "").toLowerCase(), r]));
  return { cur, prev, now: map(now), before: map(before) };
}

const place = (p: number) => p.toFixed(1);
/** Arrow for a position change (a lower number is better). */
const moved = (now: number, before?: number) =>
  before === undefined ? " (new)" : Math.abs(now - before) < 0.5 ? " (=)" : now < before ? ` (↑ from ${place(before)})` : ` (↓ from ${place(before)})`;

/** Tracked searches that fell 3+ places, or were seen last week and not this week. */
function trackedDrops(w: { now: Map<string, GscRow>; before: Map<string, GscRow> }): string[] {
  const out: string[] = [];
  for (const q of SEO_TRACKED) {
    const a = w.now.get(q);
    const b = w.before.get(q);
    if (!b) continue;
    if (!a && b.impressions >= 3) out.push(`${q}: was place ${place(b.position)}, not shown this week`);
    else if (a && a.position - b.position >= 3) out.push(`${q}: place ${place(a.position)}, was ${place(b.position)}`);
  }
  return out;
}

async function seoReport(env: Env): Promise<string> {
  const lines: string[] = [];
  if (!env.GSC_KEY) lines.push("Google: not connected.");
  else {
    try {
      const token = await googleAccessToken(env);
      const w = await gscWeeks(token);
      const [[t], [tb], pages] = await Promise.all([
        gscQuery(token, w.cur, []),
        gscQuery(token, w.prev, []),
        gscQuery(token, w.cur, ["page"], 5),
      ]);
      const diff = (a = 0, b = 0) => `${a - b >= 0 ? "+" : ""}${a - b}`;
      lines.push(`🔎 Google, ${dayLabel(w.cur.start)} – ${dayLabel(w.cur.end)}`);
      lines.push(`Clicks: ${t?.clicks ?? 0} (${diff(t?.clicks, tb?.clicks)}) · shown: ${t?.impressions ?? 0} (${diff(t?.impressions, tb?.impressions)}) · average place: ${t ? place(t.position) : "-"}${t ? moved(t.position, tb?.position) : ""}`);
      lines.push("", "Searches we track:");
      for (const q of SEO_TRACKED) {
        const r = w.now.get(q);
        lines.push(r ? `• ${q}: place ${place(r.position)}${moved(r.position, w.before.get(q)?.position)} · shown ${r.impressions} · clicks ${r.clicks}` : `• ${q}: not shown`);
      }
      const top = [...w.now.entries()].sort((a, b) => b[1].impressions - a[1].impressions);
      lines.push("", "Most shown for:");
      for (const [q, r] of top.slice(0, 8)) lines.push(`• ${q}: place ${place(r.position)}${moved(r.position, w.before.get(q)?.position)} · shown ${r.impressions} · clicks ${r.clicks}`);
      if (!top.length) lines.push("• nothing yet");
      const fresh = top.filter(([q]) => !w.before.has(q) && !SEO_TRACKED.includes(q)).slice(0, 5);
      if (fresh.length) {
        lines.push("", "New searches finding us (ideas for pages/wording):");
        for (const [q, r] of fresh) lines.push(`• ${q}: place ${place(r.position)} · shown ${r.impressions}`);
      }
      const drops = [...w.now.entries()]
        .filter(([q, r]) => (w.before.get(q)?.impressions ?? 0) >= 5 && r.impressions >= 5 && r.position - w.before.get(q)!.position >= 3)
        .map(([q, r]) => `• ${q}: place ${place(r.position)}, was ${place(w.before.get(q)!.position)}`);
      if (drops.length) lines.push("", "⚠️ Dropped 3+ places:", ...drops.slice(0, 5));
      if (pages.length) {
        lines.push("", "Top pages:");
        for (const p of pages) lines.push(`• ${String(p.keys?.[0] || "").replace(/^https?:\/\/[^/]+/, "") || "/"}: clicks ${p.clicks} · shown ${p.impressions}`);
      }
    } catch (e) {
      lines.push(`Google: couldn't read the data - ${String((e as Error)?.message || e)}`);
    }
  }
  lines.push("", await bingSummary(env));
  return lines.join("\n").slice(0, 4000);
}

/** Bing Webmaster Tools, for the report. Bing often refuses calls from Cloudflare's shared
 * addresses ("ThrottleIP"), so a good answer is kept (kv_meta bing_summary) and used when Bing
 * says no; runSeoChecks keeps trying hourly until it has one for the day. */
async function bingSummary(env: Env): Promise<string> {
  if (!env.BING_API_KEY) return "Bing: not connected.";
  const live = await bingFetch(env);
  if (live.ok) return live.text;
  const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'bing_summary'").first<any>();
  const kept = row?.value ? JSON.parse(row.value) : null;
  if (kept?.text) return `${kept.text}\n(Bing figures from ${kept.at}; Bing was busy just now)`;
  return `Bing: busy right now (${truncate(live.text, 120)}). Bing limits the shared servers we run on; we retry every hour, so a later report will have it.`;
}

/** Tries Bing at most once an hour until today's figures are kept. */
async function refreshBing(env: Env, date: string): Promise<void> {
  if (!env.BING_API_KEY) return;
  const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'bing_summary'").first<any>();
  if (row?.value && JSON.parse(row.value).at === date) return;
  const tried = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'bing_try'").first<any>();
  if (tried?.value && Date.now() - Number(tried.value) < 3600_000) return;
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('bing_try', ?)").bind(String(Date.now())).run();
  await bingFetch(env);
}

/** Searches of the last 7 days (Bing keeps them per week). A good answer is also kept for the report. */
async function bingFetch(env: Env): Promise<{ ok: boolean; text: string }> {
  const r = await bingQuery(env);
  if (r.ok) {
    await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('bing_summary', ?)")
      .bind(JSON.stringify({ at: swissNow().date, text: r.text }))
      .run();
  }
  return r;
}

async function bingQuery(env: Env): Promise<{ ok: boolean; text: string }> {
  if (!env.BING_API_KEY) return { ok: false, text: "not connected" };
  try {
    // The key is trimmed: a saved key file can carry a trailing newline/space, which Bing rejects with a 400.
    const resp = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(`https://${SEO_SITE}/`)}&apikey=${encodeURIComponent(env.BING_API_KEY.trim())}`);
    const raw = await resp.text();
    let j: any = null;
    try { j = JSON.parse(raw); } catch {}
    if (!resp.ok || !Array.isArray(j?.d)) return { ok: false, text: `${resp.status}${j?.Message ? ` ${j.Message}` : raw ? `: ${truncate(raw.replace(/\s+/g, " "), 100)}` : ""}` };
    const since = Date.now() - 8 * 86400_000;
    const byQuery = new Map<string, { shown: number; clicks: number }>();
    for (const r of j.d) {
      const at = Number(/\d+/.exec(String(r.Date))?.[0]);
      if (!(at >= since)) continue;
      const q = String(r.Query || "").toLowerCase();
      const cur = byQuery.get(q) || { shown: 0, clicks: 0 };
      cur.shown += Number(r.Impressions) || 0;
      cur.clicks += Number(r.Clicks) || 0;
      byQuery.set(q, cur);
    }
    const rows = [...byQuery.entries()].sort((a, b) => b[1].shown - a[1].shown);
    if (!rows.length) return { ok: true, text: "🅱️ Bing: no searches showed us this week yet." };
    const sum = rows.reduce((s, [, r]) => ({ shown: s.shown + r.shown, clicks: s.clicks + r.clicks }), { shown: 0, clicks: 0 });
    return { ok: true, text: [`🅱️ Bing: clicks ${sum.clicks} · shown ${sum.shown}`, ...rows.slice(0, 5).map(([q, r]) => `• ${q}: shown ${r.shown} · clicks ${r.clicks}`)].join("\n") };
  } catch (e) {
    return { ok: false, text: String((e as Error)?.message || e) };
  }
}

/** Part of the frequent checks: the Monday report, and a daily look for drops on tracked searches
 * (each drop is reported at most once a week). Once a day from 09:00 Swiss. */
async function runSeoChecks(env: Env): Promise<void> {
  if (!env.GSC_KEY || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const { date, weekday, hour } = swissNow();
  if (hour < 9) return;
  try {
    await refreshBing(env, date);
  } catch (e) {
    console.error("Bing refresh failed:", e);
  }
  const last = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'seo_check'").first<any>();
  if (last?.value === date) return;
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('seo_check', ?)").bind(date).run();
  if (weekday === 1) {
    await sendTelegram(env, await seoReport(env));
    return;
  }
  try {
    const drops = trackedDrops(await gscWeeks(await googleAccessToken(env)));
    const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'seo_drop_alerted'").first<any>();
    const alerted: Record<string, string> = row?.value ? JSON.parse(row.value) : {};
    const weekAgo = isoDaysAgo(7);
    const fresh = drops.filter((d) => !(alerted[d.split(":")[0]] > weekAgo));
    if (!fresh.length) return;
    for (const d of fresh) alerted[d.split(":")[0]] = date;
    await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('seo_drop_alerted', ?)").bind(JSON.stringify(alerted)).run();
    await sendTelegram(env, ["⚠️ Google: a search we track dropped", ...fresh.map((d) => `• ${d}`), "", "/seo shows the full report."].join("\n"));
  } catch (e) {
    console.error("SEO drop check failed:", e);
  }
}

/** Keeps personal pages (sign-in links, alert management) out of search results. Cloudflare may
 * prepend its own content-signal lines to this file. */
function handleRobots(env: Env): Response {
  const body = ["User-agent: *", "Allow: /", "Disallow: /admin/", "Disallow: /my-alerts", "Disallow: /verify", "Disallow: /unsubscribe", "Disallow: /watching", "", `Sitemap: ${env.SITE_URL}/sitemap.xml`, ""].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

async function handleFeedbackPage(req: Request, env: Env): Promise<Response> {
  const subscriber = await getSessionSubscriber(req, env);
  return page(
    "Feedback",
    `${navBar("/", subscriber, 0, !subscriber, env)}
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
  await pingAdmin(env, `💬 Feedback${email ? ` from ${email}` : ""}:\n${message.slice(0, 500)}`);

  if (env.ADMIN_EMAIL) {
    try {
      await sendEmail(
        env,
        env.ADMIN_EMAIL,
        "New RoxRaceAlerts feedback",
        `<p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>${email ? `<p>From: ${escapeHtml(email)}</p>` : ""}`,
        `${message}${email ? `\n\nFrom: ${email}` : ""}`
      );
      await notifyAdminTelegram(env, env.ADMIN_EMAIL, `💬 New feedback: ${message}${email ? `\nFrom: ${email}` : ""}`);
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

  return page(
    "Feedback inbox",
    `${adminNav(token, "feedback")}${rows || `<div class="card"><p>Nothing yet.</p></div>`}`,
    { "cache-control": "private, no-store" }
  );
}

async function handleFeedbackDismiss(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") || "");
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const id = String(form.get("id") || "");
  await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
  return Response.redirect(`${env.SITE_URL}/admin/feedback?token=${encodeURIComponent(token)}`, 303);
}

/** Every /admin/* page was a dead-end reachable only by its own direct
 * link, with no way to discover the others - the homepage's "Admin" link
 * goes straight to /admin/subscribers, so /admin/feedback and
 * /admin/ig-posts were invisible unless you already knew the URL. This bar
 * fixes that by linking all three from wherever you land. */
type AdminPage = "subscribers" | "analytics" | "partners" | "feedback" | "ig-posts";
function adminNav(token: string, current: AdminPage): string {
  const t = encodeURIComponent(token);
  const link = (page: AdminPage, label: string) =>
    page === current ? `<b>${label}</b>` : `<a href="/admin/${page}?token=${t}">${label}</a>`;
  return `<p><small><a href="/">Home</a> &middot; ${link("subscribers", "Subscribers")} &middot; ${link("analytics", "Analytics")} &middot; ${link("partners", "Partners")} &middot; ${link("feedback", "Feedback")} &middot; ${link("ig-posts", "IG Posts")}</small></p>`;
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
    `SELECT s.id, s.email, s.verified, s.created_at, s.whatsapp_phone, s.whatsapp_waitlist_phone, s.whatsapp_marketing_ok, (s.telegram_chat_id IS NOT NULL) AS on_telegram,
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

  // Two bulk queries (not one per subscriber) to build the "what are they
  // actually watching" detail shown inside each row's <details> toggle.
  const { results: ticketRows } = await env.DB.prepare(
    "SELECT subscriber_id, event_name, ticket_name, purchased_at FROM subscriptions ORDER BY event_name, ticket_name"
  ).all<any>();
  const { results: watchRows } = await env.DB.prepare(
    `SELECT w.subscriber_id, sw.event_title, sw.resolved FROM sale_watchers w
     JOIN sale_watch sw ON sw.event_url = w.event_url
     ORDER BY sw.event_title`
  ).all<any>();

  const ticketsBySubscriber = new Map<number, any[]>();
  for (const t of ticketRows || []) {
    if (!ticketsBySubscriber.has(t.subscriber_id)) ticketsBySubscriber.set(t.subscriber_id, []);
    ticketsBySubscriber.get(t.subscriber_id)!.push(t);
  }
  const watchesBySubscriber = new Map<number, any[]>();
  for (const w of watchRows || []) {
    if (!watchesBySubscriber.has(w.subscriber_id)) watchesBySubscriber.set(w.subscriber_id, []);
    watchesBySubscriber.get(w.subscriber_id)!.push(w);
  }

  const rowsHtml = rows
    .map((r: any) => {
      const items = [
        ...(ticketsBySubscriber.get(r.id) || []).map(
          (t: any) => `<li>${escapeHtml(t.event_name)} &mdash; ${escapeHtml(t.ticket_name)}${t.purchased_at ? " <small>(bought)</small>" : ""}</li>`
        ),
        ...(watchesBySubscriber.get(r.id) || []).map(
          (w: any) => `<li>${escapeHtml(w.event_title)} <small>(race watch${w.resolved ? ", on sale" : ""})</small></li>`
        ),
      ].join("");
      // Digits only in the database; shown with a + so it reads as an international number.
      const wa =
        (r.whatsapp_phone
          ? ` <small>&middot; WhatsApp +${escapeHtml(r.whatsapp_phone)}</small>`
          : r.whatsapp_waitlist_phone
            ? ` <small>&middot; WhatsApp waitlist +${escapeHtml(r.whatsapp_waitlist_phone)}${r.whatsapp_marketing_ok ? " (news OK)" : ""}</small>`
            : "") + (r.on_telegram ? " <small>&middot; Telegram</small>" : "");
      return `<details class="subscriber-row">
        <summary>${escapeHtml(r.email)}${wa} ${r.verified ? "" : '<small>(unverified)</small>'} &mdash; ${r.ticket_count} ticket(s), ${r.watch_count} race(s), ${r.bought_count} bought &middot; <small>${escapeHtml(r.created_at)}</small></summary>
        <ul>${items || "<li><small>Nothing watched.</small></li>"}</ul>
      </details>`;
    })
    .join("");

  return page(
    "Subscribers",
    `${adminNav(token, "subscribers")}
    <div class="card">
      <h2>Subscribers (${rows.length}${rows.some((r: any) => r.whatsapp_phone) ? `, ${rows.filter((r: any) => r.whatsapp_phone).length} on WhatsApp` : ""}${rows.some((r: any) => r.whatsapp_waitlist_phone) ? `, ${rows.filter((r: any) => r.whatsapp_waitlist_phone).length} on the WhatsApp waitlist` : ""})</h2>
      <p><small>${totalBought} of ${totalTickets} watched ticket(s) marked as bought overall. Click a subscriber to see what they're watching.</small></p>
      ${rowsHtml || "<p>Nobody yet.</p>"}
    </div>`,
    { "cache-control": "private, no-store" }
  );
}

/** Which feature people actually use: "race watch" (sale_watch/sale_watchers -
 * be told when a not-yet-on-sale race opens) vs "ticket watch" (subscriptions
 * - be told when a specific sold-out ticket type comes back). Built purely
 * from rows that already exist, verified subscribers only, so it's a
 * snapshot of what people are watching *now*, not a history: removing a
 * watch, marking a race watch as bought, or unsubscribing deletes the row,
 * and nothing records email opens/clicks. Treat "bought" as the one real
 * value signal available. */
async function handleAnalyticsAdminPage(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

  const db = env.DB;
  const [counts, usage, ticketStats, raceStats, firstFeat, recent, topRaceW, topRaceT, ticketRows, weekly] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(verified), 0) AS verified FROM subscribers").first<any>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN t > 0 THEN 1 ELSE 0 END), 0) AS with_ticket,
           COALESCE(SUM(CASE WHEN r > 0 THEN 1 ELSE 0 END), 0) AS with_race,
           COALESCE(SUM(CASE WHEN t > 0 AND r > 0 THEN 1 ELSE 0 END), 0) AS both_feat,
           COALESCE(SUM(CASE WHEN t = 0 AND r = 0 THEN 1 ELSE 0 END), 0) AS neither
         FROM (SELECT (SELECT COUNT(*) FROM subscriptions WHERE subscriber_id = s.id) AS t,
                      (SELECT COUNT(*) FROM sale_watchers WHERE subscriber_id = s.id) AS r
               FROM subscribers s WHERE s.verified = 1)`
      )
      .first<any>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(sub.purchased_at) AS bought
         FROM subscriptions sub JOIN subscribers s ON s.id = sub.subscriber_id WHERE s.verified = 1`
      )
      .first<any>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(sw.resolved), 0) AS live
         FROM sale_watchers w JOIN sale_watch sw ON sw.event_url = w.event_url
         JOIN subscribers s ON s.id = w.subscriber_id WHERE s.verified = 1`
      )
      .first<any>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN tmin IS NOT NULL AND (rmin IS NULL OR tmin <= rmin) THEN 1 ELSE 0 END), 0) AS ticket_first,
           COALESCE(SUM(CASE WHEN rmin IS NOT NULL AND (tmin IS NULL OR rmin < tmin) THEN 1 ELSE 0 END), 0) AS race_first
         FROM (SELECT (SELECT MIN(created_at) FROM subscriptions WHERE subscriber_id = s.id) AS tmin,
                      (SELECT MIN(created_at) FROM sale_watchers WHERE subscriber_id = s.id) AS rmin
               FROM subscribers s WHERE s.verified = 1)`
      )
      .first<any>(),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sale_watchers WHERE created_at >= datetime('now', '-7 days')) AS race7,
           (SELECT COUNT(*) FROM sale_watchers WHERE created_at >= datetime('now', '-30 days')) AS race30,
           (SELECT COUNT(*) FROM subscriptions WHERE created_at >= datetime('now', '-7 days')) AS ticket7,
           (SELECT COUNT(*) FROM subscriptions WHERE created_at >= datetime('now', '-30 days')) AS ticket30`
      )
      .first<any>(),
    db
      .prepare(
        `SELECT sw.event_title AS name, COUNT(DISTINCT w.subscriber_id) AS people
         FROM sale_watchers w JOIN sale_watch sw ON sw.event_url = w.event_url
         JOIN subscribers s ON s.id = w.subscriber_id AND s.verified = 1
         GROUP BY sw.event_url ORDER BY people DESC, name LIMIT 10`
      )
      .all<any>(),
    db
      .prepare(
        `SELECT sub.event_name AS name, COUNT(DISTINCT sub.subscriber_id) AS people
         FROM subscriptions sub JOIN subscribers s ON s.id = sub.subscriber_id AND s.verified = 1
         GROUP BY sub.event_name ORDER BY people DESC, name LIMIT 10`
      )
      .all<any>(),
    db
      .prepare(
        `SELECT sub.ticket_name, sub.subscriber_id FROM subscriptions sub
         JOIN subscribers s ON s.id = sub.subscriber_id AND s.verified = 1`
      )
      .all<any>(),
    db
      .prepare(
        `SELECT date(created_at, 'weekday 0', '-6 days') AS wk, COUNT(*) AS signups, COALESCE(SUM(verified), 0) AS verified
         FROM subscribers GROUP BY wk ORDER BY wk DESC LIMIT 8`
      )
      .all<any>(),
  ]);

  // Email delivery log (email_log): "Resend accepted it", not inbox delivery.
  const emailQ = (new URL(req.url).searchParams.get("email") || "").trim().toLowerCase();
  const transactional =
    "subject NOT LIKE 'Confirm your RoxRaceAlerts%' AND subject NOT LIKE 'You''re not getting alerts%' AND subject NOT LIKE 'Your RoxRaceAlerts sign-in%' AND subject NOT LIKE 'New RoxRaceAlerts feedback' AND subject NOT LIKE '% new HYROX Instagram post(s) published'";
  const [mailStats, mailRecent, mailFailed, mailLookup] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok, (SELECT MIN(created_at) FROM email_log) AS since
         FROM email_log WHERE created_at >= datetime('now', '-7 days')`
      )
      .first<any>(),
    db
      .prepare(`SELECT to_address, subject, ok, created_at FROM email_log WHERE ${transactional} ORDER BY id DESC LIMIT 30`)
      .all<any>(),
    db
      .prepare("SELECT to_address, subject, error, created_at FROM email_log WHERE ok = 0 ORDER BY id DESC LIMIT 15")
      .all<any>(),
    emailQ
      ? db
          .prepare("SELECT subject, ok, error, created_at FROM email_log WHERE lower(to_address) = ? ORDER BY id DESC LIMIT 50")
          .bind(emailQ)
          .all<any>()
      : Promise.resolve({ results: [] as any[] }),
  ]);
  const mailRow = (r: any) =>
    `<div class="arow"><span>${r.ok ? "&#10003;" : "&#10007;"} ${escapeHtml(r.subject)}${r.to_address ? ` <small>&rarr; ${escapeHtml(r.to_address)}</small>` : ""}${r.error ? `<br><small>${escapeHtml(r.error)}</small>` : ""}</span><small>${escapeHtml(r.created_at)}</small></div>`;
  const mailCardHtml = () => `<div class="card">
      <h2>Email delivery</h2>
      <p><small>Logged since ${escapeHtml(mailStats?.since || "now")}. &#10003; = Resend accepted the email. That is the most the app can see - bounces, spam-folder placement and opens only show in Resend's dashboard (resend.com/emails). Alerts to other people are not mirrored to your Telegram; only ones addressed to your own email are.</small></p>
      <div class="tiles">
        ${tile(mailStats?.total || 0, "emails, last 7 days")}
        ${tile(mailStats?.ok || 0, "accepted by Resend")}
        ${tile((mailStats?.total || 0) - (mailStats?.ok || 0), "failed to send")}
      </div>
      <form method="GET" action="/admin/analytics" style="margin-top:14px">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <div class="row"><input type="text" name="email" placeholder="Look up one person's emails (e.g. name@gmail.com)" value="${escapeHtml(emailQ)}"><button type="submit">Look up</button></div>
      </form>
      ${
        emailQ
          ? `<h2 style="margin-top:16px">Emails to ${escapeHtml(emailQ)}</h2>${
              (mailLookup.results || []).length
                ? (mailLookup.results || []).map(mailRow).join("")
                : "<p><small>Nothing logged for that address (logging only started recently, so older emails won't appear).</small></p>"
            }`
          : ""
      }
      <h2 style="margin-top:16px">Latest alert emails</h2>
      ${(mailRecent.results || []).length ? (mailRecent.results || []).map(mailRow).join("") : "<p><small>None logged yet.</small></p>"}
      <h2 style="margin-top:16px">Failed sends</h2>
      ${(mailFailed.results || []).length ? (mailFailed.results || []).map(mailRow).join("") : "<p><small>None.</small></p>"}
    </div>`;

  // Sponsor tiles (sponsors / sponsor_stats): the last 30 days per tile.
  const sponsorRows = await db
    .prepare(
      `SELECT p.id, p.name, p.kind, p.active, COALESCE(SUM(st.impressions), 0) AS imp, COALESCE(SUM(st.clicks), 0) AS clk
       FROM sponsors p LEFT JOIN sponsor_stats st ON st.sponsor_id = p.id AND st.day >= date('now', '-30 days')
       WHERE p.is_example = 0
       GROUP BY p.id ORDER BY p.active DESC, clk DESC, p.name`
    )
    .all<any>();
  const sponsorCard = `<div class="card">
      <h2>Gyms &amp; partners (homepage sidebar)</h2>
      <p><small>Last 30 days. A view is counted each time the homepage loads with the tile showing (bots filtered out roughly, so treat it as approximate); a click is a visitor opening the tile's link. To add, pause or edit a tile, tell Claude the name, link, one-line tagline and logo URL.</small></p>
      ${
        (sponsorRows.results || []).length
          ? (sponsorRows.results || [])
              .map(
                (p: any) =>
                  `<div class="arow"><span><b>${escapeHtml(p.name)}</b> <small>${escapeHtml(p.kind)}${p.active ? "" : " &middot; paused"}</small><br><small>${p.imp} views &middot; ${p.clk} clicks &middot; ${p.imp ? ((p.clk / p.imp) * 100).toFixed(1) : "0.0"}% click rate</small></span><b>${p.clk}</b></div>`
              )
              .join("")
          : "<p><small>No tiles yet.</small></p>"
      }
    </div>`;

  // WhatsApp (whatsapp_log + subscribers.whatsapp_phone): usage and setup state.
  const [waLinked, waStats] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE whatsapp_phone IS NOT NULL").first<any>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS accepted,
           COALESCE(SUM(delivery_status IN ('delivered', 'read')), 0) AS delivered,
           COALESCE(SUM(delivery_status = 'failed' OR ok = 0), 0) AS failed
         FROM whatsapp_log WHERE template IN (?, ?) AND created_at >= datetime('now', '-7 days')`
      )
      .bind(WHATSAPP_ALERT_TEMPLATE, WHATSAPP_ALERT_TEXT_LABEL)
      .first<any>(),
  ]);
  const flag = (ok: boolean) => (ok ? "&#10003;" : "&#10007;");
  const waCardHtml = () => `<div class="card">
      <h2>WhatsApp</h2>
      <p><small>Alerts go to subscribers who linked their phone on My alerts. "Accepted" means Meta took the message; "delivered" comes from Meta's delivery receipts, which need the webhook below.</small></p>
      <div class="tiles">
        ${tile(waLinked?.n || 0, "subscribers linked")}
        ${tile(waStats?.total || 0, "alerts sent, last 7 days")}
        ${tile(waStats?.accepted || 0, "accepted by Meta")}
        ${tile(waStats?.delivered || 0, "delivered or read")}
        ${tile(waStats?.failed || 0, "failed")}
      </div>
      <p><small>Setup: token ${flag(!!env.WHATSAPP_TOKEN)} &middot; app secret ${flag(!!env.WHATSAPP_APP_SECRET)} &middot; verify token ${flag(!!env.WHATSAPP_VERIFY_TOKEN)} &middot; app id ${flag(!!env.WHATSAPP_APP_ID)}</small></p>
      <form method="POST" action="/admin/whatsapp/test-alert" style="display:inline-block;margin-right:8px">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit">Send me a test alert on WhatsApp</button>
      </form>
      <form method="POST" action="/admin/whatsapp/register-webhook" style="display:inline-block">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit">Register the webhook with Meta</button>
      </form>
    </div>`;

  const verified = counts?.verified || 0;
  const total = counts?.total || 0;
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "0%");
  const bar = (n: number, max: number) =>
    `<div class="bar"><span style="width:${max > 0 ? Math.round((n / max) * 100) : 0}%"></span></div>`;
  const listRows = (rows: { name: string; n: number }[], emptyMsg: string) => {
    if (!rows.length) return `<p><small>${emptyMsg}</small></p>`;
    const max = Math.max(...rows.map((r) => r.n));
    return rows
      .map((r) => `<div class="arow"><span>${escapeHtml(r.name)}</span><b>${r.n}</b>${bar(r.n, max)}</div>`)
      .join("");
  };
  const tile = (value: string | number, label: string) => `<div class="tile"><b>${value}</b><small>${label}</small></div>`;
  const prio = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM race_priority WHERE livemode = 1) AS race_n,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM race_priority WHERE livemode = 1) AS race_c,
              (SELECT COUNT(*) FROM season_pass WHERE livemode = 1) AS season_n,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM season_pass WHERE livemode = 1) AS season_c,
              (SELECT COUNT(*) FROM ticket_priority WHERE livemode = 1) AS ticket_n,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM ticket_priority WHERE livemode = 1) AS ticket_c,
              (SELECT COALESCE(SUM(wants_whatsapp), 0) FROM race_priority WHERE livemode = 1)
                + (SELECT COALESCE(SUM(wants_whatsapp), 0) FROM ticket_priority WHERE livemode = 1)
                + (SELECT COALESCE(SUM(wants_whatsapp), 0) FROM season_pass WHERE livemode = 1) AS wa_yes,
              (SELECT COUNT(*) FROM subscribers WHERE whatsapp_waitlist_phone IS NOT NULL) AS wa_list,
              (SELECT COUNT(*) FROM race_priority WHERE livemode = 0) + (SELECT COUNT(*) FROM season_pass WHERE livemode = 0)
                + (SELECT COUNT(*) FROM ticket_priority WHERE livemode = 0) AS test_n`
    )
    .first<any>();
  // One row per real purchase, to spot patterns (which races, how soon after sign-up, how they found us).
  const buyers = await db
    .prepare(
      `SELECT p.kind, p.what, p.amount_cents, p.currency, p.wants_whatsapp, p.created_at,
              s.created_at AS joined, s.source, s.referred_by IS NOT NULL AS referred,
              (SELECT COUNT(*) FROM subscriptions w WHERE w.subscriber_id = p.subscriber_id) AS ticket_watches,
              (SELECT group_concat(t, ', ') FROM (SELECT DISTINCT trim(replace(replace(w.ticket_name, 'HYROX ', ''), ' | ', ' |')) AS t FROM subscriptions w
                 WHERE w.subscriber_id = p.subscriber_id AND (p.kind <> 'Ticket' OR w.event_name = p.what) LIMIT 4)) AS tickets,
              (SELECT COUNT(*) FROM sale_watchers sw WHERE sw.subscriber_id = p.subscriber_id) AS race_watches,
              (SELECT COUNT(*) FROM race_priority x WHERE x.subscriber_id = p.subscriber_id AND x.livemode = 1)
                + (SELECT COUNT(*) FROM ticket_priority x WHERE x.subscriber_id = p.subscriber_id AND x.livemode = 1)
                + (SELECT COUNT(*) FROM season_pass x WHERE x.subscriber_id = p.subscriber_id AND x.livemode = 1) AS buys
       FROM (SELECT 'Race' AS kind, event_title AS what, subscriber_id, amount_cents, currency, wants_whatsapp, created_at FROM race_priority WHERE livemode = 1
             UNION ALL SELECT 'Ticket', event_name, subscriber_id, amount_cents, currency, wants_whatsapp, created_at FROM ticket_priority WHERE livemode = 1
             UNION ALL SELECT 'Season', season, subscriber_id, amount_cents, currency, wants_whatsapp, created_at FROM season_pass WHERE livemode = 1) p
       JOIN subscribers s ON s.id = p.subscriber_id
       ORDER BY p.created_at DESC LIMIT 50`
    )
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b.replace(" ", "T")}Z`) - Date.parse(`${a.replace(" ", "T")}Z`)) / 86400_000));
  const buyersHtml = (buyers.results || []).length
    ? `<h3>Each purchase</h3><div style="overflow-x:auto"><table class="admin-table" style="width:100%;font-size:0.85rem;border-collapse:collapse">
        <tr><th align="left">Bought</th><th align="left">What</th><th align="left">Paid</th><th align="left">Signed up</th><th align="left">Came from</th><th align="left">Watches</th><th align="left">WhatsApp</th></tr>
        ${(buyers.results || [])
          .map(
            (b: any) => `<tr style="border-top:1px solid #eee">
          <td>${escapeHtml(String(b.created_at).slice(0, 10))}</td>
          <td>${escapeHtml(b.kind)}: ${escapeHtml(b.what)}${b.buys > 1 ? ` <small>(${b.buys} buys)</small>` : ""}${b.tickets ? `<br><small>${escapeHtml(b.tickets)}</small>` : ""}</td>
          <td>${money(b.amount_cents)} ${escapeHtml(String(b.currency).toUpperCase())}</td>
          <td>${(() => { const d = daysBetween(b.joined, b.created_at); return d === 0 ? "same day" : `${d} days before`; })()}</td>
          <td>${escapeHtml(b.source || (b.referred ? "friend's link" : "-"))}</td>
          <td>${b.ticket_watches} ticket(s), ${b.race_watches} race(s)</td>
          <td>${b.wants_whatsapp ? "yes" : "-"}</td></tr>`
          )
          .join("")}</table></div>`
    : "";
  const prioCardHtml = () => `<div class="card">
      <h2>Priority sales</h2>
      <p><small>Which offer people pick: one race or ticket watch (${PRIORITY_PRICE_LABEL}) or the whole season (${SEASON_PRICE_LABEL}), and how many want WhatsApp. Real payments only; ${prio?.test_n || 0} test-mode purchase(s) not counted.</small></p>
      <div class="tiles">
        ${tile(prio?.race_n || 0, "race passes")}
        ${tile(prio?.ticket_n || 0, "ticket passes")}
        ${tile(prio?.season_n || 0, "season passes")}
        ${tile(money((prio?.race_c || 0) + (prio?.ticket_c || 0) + (prio?.season_c || 0)), "revenue (before Stripe fees)")}
        ${tile(prio?.wa_yes || 0, "buyers who want WhatsApp")}
        ${tile(prio?.wa_list || 0, "numbers on the WhatsApp waitlist")}
      </div>
      ${buyersHtml}
    </div>`;

  // Collapse "HYROX PRO MEN | Friday" / "... | Saturday" into one ticket type
  // so a division isn't split across race days.
  const typePeople = new Map<string, Set<number>>();
  for (const r of ticketRows.results || []) {
    const type = String(r.ticket_name)
      .replace(/\s*\|\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!typePeople.has(type)) typePeople.set(type, new Set());
    typePeople.get(type)!.add(r.subscriber_id);
  }
  const topTypes = [...typePeople.entries()]
    .map(([name, set]) => ({ name, n: set.size }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 10);

  const weeklyRows = weekly.results || [];
  const weeklyMax = Math.max(0, ...weeklyRows.map((r: any) => r.signups));

  const raceUsers = usage?.with_race || 0;
  const ticketUsers = usage?.with_ticket || 0;
  const mostUsed =
    raceUsers === ticketUsers
      ? "Race watch and ticket watch are used by the same number of people."
      : raceUsers > ticketUsers
        ? `Race watch is the more used feature: ${raceUsers} people vs ${ticketUsers} for ticket watch.`
        : `Ticket watch is the more used feature: ${ticketUsers} people vs ${raceUsers} for race watch.`;

  const style = `<style>
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:12px}
    .tile{background:#f7f7f7;border-radius:8px;padding:12px}
    .tile b{display:block;font-size:1.5rem}
    .tile small{display:block;margin-top:2px}
    .arow{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:7px 0;border-bottom:1px solid #eee;font-size:0.9rem}
    .arow:last-child{border-bottom:0}
    .bar{grid-column:1/-1;height:6px;background:#eee;border-radius:3px}
    .bar span{display:block;height:100%;background:#ff6a00;border-radius:3px}
  </style>`;

  return page(
    "Analytics",
    `${style}${adminNav(token, "analytics")}
    <div class="card">
      <h2>What people use most</h2>
      <p>${escapeHtml(mostUsed)}</p>
      <p><small>Verified subscribers only. A snapshot of what people are watching now - removed watches and unsubscribes leave no trace, and there's no email open/click tracking, so "bought" is the only hard value signal.</small></p>
      <div class="tiles">
        ${tile(verified, `verified subscribers (${total - verified} unverified)`)}
        ${tile(`${raceUsers} <small>(${pct(raceUsers, verified)})</small>`, "use race watch")}
        ${tile(`${ticketUsers} <small>(${pct(ticketUsers, verified)})</small>`, "use ticket watch")}
        ${tile(usage?.both_feat || 0, "use both")}
        ${tile(usage?.neither || 0, "verified but watching nothing")}
      </div>
    </div>

    ${prioCardHtml()}

    ${mailCardHtml()}

    ${waCardHtml()}

    ${sponsorCard}

    <div class="card">
      <h2>Race watch vs ticket watch</h2>
      <p><small>Race watch = told when a not-yet-on-sale race opens. Ticket watch = told when a specific sold-out ticket type comes back.</small></p>
      <div class="tiles">
        ${tile(raceStats?.total || 0, "active race watches")}
        ${tile(raceStats?.live || 0, "of those: race now on sale")}
        ${tile(ticketStats?.total || 0, "active ticket watches")}
        ${tile(`${ticketStats?.bought || 0} <small>(${pct(ticketStats?.bought || 0, ticketStats?.total || 0)})</small>`, "ticket watches marked bought")}
      </div>
      <h2 style="margin-top:20px">New watches added</h2>
      <div class="tiles">
        ${tile(recent?.race7 || 0, "race watches, last 7 days")}
        ${tile(recent?.ticket7 || 0, "ticket watches, last 7 days")}
        ${tile(recent?.race30 || 0, "race watches, last 30 days")}
        ${tile(recent?.ticket30 || 0, "ticket watches, last 30 days")}
      </div>
      <h2 style="margin-top:20px">First thing people set up</h2>
      <div class="tiles">
        ${tile(firstFeat?.race_first || 0, "started with a race watch")}
        ${tile(firstFeat?.ticket_first || 0, "started with a ticket watch")}
      </div>
    </div>

    <div class="card">
      <h2>Most-watched races (race watch)</h2>
      ${listRows((topRaceW.results || []).map((r: any) => ({ name: r.name, n: r.people })), "No race watches yet.")}
    </div>

    <div class="card">
      <h2>Most-watched races (ticket watch)</h2>
      ${listRows((topRaceT.results || []).map((r: any) => ({ name: r.name, n: r.people })), "No ticket watches yet.")}
    </div>

    <div class="card">
      <h2>Most-watched ticket types</h2>
      <p><small>Race days merged (e.g. Friday and Saturday count as one). Number = people.</small></p>
      ${listRows(topTypes, "No ticket watches yet.")}
    </div>

    <div class="card">
      <h2>Signups per week</h2>
      ${
        weeklyRows.length
          ? weeklyRows
              .map(
                (r: any) =>
                  `<div class="arow"><span>Week of ${escapeHtml(r.wk)} <small>(${r.verified} verified)</small></span><b>${r.signups}</b>${bar(r.signups, weeklyMax)}</div>`
              )
              .join("")
          : "<p><small>No signups yet.</small></p>"
      }
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
    `${adminNav(token, "ig-posts")}${rows || "<div class=\"card\"><p>Nothing published yet.</p></div>"}`,
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

// ---------------------------------------------------------------------------
// Instagram "GOING LIVE SOON" posts - the format of our best-performing post (HYROX Basel):
// race name, when tickets open (in the race's own time zone), race day, call to action.
// ---------------------------------------------------------------------------
function titleCase(w: string): string {
  return w
    .split(/([ -])/)
    .map((p) =>
      /^(I{1,3}|IV|VI{0,3}|IX|X)$/i.test(p) // "Singapore II" stays "II"
        ? p.toUpperCase()
        : p.length > 1 || /[a-zà-ÿ]/i.test(p)
          ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
          : p
    )
    .join("");
}

/** Race name from a shop event name ("BYD | HYROX Bangkok | Season 26/27" -> "HYROX Bangkok"). */
function shortRaceName(eventName: string): { name: string; city: string } {
  const segs = eventName.split("|").map((s) => s.trim()).filter(Boolean);
  return raceNameParts(segs.find((s) => /HYROX/i.test(s)) || segs[0] || eventName);
}

/** "INTERSPORT HYROX Vienna" -> { name: "HYROX Vienna", city: "Vienna" } (sponsor dropped). */
function raceNameParts(title: string): { name: string; city: string } {
  const i = title.toUpperCase().indexOf("HYROX");
  const rest = (i >= 0 ? title.slice(i + 5) : title).trim();
  const city = titleCase(rest.replace(/\s+/g, " "));
  return { name: `HYROX ${city}`.trim(), city };
}

/** Time-zone label people recognise: "CET", "EST" ... falling back to "GMT+1". */
function tzLabel(d: Date, tz: string): string {
  const pick = (loc: string) =>
    new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "";
  const gb = pick("en-GB");
  if (gb && !/^GMT|^UTC/.test(gb)) return gb;
  const us = pick("en-US");
  return us && !/^GMT|^UTC/.test(us) ? us : gb || "UTC";
}

interface GoingLivePost {
  card: CardInput;
  caption: string;
}

function goingLivePost(row: { title: string; event_date: string | null; presale_live_at: string; presale_timezone: string | null }): GoingLivePost {
  const tz = row.presale_timezone || "UTC";
  const at = new Date(row.presale_live_at);
  const { name, city } = raceNameParts(row.title);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(at);
  const shortDate = fmt({ month: "short", day: "numeric" }); // "Nov 11"
  const longDate = fmt({ month: "long", day: "numeric" }); // "November 11"
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(at); // "12:00"
  const zone = tzLabel(at, tz);
  const raceDay = row.event_date
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(row.event_date + "T00:00:00Z"))
    : "";
  const tag = city.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  return {
    card: {
      badge: "GOING LIVE SOON",
      titleLines: ["HYROX", city.toUpperCase()],
      line1: `Tickets open ${shortDate} · ${time} ${zone}`,
      line2: raceDay ? `Race day: ${raceDay}` : undefined,
      footer1: "Get alerted the second it opens",
      footer2: "roxracealerts.com",
    },
    caption:
      `🚨 ${name} tickets go live ${longDate} at ${time} ${zone}.

` +
      (raceDay ? `Race day is ${raceDay} - ` : "") +
      `set your own reminder, or let us do it for you. RoxRaceAlerts pings you the second sales open, free.

Link in bio.

` +
      `#hyrox #hyrox${tag} #hyroxcommunity #hyroxticket #hybridathlete`,
  };
}

/** Our recent Instagram posts with like/comment counts and insights (reach, views, saves,
 * shares) where the token allows them. Read-only. */
async function fetchInstagramMedia(env: Env): Promise<{ count: number; items: any[]; error?: string }> {
  const tok = encodeURIComponent(await igToken(env));
  const list: any = await fetch(`https://graph.instagram.com/me/media?fields=id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,media_url,thumbnail_url&limit=50&access_token=${tok}`).then((r) => r.json());
  const items = Array.isArray(list?.data) ? list.data : [];
  for (const m of items) {
    const ins: any = await fetch(`https://graph.instagram.com/${m.id}/insights?metric=reach,views,likes,comments,saved,shares,total_interactions&access_token=${tok}`).then((r) => r.json());
    m.insights = Array.isArray(ins?.data) ? Object.fromEntries(ins.data.map((d: any) => [d.name, d.values?.[0]?.value ?? d.total_value?.value])) : { error: ins?.error?.message };
  }
  return { count: items.length, items, error: list?.error?.message };
}

/** The Instagram token in use. Long-lived tokens expire after 60 days, so checkInstagramToken renews
 * it weekly and keeps the renewed one in kv_meta "ig_token" (a Worker can't update its own secrets).
 * The renewed token only counts while IG_ACCESS_TOKEN is still the secret it came from, so putting
 * a fresh secret in place always wins. */
async function igToken(env: Env): Promise<string> {
  const base = env.IG_ACCESS_TOKEN || "";
  if (!base) return "";
  const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'ig_token'").first<any>();
  try {
    const saved = row?.value ? JSON.parse(row.value) : null;
    if (saved?.token && saved.from === base.slice(-12)) return saved.token;
  } catch {}
  return base;
}

/** Renews the Instagram token when the last renewal is over a week old. Instagram only renews
 * tokens that are at least a day old, so a brand-new secret just fails once and is retried the
 * next day. Returns an error message, or null. */
async function renewIgTokenIfDue(env: Env): Promise<string | null> {
  const base = env.IG_ACCESS_TOKEN || "";
  const row = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'ig_token'").first<any>();
  let saved: any = null;
  try {
    saved = row?.value ? JSON.parse(row.value) : null;
  } catch {}
  if (saved?.from === base.slice(-12) && Date.now() - Date.parse(saved.renewed_at) < 7 * 86400_000) return null;
  const r: any = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(await igToken(env))}`).then((x) => x.json());
  if (!r?.access_token) return `renewal failed: ${r?.error?.message ?? "no token returned"}`;
  const value = { token: r.access_token, from: base.slice(-12), renewed_at: new Date().toISOString(), expires_in: r.expires_in };
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('ig_token', ?)").bind(JSON.stringify(value)).run();
  return null;
}

/** Daily Instagram token health check and renewal: which account the token belongs to and the
 * posting quota, stored in kv_meta "ig_status" so it can be read without the admin key.
 * Runs at most once a day; the first run happens on the first scheduler tick after a deploy. */
async function checkInstagramToken(env: Env): Promise<void> {
  if (!env.IG_ACCESS_TOKEN) return;
  const last = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'ig_status'").first<any>();
  if (last?.value) {
    try {
      if (Date.now() - Date.parse(JSON.parse(last.value).checked_at) < 24 * 3600_000) return;
    } catch {}
  }
  const tok = encodeURIComponent(await igToken(env));
  const status: any = { checked_at: new Date().toISOString() };
  try {
    const me: any = await fetch(`https://graph.instagram.com/me?fields=user_id,username,account_type,media_count&access_token=${tok}`).then((r) => r.json());
    if (me?.error) status.error = `${me.error.code ?? ""} ${me.error.message ?? ""}`.trim();
    else {
      Object.assign(status, { user_id: me.user_id, username: me.username, account_type: me.account_type, media_count: me.media_count });
      const lim: any = await fetch(`https://graph.instagram.com/${me.user_id}/content_publishing_limit?fields=config,quota_usage&access_token=${tok}`).then((r) => r.json());
      status.quota = lim?.data?.[0] ?? lim?.error?.message ?? null;
    }
    if (!status.error) {
      const renewError = await renewIgTokenIfDue(env);
      if (renewError) status.renew_error = renewError;
    }
  } catch (e) {
    status.error = String(e).slice(0, 200);
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('ig_status', ?)").bind(JSON.stringify(status)).run();
  // Daily snapshot of our posts and how they did, to learn what works (read with D1, no admin key).
  if (!status.error) {
    try {
      const media = await fetchInstagramMedia(env);
      await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('ig_media', ?)").bind(JSON.stringify({ at: status.checked_at, ...media })).run();
    } catch (e) {
      console.error("ig media snapshot failed:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Instagram auto-posts: when HYROX announces when a race's tickets go on sale, a "GOING LIVE SOON"
// post is drafted and sent to the admin's Telegram with [Post now] / [Skip] buttons. Nothing
// reaches Instagram without that tap. Drafts live in ig_auto_posts; media_key is a random part of
// the image URL and of the button data, so staging drafts can never trigger a production post.
// ---------------------------------------------------------------------------

const IG_DRAFT_EVERY_HOURS = 4; // at most one new draft per 4 hours
const IG_DRAFT_SWISS_HOURS = [9, 21]; // drafts only arrive between 09:00 and 21:00 Swiss time

/** Public image URL of a draft: the feed card, its "story" version, or slide n of a scheduled post. */
function igMediaUrl(env: Env, id: number, key: string, variant?: "story" | number): string {
  return `${env.SITE_URL}/ig-media/${id}-${key}${variant === undefined ? "" : `-${variant}`}.jpg`;
}

/** Scheduled posts store {"slides": [...]} in card_json; "GOING LIVE SOON" drafts store one card. */
function draftSlides(row: { card_json: string }): Slide[] | null {
  try {
    const parsed = JSON.parse(row.card_json);
    return Array.isArray(parsed?.slides) ? parsed.slides : null;
  } catch {
    return null;
  }
}

/** Scheduled drafts meant for a story (e.g. race day) rather than the feed. */
function draftIsStory(row: { card_json: string }): boolean {
  try {
    return JSON.parse(row.card_json)?.story === true;
  } catch {
    return false;
  }
}

/** Creates a draft for one directory race and sends it to the admin's Telegram (when configured).
 * Returns null when that race already has a draft. */
async function createIgDraft(
  env: Env,
  row: { url: string; title: string; event_date: string | null; presale_live_at: string; presale_timezone: string | null }
): Promise<{ id: number; image_url: string; caption: string; telegram_sent: boolean } | null> {
  const post = goingLivePost(row);
  const key = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO ig_auto_posts (event_url, presale_live_at, card_json, caption, media_key) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(row.url, row.presale_live_at, JSON.stringify(post.card), post.caption, key)
    .run();
  if (!ins.meta.changes) return null;
  const id = Number(ins.meta.last_row_id);
  let sent = false;
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const form = new FormData();
    form.set("chat_id", env.TELEGRAM_CHAT_ID);
    form.set("caption", `📸 Instagram draft: ${raceNameParts(row.title).name}\n\n${post.caption}`.slice(0, 1024));
    form.set("photo", new Blob([await renderCardJpeg(post.card)], { type: "image/jpeg" }), `going-live-${id}.jpg`);
    form.set(
      "reply_markup",
      JSON.stringify({ inline_keyboard: [[{ text: "✅ Post now", callback_data: `ig:post:${id}:${key}` }, { text: "✖ Skip", callback_data: `ig:skip:${id}:${key}` }]] })
    );
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
    sent = resp.ok;
    if (!resp.ok) {
      const err = (await resp.text()).slice(0, 300);
      console.error(`Instagram draft ${id} not sent to Telegram: ${resp.status} ${err}`);
      await env.DB.prepare("UPDATE ig_auto_posts SET status = 'failed', error = ? WHERE id = ?").bind(`telegram: ${err}`, id).run();
    }
  }
  return { id, image_url: igMediaUrl(env, id, key), caption: post.caption, telegram_sent: sent };
}

/** Part of the frequent checks: drafts the next "GOING LIVE SOON" post, soonest sale first, for
 * sales between 6 hours and 21 days away. Needs Instagram and Telegram configured (production). */
async function draftGoingLivePosts(env: Env): Promise<void> {
  if (!env.IG_ACCESS_TOKEN || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", hour12: false }).format(new Date()));
  if (hour < IG_DRAFT_SWISS_HOURS[0] || hour >= IG_DRAFT_SWISS_HOURS[1]) return;
  const recent = await env.DB.prepare(`SELECT 1 FROM ig_auto_posts WHERE created_at > datetime('now', '-${IG_DRAFT_EVERY_HOURS} hours') LIMIT 1`).first();
  if (recent) return;
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT d.url, d.title, d.event_date, d.presale_live_at, d.presale_timezone FROM event_directory d
     WHERE d.presale_is_live = 0 AND d.presale_live_at > ? AND d.presale_live_at < ?
       AND (d.event_date IS NULL OR d.event_date >= ?)
       AND NOT EXISTS (SELECT 1 FROM ig_auto_posts p WHERE p.event_url = d.url)
     ORDER BY d.presale_live_at ASC LIMIT 1`
  )
    .bind(new Date(now + 6 * 3600_000).toISOString(), new Date(now + 21 * 86400_000).toISOString(), new Date(now).toISOString().slice(0, 10))
    .first<any>();
  if (row) await createIgDraft(env, row);
}

/** Publishes one image post (or story, when caption is null) to our Instagram account: create the
 * media container from a public JPEG URL, wait until Instagram has fetched the image, then publish.
 * Stories can't carry a link sticker through the API - that has to be added in the app. */
async function publishToInstagram(env: Env, imageUrl: string, caption: string | null): Promise<{ id: string; permalink?: string }> {
  const api = "https://graph.instagram.com";
  const tok = await igToken(env);
  const get = (path: string) => fetch(`${api}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(tok)}`).then((r) => r.json() as Promise<any>);
  const post = async (path: string, params: Record<string, string>) => {
    const r: any = await fetch(`${api}/${path}`, { method: "POST", body: new URLSearchParams({ ...params, access_token: tok }) }).then((x) => x.json());
    if (r?.error) throw new Error(r.error.error_user_msg || r.error.message || JSON.stringify(r.error));
    return r;
  };
  const me = await get("me?fields=user_id");
  if (!me?.user_id) throw new Error(me?.error?.message || "Instagram token check failed");
  const container = await post(`${me.user_id}/media`, caption === null ? { image_url: imageUrl, media_type: "STORIES" } : { image_url: imageUrl, caption });
  for (let i = 0; i < 10; i++) {
    const s = await get(`${container.id}?fields=status_code`);
    if (s?.status_code === "FINISHED") break;
    if (s?.status_code === "ERROR" || s?.status_code === "EXPIRED") throw new Error(`Instagram couldn't process the image (${s.status_code})`);
    await pause(2000);
  }
  const done = await post(`${me.user_id}/media_publish`, { creation_id: container.id });
  const info = await get(`${done.id}?fields=permalink`).catch(() => null);
  return { id: done.id, permalink: info?.permalink };
}

/** Publishes a carousel (2-10 images): one container per image, then the carousel container. */
async function publishCarouselToInstagram(env: Env, imageUrls: string[], caption: string): Promise<{ id: string; permalink?: string }> {
  const api = "https://graph.instagram.com";
  const tok = await igToken(env);
  const get = (path: string) => fetch(`${api}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(tok)}`).then((r) => r.json() as Promise<any>);
  const post = async (path: string, params: Record<string, string>) => {
    const r: any = await fetch(`${api}/${path}`, { method: "POST", body: new URLSearchParams({ ...params, access_token: tok }) }).then((x) => x.json());
    if (r?.error) throw new Error(r.error.error_user_msg || r.error.message || JSON.stringify(r.error));
    return r;
  };
  const waitReady = async (id: string) => {
    for (let i = 0; i < 10; i++) {
      const s = await get(`${id}?fields=status_code`);
      if (s?.status_code === "FINISHED") return;
      if (s?.status_code === "ERROR" || s?.status_code === "EXPIRED") throw new Error(`Instagram couldn't process an image (${s.status_code})`);
      await pause(2000);
    }
  };
  const me = await get("me?fields=user_id");
  if (!me?.user_id) throw new Error(me?.error?.message || "Instagram token check failed");
  const children: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    const c = await post(`${me.user_id}/media`, { image_url: url, is_carousel_item: "true" });
    await waitReady(c.id);
    children.push(c.id);
  }
  const carousel = await post(`${me.user_id}/media`, { media_type: "CAROUSEL", children: children.join(","), caption });
  await waitReady(carousel.id);
  const done = await post(`${me.user_id}/media_publish`, { creation_id: carousel.id });
  const info = await get(`${done.id}?fields=permalink`).catch(() => null);
  return { id: done.id, permalink: info?.permalink };
}

/** [Post now] / [Skip] on a draft in the admin's Telegram. Only the admin's own taps count. */
async function handleIgDraftButton(env: Env, cb: any): Promise<void> {
  const tg = (method: string, body: object) =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: cb.id, text });
  const closeButtons = () =>
    cb.message ? tg("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }) : null;
  if (!env.TELEGRAM_CHAT_ID || String(cb.from?.id) !== String(env.TELEGRAM_CHAT_ID)) {
    await answer("Not allowed.");
    return;
  }
  const [, action, idStr, key] = String(cb.data || "").split(":");
  const row = await env.DB.prepare("SELECT * FROM ig_auto_posts WHERE id = ? AND media_key = ?").bind(Number(idStr), key || "").first<any>();
  if (!row) {
    await answer("This draft isn't here any more.");
    return;
  }
  if (row.status !== "pending") {
    await answer(`Already ${row.status}.`);
    await closeButtons();
    return;
  }
  if (action === "skip") {
    await env.DB.prepare("UPDATE ig_auto_posts SET status = 'skipped', decided_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(row.id).run();
    await answer("Skipped - not posted.");
    await closeButtons();
    return;
  }
  if (action !== "post") return;
  const slides = draftSlides(row);
  // presale_live_at is the draft's "valid until": the sale start, or for scheduled posts a few days.
  if (Date.parse(row.presale_live_at) <= Date.now()) {
    await env.DB.prepare("UPDATE ig_auto_posts SET status = 'expired', decided_at = datetime('now') WHERE id = ?").bind(row.id).run();
    await answer(slides ? "This draft is out of date - not posted." : "Tickets are already on sale - not posted.");
    await closeButtons();
    return;
  }
  // Claim it first, so a double tap can't post twice.
  const claim = await env.DB.prepare("UPDATE ig_auto_posts SET status = 'posting' WHERE id = ? AND status = 'pending'").bind(row.id).run();
  if (!claim.meta.changes) {
    await answer("Already being posted.");
    return;
  }
  await answer("Posting to Instagram...");
  try {
    const done = draftIsStory(row)
      ? await publishToInstagram(env, igMediaUrl(env, row.id, row.media_key, "story"), null)
      : slides && slides.length > 1
        ? await publishCarouselToInstagram(env, slides.map((_, i) => igMediaUrl(env, row.id, row.media_key, i)), row.caption)
        : await publishToInstagram(env, igMediaUrl(env, row.id, row.media_key, slides ? 0 : undefined), row.caption);
    await env.DB.prepare("UPDATE ig_auto_posts SET status = 'posted', ig_media_id = ?, error = NULL, decided_at = datetime('now') WHERE id = ?")
      .bind(done.id, row.id)
      .run();
    await closeButtons();
    await sendTelegram(env, `✅ Posted to Instagram${done.permalink ? `: ${done.permalink}` : "."}`);
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 300);
    await env.DB.prepare("UPDATE ig_auto_posts SET status = 'pending', error = ? WHERE id = ?").bind(msg, row.id).run();
    await sendTelegram(env, `⚠️ Instagram post failed: ${msg}\nTap "Post now" again to retry.`);
  }
}

/** Part of the frequent checks: once a draft is posted, also post it as a story (no link - the
 * API can't add link stickers), then send the story image to the admin's Telegram so a version
 * with a link sticker can be posted from the app. One story per run; failures aren't retried. */
async function postPendingStories(env: Env): Promise<void> {
  if (!env.IG_ACCESS_TOKEN) return;
  const row = await env.DB.prepare(
    "SELECT * FROM ig_auto_posts WHERE status = 'posted' AND story_status IS NULL AND presale_live_at > ? ORDER BY id LIMIT 1"
  )
    .bind(new Date().toISOString())
    .first<any>();
  if (!row) return;
  if (draftSlides(row)) {
    // Scheduled posts (weekly carousel, race weekend) don't get the automatic story.
    await env.DB.prepare("UPDATE ig_auto_posts SET story_status = 'skipped' WHERE id = ? AND story_status IS NULL").bind(row.id).run();
    return;
  }
  const claim = await env.DB.prepare("UPDATE ig_auto_posts SET story_status = 'posting' WHERE id = ? AND story_status IS NULL").bind(row.id).run();
  if (!claim.meta.changes) return;
  const storyUrl = igMediaUrl(env, row.id, row.media_key, "story");
  let note: string;
  try {
    const done = await publishToInstagram(env, storyUrl, null);
    await env.DB.prepare("UPDATE ig_auto_posts SET story_status = 'posted', story_media_id = ? WHERE id = ?").bind(done.id, row.id).run();
    note = "Posted to your story automatically (without a link - Instagram doesn't allow links through the API).";
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 300);
    await env.DB.prepare("UPDATE ig_auto_posts SET story_status = 'failed', story_error = ? WHERE id = ?").bind(msg, row.id).run();
    note = `⚠️ The automatic story failed: ${msg}`;
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const name = raceNameParts(JSON.parse(row.card_json).titleLines?.join(" ") || "").name;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      photo: storyUrl,
      caption: `📲 Story: ${name}\n${note}\n\nFor a clickable version: save this image, add it to your story in Instagram, tap the sticker icon, choose Link and enter roxracealerts.com.`,
    }),
  }).catch((e) => console.error("story image to Telegram failed:", e));
}

/** Public JPEG of a draft (feed or story format, or slide n of a scheduled post), for Instagram
 * to download when publishing. */
async function handleIgMedia(env: Env, id: number, key: string, variant: string | undefined): Promise<Response> {
  const row = await env.DB.prepare("SELECT card_json FROM ig_auto_posts WHERE id = ? AND media_key = ?").bind(id, key).first<any>();
  if (!row) return new Response("Not found", { status: 404 });
  const slides = draftSlides(row);
  let jpg: Uint8Array;
  if (slides) {
    const slide = variant === "story" ? slides[0] : slides[Number(variant)];
    if (!slide) return new Response("Not found", { status: 404 });
    jpg = await renderSlideJpeg(slide, variant === "story" ? "story" : "square");
  } else {
    if (variant !== undefined && variant !== "story") return new Response("Not found", { status: 404 });
    jpg = await renderCardJpeg(JSON.parse(row.card_json), variant === "story" ? "story" : "square");
  }
  return new Response(jpg, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
}

// ---------------------------------------------------------------------------
// Instagram posting plan (agreed 2026-10-26): besides "GOING LIVE SOON" (whenever a sale is
// announced), two scheduled posts are drafted to the admin's Telegram for approval:
//   Monday 18:00 Swiss  - "This week in HYROX tickets" carousel (sales opening, races, selling fast)
//   Thursday 18:00 Swiss - "Racing this weekend" list
// and a Sunday 19:00 report of how the week's posts did. ig_auto_posts.event_url holds a key
// like "weekly:2026-11-02"; presale_live_at is how long the draft stays postable.
// ---------------------------------------------------------------------------
const IG_FOOTER = { footer1: "Get alerted the second it opens", footer2: "roxracealerts.com" };
const IG_TAGS = "#hyrox #hyroxcommunity #hyroxticket #hybridathlete #hyroxtraining";

/** Swiss local date/weekday/hour right now. */
function swissNow(): { date: string; weekday: number; hour: number } {
  const local = new Date(Date.now() + zurichOffsetMinutes() * 60000);
  return { date: local.toISOString().slice(0, 10), weekday: local.getUTCDay(), hour: local.getUTCHours() };
}

const dayLabel = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${isoDate}T00:00:00Z`));

/** Races between two dates (inclusive), one per city. */
async function racesBetween(env: Env, from: string, to: string): Promise<{ city: string; date: string }[]> {
  const { results } = await env.DB.prepare("SELECT title, event_date FROM event_directory WHERE event_date BETWEEN ? AND ? ORDER BY event_date, title")
    .bind(from, to)
    .all<any>();
  const seen = new Set<string>();
  const out: { city: string; date: string }[] = [];
  for (const r of results || []) {
    const city = shortRaceName(r.title).city || r.title;
    if (seen.has(city)) continue;
    seen.add(city);
    out.push({ city, date: r.event_date });
  }
  return out;
}

/** Monday carousel: cover, sales opening this week, races this week, selling fast, call to action. */
async function weeklyPost(env: Env, today: string): Promise<{ slides: Slide[]; caption: string } | null> {
  const now = Date.now();
  const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86400_000).toISOString().slice(0, 10);
  const { results: sales } = await env.DB.prepare(
    "SELECT title, presale_live_at, presale_timezone FROM event_directory WHERE presale_is_live = 0 AND presale_live_at > ? AND presale_live_at < ? ORDER BY presale_live_at LIMIT 6"
  )
    .bind(new Date(now).toISOString(), new Date(now + 7 * 86400_000).toISOString())
    .all<any>();
  const saleRows = (sales || []).map((r: any) => {
    const tz = r.presale_timezone || "UTC";
    const at = new Date(r.presale_live_at);
    const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(at);
    const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(at);
    return { left: shortRaceName(r.title).city, right: `${when} · ${time}`, zone: tzLabel(at, tz) };
  });
  const races = await racesBetween(env, today, weekEnd);
  const { results: hot } = await env.DB.prepare(
    `SELECT event_name, COUNT(*) AS n FROM community_tickets WHERE last_status = 'sold_out' AND (event_date IS NULL OR event_date >= ?)
     GROUP BY event_name ORDER BY n DESC LIMIT 6`
  )
    .bind(today)
    .all<any>();
  const hotRows = (hot || []).map((r: any) => ({ left: shortRaceName(r.event_name).city, right: `${r.n} sold out` }));
  if (!saleRows.length && !races.length && !hotRows.length) return null;

  // The information goes on the images, starting with the first one: people look at the slides
  // and rarely read the caption (admin feedback on the first carousel, 2026-10-26).
  const slides: Slide[] = [];
  if (races.length) slides.push({ kind: "list", list: { badge: "THIS WEEK", titleLines: ["HYROX RACES", "THIS WEEK"], rows: races.map((r) => ({ left: r.city, right: dayLabel(r.date) })), ...IG_FOOTER } });
  if (saleRows.length) slides.push({ kind: "list", list: { badge: "SALES OPENING", titleLines: ["TICKETS", "GO LIVE"], rows: saleRows.map(({ left, right }) => ({ left, right })), ...IG_FOOTER } });
  if (hotRows.length) slides.push({ kind: "list", list: { badge: "SELLING FAST", titleLines: ["SOLD-OUT", "TICKETS"], rows: hotRows, footer1: "We alert you when spots come back", footer2: "roxracealerts.com" } });
  // Point to the next slides from the first one.
  const first = slides[0];
  if (first?.kind === "list" && slides.length > 1) {
    const next = slides.slice(1).map((s) => (s.kind === "list" ? s.list.badge : ""));
    first.list.footer1 = next.includes("SALES OPENING") ? "Swipe: tickets going live this week →" : "Swipe: what's selling fast →";
  }
  slides.push(IG_CTA_SLIDE);

  const parts = [`This week in HYROX tickets 🗓️`];
  if (saleRows.length) parts.push(`🎟️ Tickets go live:\n${saleRows.map((r) => `- ${r.left}: ${r.right} ${r.zone}`).join("\n")}`);
  if (races.length) parts.push(`🏁 Racing this week:\n${races.map((r) => `- ${r.city} (${dayLabel(r.date)})`).join("\n")}`);
  if (hotRows.length) parts.push(`🔥 Selling fast: ${hotRows.map((r) => r.left).join(", ")}`);
  parts.push("Save this post 📌 and get alerted free the second tickets open or a sold-out spot comes back. Link in bio.");
  parts.push(IG_TAGS);
  return { slides, caption: parts.join("\n\n") };
}

/** Thursday post: races Friday-Sunday. */
async function weekendPost(env: Env, today: string): Promise<{ slides: Slide[]; caption: string } | null> {
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const races = await racesBetween(env, day(1), day(3));
  if (!races.length) return null;
  const tags = races
    .slice(0, 3)
    .map((r) => `#hyrox${r.city.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "")}`)
    .join(" ");
  return {
    slides: [{ kind: "list", list: { badge: "RACE WEEKEND", titleLines: ["RACING", "THIS WEEKEND"], rows: races.map((r) => ({ left: r.city, right: dayLabel(r.date) })), ...IG_FOOTER } }],
    caption:
      `🏁 HYROX races this weekend:\n${races.map((r) => `- ${r.city} (${dayLabel(r.date)})`).join("\n")}\n\n` +
      `Good luck to everyone racing! 💪 Missed out on a ticket? Sold-out spots come back more often than you think, and RoxRaceAlerts tells you the second they do. Free, link in bio.\n\n` +
      `${IG_TAGS} ${tags}`,
  };
}

/** Morning story on race days: "RACE DAY - HYROX Birmingham", or all of the day's races. */
async function raceDayStory(env: Env, today: string): Promise<{ slides: Slide[]; caption: string; story: true } | null> {
  const races = await racesBetween(env, today, today);
  if (!races.length) return null;
  const one = races.length === 1;
  const cities = races.map((r) => r.city);
  return {
    story: true,
    slides: [
      {
        kind: "card",
        card: {
          badge: "RACE DAY",
          titleLines: one ? ["HYROX", cities[0].toUpperCase()] : ["HYROX", "RACE DAY"],
          line1: one ? "Good luck to everyone racing today" : cities.slice(0, 4).join(" · "),
          line2: one ? dayLabel(today) : "Good luck to everyone racing today",
          ...IG_FOOTER,
        },
      },
    ],
    caption: `Race day story: ${cities.join(", ")} (stories have no caption).`,
  };
}

const IG_CTA_SLIDE: Slide = {
  kind: "card",
  card: { badge: "FREE ALERTS", titleLines: ["NEVER MISS", "A DROP"], line1: "Alerted the second tickets open", line2: "or a sold-out spot comes back", footer1: "Link in bio", footer2: "roxracealerts.com" },
};

/** Evergreen posts for Tuesdays and Saturdays, used in turn: things worth saving or sending to a
 * training partner. */
const EVERGREEN_POSTS: { slides: Slide[]; caption: string }[] = [
  {
    slides: [
      { kind: "card", card: { badge: "SOLD OUT?", titleLines: ["NOT OVER", "YET"], line1: "Sold-out HYROX spots come back", line2: "when people's plans change", footer1: "Swipe to see how →", footer2: "roxracealerts.com" } },
      {
        kind: "list",
        list: {
          badge: "HOW IT WORKS",
          titleLines: ["GET THE", "SPOT BACK"],
          rows: [
            { left: "1. Pick your race", right: "30 seconds" },
            { left: "2. Tick the sold-out tickets", right: "free" },
            { left: "3. We watch the shop", right: "day and night" },
            { left: "4. You get the alert", right: "email · Telegram" },
          ],
          ...IG_FOOTER,
        },
      },
      IG_CTA_SLIDE,
    ],
    caption: `Sold out doesn't mean over. 🎟️\n\nHYROX spots come back when people's plans change, but they rarely last long. RoxRaceAlerts watches the ticket shops around the clock and tells you the second one appears. Free.\n\nSave this for your next race 📌 Link in bio.\n\n${IG_TAGS}`,
  },
  {
    slides: [
      { kind: "card", card: { badge: "DOUBLES", titleLines: ["SEND THIS TO", "YOUR PARTNER"], line1: "You both need a ticket", line2: "Both get alerted when spots open", ...IG_FOOTER } },
      IG_CTA_SLIDE,
    ],
    caption: `Racing Doubles or Relay? Your partner needs a ticket too. 👯\n\nSend them this and set up your alerts together: you both get notified the second tickets open or a sold-out spot comes back. Free.\n\nTag your training partner 👇 Link in bio.\n\n${IG_TAGS} #hyroxdoubles`,
  },
  {
    slides: [
      { kind: "card", card: { badge: "STOP REFRESHING", titleLines: ["WE WATCH", "IT FOR YOU"], line1: "Every HYROX ticket shop", line2: "checked around the clock", ...IG_FOOTER } },
      IG_CTA_SLIDE,
    ],
    caption: `Still refreshing the HYROX shop at midnight? 😅\n\nWe check every HYROX ticket shop around the clock and alert you the second tickets go on sale or a sold-out spot comes back. Free, any race worldwide.\n\nLink in bio.\n\n${IG_TAGS}`,
  },
  {
    slides: [
      { kind: "card", card: { badge: "FREE", titleLines: ["ALERTS ON", "TELEGRAM"], line1: "HYROX ticket alerts, instantly", line2: "Free for everyone", ...IG_FOOTER } },
      IG_CTA_SLIDE,
    ],
    caption: `Email not fast enough? 📲\n\nGet your HYROX ticket alerts on Telegram too: free for everyone, straight to your phone. Switch it on from My alerts on roxracealerts.com.\n\nLink in bio.\n\n${IG_TAGS}`,
  },
  {
    slides: [
      { kind: "card", card: { badge: "PRIORITY", titleLines: ["BE FIRST", "IN LINE"], line1: "Alerted before everyone else", line2: "$3 per race, WhatsApp included", ...IG_FOOTER } },
      IG_CTA_SLIDE,
    ],
    caption: `When a sold-out spot comes back, minutes matter. ⚡\n\nPriority members are alerted before everyone else, with a WhatsApp notification. $3 per race, one-off. Free alerts stay free, always.\n\nLink in bio.\n\n${IG_TAGS}`,
  },
];

async function nextEvergreenPost(env: Env): Promise<{ slides: Slide[]; caption: string }> {
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM ig_auto_posts WHERE event_url LIKE 'evergreen:%'").first<any>();
  return EVERGREEN_POSTS[(Number(used?.n) || 0) % EVERGREEN_POSTS.length];
}

/** Saves a scheduled draft and sends it to the admin's Telegram: the images as an album, then
 * the caption with [Post now] / [Skip]. */
async function createScheduledDraft(
  env: Env,
  key: string,
  post: { slides: Slide[]; caption: string; story?: boolean },
  validHours: number,
  label = "Instagram post"
): Promise<number | null> {
  const mediaKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO ig_auto_posts (event_url, presale_live_at, card_json, caption, media_key) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(key, new Date(Date.now() + validHours * 3600_000).toISOString(), JSON.stringify({ slides: post.slides, story: post.story === true }), post.caption, mediaKey)
    .run();
  if (!ins.meta.changes) return null;
  const id = Number(ins.meta.last_row_id);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return id;
  const tg = (method: string, body: object) =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const buttons = {
    inline_keyboard: [[{ text: post.story ? "✅ Post story" : "✅ Post now", callback_data: `ig:post:${id}:${mediaKey}` }, { text: "✖ Skip", callback_data: `ig:skip:${id}:${mediaKey}` }]],
  };
  if (post.story) {
    await tg("sendPhoto", { chat_id: env.TELEGRAM_CHAT_ID, photo: igMediaUrl(env, id, mediaKey, "story"), caption: `📲 Story draft: ${label}\n\n${post.caption}`.slice(0, 1024), reply_markup: buttons });
  } else if (post.slides.length > 1) {
    await tg("sendMediaGroup", { chat_id: env.TELEGRAM_CHAT_ID, media: post.slides.map((_, i) => ({ type: "photo", media: igMediaUrl(env, id, mediaKey, i) })) });
    await tg("sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: `📸 Instagram draft: ${label} (${post.slides.length} slides)\n\n${post.caption}`.slice(0, 4000), reply_markup: buttons });
  } else {
    await tg("sendPhoto", { chat_id: env.TELEGRAM_CHAT_ID, photo: igMediaUrl(env, id, mediaKey, 0), caption: `📸 Instagram draft: ${label}\n\n${post.caption}`.slice(0, 1024), reply_markup: buttons });
  }
  return id;
}

/** Drafts the post for `key` once: built and sent to Telegram, or remembered as "nothing to post"
 * so it isn't looked for again every two minutes. */
async function draftOnce(
  env: Env,
  key: string,
  build: () => Promise<{ slides: Slide[]; caption: string; story?: boolean } | null>,
  validHours: number,
  label: string
): Promise<void> {
  if (await env.DB.prepare("SELECT 1 FROM ig_auto_posts WHERE event_url = ?").bind(key).first()) return;
  const post = await build();
  if (post) await createScheduledDraft(env, key, post, validHours, label);
  else
    await env.DB.prepare("INSERT OR IGNORE INTO ig_auto_posts (event_url, presale_live_at, card_json, caption, media_key, status) VALUES (?, ?, '{\"slides\":[]}', '', '', 'skipped')")
      .bind(key, new Date().toISOString())
      .run();
}

/** Part of the frequent checks (Swiss time): race-day story drafts from 08:00; at 18:00 Monday's
 * carousel, Thursday's race weekend post, and an evergreen post on Tuesdays and Saturdays; the
 * report on Sundays at 19:00. Each at most once (keyed by date). */
async function runInstagramPlan(env: Env): Promise<void> {
  if (!env.IG_ACCESS_TOKEN || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const { date, weekday, hour } = swissNow();
  if (hour >= 8 && hour < 12) await draftOnce(env, `raceday:${date}`, () => raceDayStory(env, date), 14, "Race day");
  if (hour < 18 || hour >= 21) return;
  if (weekday === 1) await draftOnce(env, `weekly:${date}`, () => weeklyPost(env, date), 48, "Weekly carousel");
  else if (weekday === 4) await draftOnce(env, `weekend:${date}`, () => weekendPost(env, date), 30, "Race weekend post");
  else if (weekday === 2 || weekday === 6) await draftOnce(env, `evergreen:${date}`, () => nextEvergreenPost(env), 48, "Tip post");
  if (weekday === 0 && hour >= 19) {
    const last = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'ig_weekly_report'").first<any>();
    if (last?.value === date) return;
    await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('ig_weekly_report', ?)").bind(date).run();
    await sendTelegram(env, await instagramWeeklyReport(env));
  }
}

/** Sunday report: followers, how each of the week's posts did, sign-ups from Instagram. */
async function instagramWeeklyReport(env: Env): Promise<string> {
  const tok = encodeURIComponent(await igToken(env));
  const me: any = await fetch(`https://graph.instagram.com/me?fields=followers_count,media_count&access_token=${tok}`).then((r) => r.json()).catch(() => null);
  const followers = Number(me?.followers_count);
  const prevRow = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'ig_followers'").first<any>();
  const prev = Number(prevRow?.value);
  if (Number.isFinite(followers)) await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('ig_followers', ?)").bind(String(followers)).run();
  const lines = [`📊 Instagram this week`];
  lines.push(Number.isFinite(followers) ? `Followers: ${followers}${Number.isFinite(prev) ? ` (${followers - prev >= 0 ? "+" : ""}${followers - prev})` : ""}` : "Followers: couldn't read");
  const media = await fetchInstagramMedia(env).catch(() => null);
  const week = (media?.items || []).filter((m: any) => Date.now() - Date.parse(m.timestamp) < 7 * 86400_000);
  if (week.length) {
    for (const m of week) {
      const i = m.insights || {};
      lines.push(`• ${String(m.caption || m.media_type).replace(/\s+/g, " ").slice(0, 40)}… reach ${i.reach ?? "?"} · likes ${m.like_count ?? 0} · saves ${i.saved ?? 0} · shares ${i.shares ?? 0}`);
    }
  } else lines.push("No posts this week.");
  const s = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN source = 'ig' THEN 1 ELSE 0 END) AS ig, SUM(CASE WHEN referred_by IS NOT NULL THEN 1 ELSE 0 END) AS ref
     FROM subscribers WHERE created_at >= datetime('now', '-7 days')`
  ).first<any>();
  lines.push(`Sign-ups this week: ${Number(s?.total) || 0} (from Instagram: ${Number(s?.ig) || 0} · via friends' links: ${Number(s?.ref) || 0})`);
  return lines.join("\n");
}

/** The frequent (every ~2 min) job: everything that must notice a change quickly. */
async function runFrequentChecks(env: Env): Promise<void> {
  await Promise.allSettled([
    checkCommunityTickets(env).then(() => sendDueFreeTicketAlerts(env)),
    checkSaleWatches(env).then(() => sendDueFreeSaleAlerts(env)),
    refreshEventDirectorySaleStatus(env),
    checkAnnouncementReminders(env),
    sendManualVerificationNotices(env),
    checkInstagramToken(env),
    draftGoingLivePosts(env),
    postPendingStories(env),
    sendUpdateEmails(env),
    sendNudgeEmails(env),
    runInstagramPlan(env),
    submitIndexNow(env),
    runSeoChecks(env),
  ]);
}

const SCHEDULER_INTERVAL_MS = 2 * 60_000;

/** Makes sure the alarm scheduler is armed. Idempotent and cheap (the DO only arms an alarm when
 * none exists), so it is called from the first request each isolate serves and from the daily
 * crons: the loop restarts by itself after a deploy or a DO reset, with no admin action needed. */
let schedulerKicked = false;
async function ensureScheduler(env: Env): Promise<void> {
  // Only where wanted (production): staging must not poll hyrox.com every two minutes by itself.
  if (schedulerKicked || !env.SCHEDULER || env.SCHEDULER_AUTOSTART !== "1") return;
  schedulerKicked = true;
  try {
    await env.SCHEDULER.get(env.SCHEDULER.idFromName("main")).fetch("https://scheduler/start");
  } catch (e) {
    schedulerKicked = false;
    console.error("ensureScheduler failed:", e);
  }
}

/** Alarm-driven scheduler: a Durable Object whose alarm re-arms itself every two minutes and runs
 * the frequent checks. Added 2026-10-25 because Cloudflare stopped invoking this account's cron
 * triggers (no scheduled invocation on either script since 23 Oct, trigger re-creation and a new
 * expression didn't help) while HTTP kept working. The next alarm is armed BEFORE the checks run,
 * so a failing round can never stop the loop. POST /admin/scheduler/start kicks it off once;
 * it then survives deploys. kv_meta "alarm_last_run" is its heartbeat. */
export class CheckScheduler {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const current = await this.state.storage.getAlarm();
    if (path === "/start") {
      if (current === null) await this.state.storage.setAlarm(Date.now() + 5_000);
      return Response.json({ running: true, next_alarm: current ?? Date.now() + 5_000 });
    }
    if (path === "/stop") {
      await this.state.storage.deleteAlarm();
      return Response.json({ running: false });
    }
    return Response.json({ running: current !== null, next_alarm: current });
  }

  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + SCHEDULER_INTERVAL_MS);
    try {
      await this.env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('alarm_last_run', datetime('now'))").run();
    } catch (e) {
      console.error("alarm heartbeat failed:", e);
    }
    await runFrequentChecks(this.env);
  }
}

/** Short name for the site a visitor arrived from (Referer), as stored in subscribers.source. */
function sourceFromReferrer(ref: string, ownHost: string): string {
  let host = "";
  try {
    host = new URL(ref).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  if (!host || host === ownHost || host.endsWith(`.${ownHost}`)) return "";
  const known: [RegExp, string][] = [
    [/(^|\.)gemini\.google\./, "gemini"],
    [/(^|\.)google\./, "google"],
    [/(^|\.)bing\.com$/, "bing"],
    [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
    [/(^|\.)yahoo\./, "yahoo"],
    [/(^|\.)ecosia\.org$/, "ecosia"],
    [/(^|\.)instagram\.com$/, "ig"],
    [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook"],
    [/(^|\.)tiktok\.com$/, "tiktok"],
    [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
    [/(^|\.)reddit\.com$/, "reddit"],
    [/(^|\.)(chatgpt\.com|openai\.com)$/, "chatgpt"],
    [/(^|\.)perplexity\.ai$/, "perplexity"],
    [/(^|\.)claude\.ai$/, "claude"],
    [/(^|\.)copilot\.microsoft\.com$/, "copilot"],
    [/(^|\.)(t\.co|x\.com|twitter\.com)$/, "x"],
    [/(^|\.)linkedin\.com$/, "linkedin"],
    [/(^|\.)(t\.me|telegram\.org)$/, "telegram"],
    [/(^|\.)whatsapp\.com$/, "whatsapp"],
  ];
  for (const [re, name] of known) if (re.test(host)) return name;
  // Any other site: its name without the ending, e.g. "hyroxforum" for hyroxforum.com.
  const parts = host.split(".");
  return (parts.length > 1 ? parts[parts.length - 2] : host).replace(/[^a-z0-9_-]/g, "").slice(0, 20);
}

/** Remembers where a visitor first came from (30 days) on whatever page they land on, so
 * sign-ups say whether they found us via Google, Instagram, ChatGPT... An explicit ?src= or
 * ?utm_source= wins; otherwise the referring site, only if nothing is stored yet. */
function withSourceCookie(req: Request, resp: Response, ownHost: string): Response {
  if (req.method !== "GET" || resp.status !== 200 || !(resp.headers.get("content-type") || "").includes("text/html")) return resp;
  const url = new URL(req.url);
  const tagged = (url.searchParams.get("src") || url.searchParams.get("utm_source") || "").toLowerCase();
  const hasOne = !!parseCookies(req)[SRC_COOKIE];
  const src = /^[a-z0-9_-]{1,20}$/.test(tagged) ? tagged : hasOne ? "" : sourceFromReferrer(req.headers.get("referer") || "", ownHost);
  if (!src) return resp;
  const out = new Response(resp.body, resp);
  out.headers.append("Set-Cookie", `${SRC_COOKIE}=${src}; Max-Age=2592000; Path=/; Secure; SameSite=Lax`);
  return out;
}

const worker = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const resp = await worker.route(req, env, ctx);
    try {
      return withSourceCookie(req, resp, new URL(env.SITE_URL).hostname.replace(/^www\./, ""));
    } catch {
      return resp;
    }
  },

  async route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureScheduler(env));
    const url = new URL(req.url);
    try {
      // One address for search engines: www. and plain http both go to the canonical origin.
      const site = new URL(env.SITE_URL);
      if (req.method === "GET" && (url.hostname === `www.${site.hostname}` || (url.hostname === site.hostname && url.protocol !== site.protocol))) {
        return Response.redirect(`${site.origin}${url.pathname}${url.search}`, 301);
      }
      if (url.pathname === "/favicon.svg" && req.method === "GET") return handleFavicon();
      if (url.pathname === "/sitemap.xml" && req.method === "GET") return await handleSitemap(env);
      if (url.pathname === "/robots.txt" && req.method === "GET") return handleRobots(env);
      if (url.pathname === `/${INDEXNOW_KEY}.txt` && req.method === "GET") return new Response(INDEXNOW_KEY, { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/admin/indexnow" && req.method === "POST") {
        // Submits every public URL to IndexNow now, regardless of host or the daily limit. Admin only.
        if ((req.headers.get("Authorization") || "") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
        return jsonResponse(await submitIndexNow(env, true));
      }
      const racePage = url.pathname.match(/^\/hyrox\/([a-z0-9-]{1,60})\/?$/);
      if (racePage && req.method === "GET") return await handleRacePage(req, env, racePage[1]);
      if ((url.pathname === "/hyrox" || url.pathname === "/hyrox/") && req.method === "GET") return Response.redirect(`${env.SITE_URL}/`, 301);
      if (url.pathname === "/about" && req.method === "GET") return await handleAboutPage(req, env);
      if (url.pathname === "/supporters" && req.method === "GET") return await handleSupportersPage(req, env, "", { race: url.searchParams.get("race") || "next" });
      if (url.pathname === "/supporters" && req.method === "POST") return await handleSupportersRequest(req, env);
      if (url.pathname === "/widget.js" && req.method === "GET") return handleWidgetScript(env);
      const widgetData = url.pathname.match(/^\/widget-data\/([a-z0-9-]{1,60})$/);
      if (widgetData && req.method === "GET") return await handleWidgetData(req, env, widgetData[1]);
      const guide = url.pathname.match(/^\/guides\/([a-z0-9-]{1,60})\/?$/);
      if (guide && req.method === "GET") return await handleGuidePage(req, env, guide[1]);
      if (url.pathname === "/tickets-back" && req.method === "GET") return await handleTicketsBackPage(req, env);
      if ((url.pathname === "/guides" || url.pathname === "/guides/") && req.method === "GET") return Response.redirect(`${env.SITE_URL}/guides/${GUIDE_SLUGS[0]}`, 301);
      const outMatch = url.pathname.match(/^\/out\/(\d{1,9})$/);
      if (outMatch && req.method === "GET") return await handleSponsorOut(req, env, Number(outMatch[1]));
      const igMedia = url.pathname.match(/^\/ig-media\/(\d{1,9})-([0-9a-f]{16})(?:-(story|\d{1,2}))?\.jpg$/);
      if (igMedia && req.method === "GET") return await handleIgMedia(env, Number(igMedia[1]), igMedia[2], igMedia[3]);
      if (url.pathname === "/" && req.method === "GET") {
        const resp = await handleSignupPage(req, env);
        // A friend's referral link: remember it for 30 days, until this visitor signs up.
        const ref = (url.searchParams.get("ref") || "").toUpperCase();
        if (REF_CODE_RE.test(ref)) resp.headers.append("Set-Cookie", `${REF_COOKIE}=${ref}; Max-Age=2592000; Path=/; Secure; SameSite=Lax`);
        // Where the visitor came from is remembered for every page in withSourceCookie().
        return resp;
      }
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
      if (url.pathname === "/mark-race-purchased" && req.method === "POST") return await handleMarkRacePurchased(req, env);
      if (url.pathname === "/sign-out" && req.method === "GET") return handleSignOut(env);
      if (url.pathname === "/notify" && req.method === "POST") return await handleNotify(req, env);
      if (url.pathname === "/search-events" && req.method === "GET") return await handleSearchEvents(req, env);
      if (url.pathname === "/events" && req.method === "GET") return await handleListEvents(env);
      if (url.pathname === "/admin/reindex" && req.method === "POST") return await handleReindex(req, env);
      if (url.pathname === "/admin/refresh-sale-status" && req.method === "POST") return await handleRefreshSaleStatus(req, env);
      if (url.pathname === "/admin/send-nudges" && req.method === "POST") return await handleSendNudges(req, env);
      if (url.pathname === "/admin/send-ig-post-reminder" && req.method === "POST") return await handleSendIgPostReminder(req, env);
      if (url.pathname === "/whatsapp/webhook" && req.method === "GET") return handleWhatsAppWebhookVerify(req, env);
      if (url.pathname === "/whatsapp/webhook" && req.method === "POST") return await handleWhatsAppWebhookPost(req, env);
      if (url.pathname === "/whatsapp/link" && req.method === "POST") return await handleWhatsAppLink(req, env);
      if (url.pathname === "/whatsapp/waitlist" && req.method === "POST") return await handleWhatsAppWaitlist(req, env);
      if (url.pathname === "/telegram/webhook" && req.method === "POST") return await handleTelegramWebhook(req, env);
      if (url.pathname === "/stripe/webhook" && req.method === "POST") return await handleStripeWebhook(req, env);
      if (url.pathname === "/resend/webhook" && req.method === "POST") return await handleResendWebhook(req, env);
      if (url.pathname === "/priority/checkout" && req.method === "POST") return await handlePriorityCheckout(req, env);
      if (url.pathname === "/watching" && req.method === "GET") return await handleWatchingPage(req, env);
      if (url.pathname === "/terms" && req.method === "GET") return handleTermsPage(env);
      if (url.pathname === "/privacy" && req.method === "GET") return handlePrivacyPage();
      if (url.pathname === "/priority/thanks" && req.method === "GET") return handlePriorityThanks();
      if (url.pathname === "/telegram/link" && req.method === "POST") return await handleTelegramLink(req, env);
      if (url.pathname === "/telegram/unlink" && req.method === "POST") return await handleTelegramUnlink(req, env);
      if (url.pathname === "/admin/whatsapp/register-webhook" && req.method === "POST") return await handleWhatsAppRegisterWebhook(req, env);
      if (url.pathname === "/admin/whatsapp/test-alert" && req.method === "POST") return await handleWhatsAppTestAlert(req, env);
      if (url.pathname === "/whatsapp/unlink" && req.method === "POST") return await handleWhatsAppUnlink(req, env);
      if ((url.pathname === "/admin/scheduler/start" || url.pathname === "/admin/scheduler/stop" || url.pathname === "/admin/scheduler/status") && req.method === "POST") {
        if ((req.headers.get("Authorization") || "") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
        const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("main"));
        const r = await stub.fetch(`https://scheduler/${url.pathname.split("/").pop()}`);
        const body: any = await r.json();
        const hb = await env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'alarm_last_run'").first<any>();
        return jsonResponse({ ...body, alarm_last_run: hb?.value ?? null });
      }
      if (url.pathname === "/admin/seo-report" && req.method === "POST") {
        // The SEO report as text (send=1 also sends it to Telegram) - for testing the connection.
        if (!env.WEBHOOK_SECRET || req.headers.get("Authorization") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
        const report = await seoReport(env);
        if (url.searchParams.get("send") === "1") await sendTelegram(env, report);
        return new Response(report, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname.startsWith("/admin/ig/")) {
        const auth = req.headers.get("Authorization") || "";
        if (!env.WEBHOOK_SECRET || auth !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/admin/ig/media" && req.method === "POST") {
        // Read-only: recent posts with counts and, where the token allows it, insights.
        if (!env.IG_ACCESS_TOKEN) return jsonResponse({ error: "IG_ACCESS_TOKEN not set" }, 400);
        return jsonResponse(await fetchInstagramMedia(env));
      }
      if (url.pathname === "/admin/ig/preview" && req.method === "POST") {
        // Renders a "GOING LIVE SOON" card for a directory race (or given fields) without posting.
        const q = url.searchParams;
        let row: any = q.get("event_url")
          ? await env.DB.prepare("SELECT title, event_date, presale_live_at, presale_timezone FROM event_directory WHERE url = ?").bind(q.get("event_url")).first<any>()
          : { title: q.get("title") || "HYROX Kraków", event_date: q.get("race_day"), presale_live_at: q.get("live_at") || new Date(Date.now() + 7 * 86400_000).toISOString(), presale_timezone: q.get("tz") };
        if (!row?.presale_live_at) return jsonResponse({ error: "no sale time for that race" }, 404);
        const post = goingLivePost(row);
        if (q.get("caption") === "1") return jsonResponse(post);
        const jpg = await renderCardJpeg(post.card);
        return new Response(jpg, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
      }
      if (url.pathname === "/admin/ig/draft" && req.method === "POST") {
        // Drafts the "GOING LIVE SOON" post for one directory race now (no time window or pacing),
        // and sends it to Telegram where configured. Nothing is posted to Instagram.
        const row = await env.DB.prepare("SELECT url, title, event_date, presale_live_at, presale_timezone FROM event_directory WHERE url = ?")
          .bind(url.searchParams.get("event_url") || "")
          .first<any>();
        if (!row?.presale_live_at) return jsonResponse({ error: "no sale time for that race" }, 404);
        const draft = await createIgDraft(env, row);
        return draft ? jsonResponse(draft) : jsonResponse({ error: "that race already has a draft" }, 409);
      }
      if (url.pathname === "/admin/ig/plan-preview" && req.method === "POST") {
        // Builds Monday's carousel (kind=weekly) or Thursday's post (kind=weekend) for a date as a
        // test draft and returns its image URLs - sent to Telegram where configured, never posted.
        // kind: weekly | weekend | raceday | evergreen (with n = 0..4).
        const kind = url.searchParams.get("kind") || "weekly";
        const date = url.searchParams.get("date") || swissNow().date;
        const post =
          kind === "weekend"
            ? await weekendPost(env, date)
            : kind === "raceday"
              ? await raceDayStory(env, date)
              : kind === "evergreen"
                ? EVERGREEN_POSTS[Number(url.searchParams.get("n")) || 0]
                : await weeklyPost(env, date);
        if (!post) return jsonResponse({ error: "nothing to post for that date" }, 404);
        const id = await createScheduledDraft(env, `test-${kind}:${date}:${Date.now()}`, post, 1, `Test ${kind}`);
        const row = await env.DB.prepare("SELECT media_key FROM ig_auto_posts WHERE id = ?").bind(id).first<any>();
        const story = "story" in post && post.story;
        return jsonResponse({
          id,
          caption: post.caption,
          images: story ? [igMediaUrl(env, Number(id), row?.media_key, "story")] : post.slides.map((_, i) => igMediaUrl(env, Number(id), row?.media_key, i)),
        });
      }
      if (url.pathname === "/admin/ig/check" && req.method === "POST") {
        // Read-only: which Instagram account the token belongs to and how much posting quota is left.
        if (!env.IG_ACCESS_TOKEN) return jsonResponse({ error: "IG_ACCESS_TOKEN not set" }, 400);
        const tok = encodeURIComponent(await igToken(env));
        const me: any = await fetch(`https://graph.instagram.com/me?fields=user_id,username,account_type,media_count&access_token=${tok}`).then((r) => r.json());
        const limit = me?.user_id
          ? await fetch(`https://graph.instagram.com/${me.user_id}/content_publishing_limit?fields=config,quota_usage&access_token=${tok}`).then((r) => r.json())
          : null;
        return jsonResponse({ me, limit });
      }
      if (url.pathname === "/admin/update-email" && req.method === "POST") {
        // Same as the Telegram commands, for staging (no Telegram there): action=preview returns the
        // email as a subscriber would get it, action=start starts the batched send. Admin only.
        if ((req.headers.get("Authorization") || "") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
        const action = url.searchParams.get("action");
        if (action === "preview") {
          const s = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind((url.searchParams.get("email") || "").toLowerCase()).first<any>();
          if (!s) return jsonResponse({ error: "no such subscriber" }, 404);
          return jsonResponse(await updateEmailContent(env, s));
        }
        if (action === "start") {
          const value = { status: "sending", started_at: new Date().toISOString().replace("T", " ").slice(0, 19) };
          await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('update_email', ?)").bind(JSON.stringify(value)).run();
          await sendUpdateEmails(env);
          return jsonResponse({ ok: true, left: await updateEmailPending(env, value.started_at) });
        }
        return jsonResponse({ error: "action must be preview or start" }, 400);
      }
      if (url.pathname === "/admin/heartbeat-test" && req.method === "POST") {
        // Same write the scheduled handler does, over HTTP: tells "cron never invoked" apart from
        // "heartbeat write fails in production". Admin only.
        if ((req.headers.get("Authorization") || "") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
        await env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES (?, datetime('now'))").bind("heartbeat-test:http").run();
        const rows = await env.DB.prepare("SELECT key, value FROM kv_meta").all<any>();
        return jsonResponse({ ok: true, rows: rows.results });
      }
      if (url.pathname === "/admin/run-checks" && req.method === "POST") {
        // Runs one round of the sale + ticket checks now (incl. due free alerts). Staging has no
        // schedule, so this is how its alert ordering gets tested. Admin only.
        if ((req.headers.get("Authorization") || "") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
        await checkSaleWatches(env);
        await sendDueFreeSaleAlerts(env);
        await checkCommunityTickets(env);
        await sendDueFreeTicketAlerts(env);
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/admin/whatsapp-test" && req.method === "POST") {
        // Sends one sample alert to ADMIN_WHATSAPP so the whole path (token, number,
        // template approval) can be checked on demand. Nothing goes to subscribers.
        if ((req.headers.get("Authorization") || "") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
        if (!env.ADMIN_WHATSAPP) return jsonResponse({ error: "ADMIN_WHATSAPP not set" }, 400);
        const ok = await sendWhatsAppAlert(env, env.ADMIN_WHATSAPP, "HYROX Basel", "this is a test alert - tickets are now on sale.", `${env.SITE_URL}/`);
        const last = await env.DB.prepare("SELECT ok, error, message_id, created_at FROM whatsapp_log ORDER BY id DESC LIMIT 1").first<any>();
        return jsonResponse({ accepted: ok, last }, ok ? 200 : 502);
      }
      if (url.pathname === "/admin/check-instagram" && req.method === "POST") return await handleCheckInstagram(req, env);
      if (url.pathname === "/admin/ig-posts" && req.method === "GET") return await handleIgAdminPage(req, env);
      if (url.pathname === "/admin/ig-posts/dismiss" && req.method === "POST") return await handleIgDismiss(req, env);
      if (url.pathname === "/feedback" && req.method === "GET") return await handleFeedbackPage(req, env);
      if (url.pathname === "/partners" && req.method === "GET") return await handlePartnersPage(req, env);
      if (url.pathname === "/partners" && req.method === "POST") return await handlePartnersRequest(req, env);
      const logoMatch = url.pathname.match(/^\/partner-logo\/(\d{1,9})$/);
      if (logoMatch && req.method === "GET") return await handlePartnerLogo(env, Number(logoMatch[1]));
      if (url.pathname === "/admin/partners" && req.method === "GET") return await handlePartnersAdminPage(req, env);
      if (url.pathname === "/admin/partners/preview" && req.method === "GET") {
        // Same homepage with the sample tiles shown without their "Example" label,
        // for the admin to see how real partners will look. Token-gated, no-store,
        // noindex - visitors never get this version.
        if ((url.searchParams.get("token") || "") !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
        const r = await handleSignupPage(req, env, true);
        r.headers.set("X-Robots-Tag", "noindex");
        return r;
      }
      if (url.pathname === "/admin/partners/decide" && req.method === "POST") return await handlePartnersDecide(req, env);
      if (url.pathname === "/feedback" && req.method === "POST") return await handleFeedback(req, env);
      if (url.pathname === "/admin/feedback" && req.method === "GET") return await handleFeedbackAdminPage(req, env);
      if (url.pathname === "/admin/subscribers" && req.method === "GET") return await handleSubscribersAdminPage(req, env);
      if (url.pathname === "/admin/analytics" && req.method === "GET") return await handleAnalyticsAdminPage(req, env);
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
    // Heartbeat: proves the schedule fired even when every check inside is refused upstream.
    ctx.waitUntil(
      env.DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES (?, datetime('now'))")
        .bind(`cron_last_run:${event.cron}`)
        .run()
        .catch((e) => console.error("heartbeat failed:", e))
    );
    // The two daily jobs are matched by their exact expression; anything else is the frequent
    // check, so the frequent trigger can be re-registered under a different expression (e.g.
    // "1-59/2 * * * *") without touching this code.
    ctx.waitUntil(ensureScheduler(env));
    if (event.cron === "0 8 * * *") {
      ctx.waitUntil(checkInstagramAnnouncements(env));
      ctx.waitUntil(sendVerificationNudges(env));
      ctx.waitUntil(sendFinalVerificationReminders(env));
      ctx.waitUntil(sendDailyIgPostReminder(env));
    } else if (event.cron === "0 3 * * *") {
      ctx.waitUntil(indexEvents(env).then(() => undefined));
      ctx.waitUntil(env.DB.prepare("DELETE FROM email_log WHERE created_at < datetime('now', '-90 days')").run());
      ctx.waitUntil(env.DB.prepare("DELETE FROM whatsapp_log WHERE created_at < datetime('now', '-90 days')").run());
      ctx.waitUntil(env.DB.prepare("DELETE FROM telegram_log WHERE created_at < datetime('now', '-90 days')").run());
    } else {
      // If the alarm scheduler is alive it already runs these every two minutes; don't double up.
      ctx.waitUntil(
        env.DB.prepare("SELECT value FROM kv_meta WHERE key = 'alarm_last_run' AND value >= datetime('now', '-3 minutes')")
          .first<any>()
          .then((alive) => (alive ? undefined : runFrequentChecks(env)))
      );
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleIncomingEmail(message, env));
  },
};

export default worker;
