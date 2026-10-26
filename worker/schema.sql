CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  unsubscribe_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set the one time a "you haven't confirmed yet" nudge email goes out
  -- (see sendVerificationNudges() in src/index.ts) - stops it from being
  -- sent more than once per subscriber. Irrelevant once verified = 1.
  nudge_sent_at TEXT,
  -- Set when the admin switched a subscriber's alerts on by hand instead of
  -- the subscriber clicking their confirmation link (UPDATE ... SET
  -- verified = 1, manually_verified_at = datetime('now')). The cron then
  -- sends them one "your alerts are now active" email with a one-click
  -- unsubscribe (sendManualVerificationNotices() in src/index.ts) and stamps
  -- manual_verify_email_sent_at.
  manually_verified_at TEXT,
  manual_verify_email_sent_at TEXT,
  -- Set when the one "last reminder" (5 days after signup, for anyone who
  -- ignored the nudge) has gone out - see sendFinalVerificationReminders().
  final_nudge_sent_at TEXT,
  -- WhatsApp alerts (see "WhatsApp: subscriber opt-in" in src/index.ts).
  -- whatsapp_phone: digits only, set when the subscriber sends "START <code>"
  -- from that phone; NULL = not linked. whatsapp_code(+_expires): the one-off
  -- 30-minute handshake code shown on My alerts. whatsapp_opted_out_at: last
  -- STOP / "turn off". Alerts only go to a non-NULL whatsapp_phone.
  whatsapp_phone TEXT,
  whatsapp_linked_at TEXT,
  whatsapp_code TEXT,
  whatsapp_code_expires TEXT,
  whatsapp_opted_out_at TEXT,
  -- When this subscriber's phone last messaged us (any message). For 23 hours after
  -- that we may send normal (non-template) messages; see sendWhatsAppAlert.
  whatsapp_last_inbound_at TEXT,
  -- Telegram alerts (see "Telegram: subscriber opt-in" in src/index.ts): the chat id
  -- is stored when the subscriber presses Start on t.me/<bot>?start=<code>. The code is
  -- the same one-off 30-minute handshake as WhatsApp's. NULL chat id = not linked.
  telegram_chat_id TEXT,
  telegram_linked_at TEXT,
  telegram_code TEXT,
  telegram_code_expires TEXT,
  telegram_opted_out_at TEXT,
  -- WhatsApp waitlist (before launch): number left on My alerts or at Priority checkout, digits
  -- with country code, unverified. At launch each gets one template asking them to reply START,
  -- which proves the number and moves it to whatsapp_phone. whatsapp_marketing_ok = the separate,
  -- unticked-by-default "occasional news" consent.
  whatsapp_waitlist_phone TEXT,
  whatsapp_waitlist_at TEXT,
  whatsapp_marketing_ok INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  ticket_name TEXT NOT NULL,
  shop_url TEXT,
  event_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set once the subscriber tells us (via the "I bought this" button on
  -- /my-alerts) they've already purchased - stops further availability
  -- alerts for just this one subscriber (others watching the same
  -- event_name/ticket_name are unaffected) and moves the row into the
  -- "Purchased" section instead of "Your watched tickets".
  purchased_at TEXT,
  UNIQUE(subscriber_id, event_name, ticket_name)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_ticket ON subscriptions(event_name, ticket_name);

-- Tickets anyone has resolved/subscribed to via the public "paste any URL"
-- flow, separate from the curated config.json list. Checked by the Worker's
-- own Cron Trigger (see scheduled() in src/index.ts), independent of the
-- Python/GitHub Actions pipeline that checks the curated list.
CREATE TABLE IF NOT EXISTS community_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  ticket_name TEXT NOT NULL,
  shop_url TEXT NOT NULL,
  last_status TEXT NOT NULL DEFAULT 'sold_out',
  event_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Priority: when this ticket came back and Season Priority holders were told first,
  -- free_alert_after is when everyone else is due (NULL once sent / nobody held back).
  detected_at TEXT,
  free_alert_after TEXT,
  UNIQUE(event_id, ticket_name)
);

-- Directory of known HYROX event pages (city/event name -> URL), built by
-- periodically crawling https://hyrox.com/event-sitemap.xml in small
-- batches (see the indexing job in scheduled(), src/index.ts) so people can
-- search by city name instead of pasting an exact URL.
CREATE TABLE IF NOT EXISTS event_directory (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  event_date TEXT,
  on_sale INTEGER NOT NULL DEFAULT 0,
  last_sale_check TEXT,
  -- Set once, the first time on_sale flips to true while the row was
  -- genuinely being counted down (a known presale_live_at or an active
  -- pre-sale) - never overwritten on later re-checks, and left NULL for
  -- events whose shop was simply already open when first discovered. Lets
  -- the sidebar keep a just-opened sale in "Live now" for a few days
  -- instead of it vanishing straight into the flat "On sale now" list,
  -- without also flooding that box with every already-on-sale event.
  on_sale_since TEXT,
  -- Same best-effort Instagram-derived info as sale_watch, but shown to
  -- *everyone* browsing the homepage list, not just people who set up a
  -- specific "notify me" watch.
  presale_note TEXT,
  presale_live_at TEXT,
  -- IANA zone (e.g. "Europe/Rome") Claude inferred for presale_live_at -
  -- lets every display of that timestamp show the event's own local time
  -- instead of UTC/GMT, which reads as a foreign, confusing time to most
  -- people.
  presale_timezone TEXT,
  -- True when Claude judged the caption to mean something is buyable RIGHT
  -- NOW (an open early-access/gym link, or the sale itself already live),
  -- as opposed to merely announcing a future date. Splits the browse list
  -- into "live now" vs "going live soon" instead of one flat bucket.
  presale_is_live INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_directory_title ON event_directory(title);
CREATE INDEX IF NOT EXISTS idx_event_directory_date ON event_directory(event_date);

-- Events someone wants to be told about the moment ticket sales open
-- (resolveEvent() currently fails for them - no vivenu shop live yet).
-- Checked alongside community_tickets in the 2-minute Cron Trigger.
CREATE TABLE IF NOT EXISTS sale_watch (
  event_url TEXT PRIMARY KEY,
  event_title TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  event_date TEXT,
  -- Best-effort info from a matched Instagram announcement (see
  -- ig_flagged_posts below) - shown on /my-alerts instead of a bare "not
  -- yet on sale" once we know a pre-sale is live and/or when the public
  -- sale is expected. presale_live_at is a UTC guess, not a guarantee.
  presale_note TEXT,
  presale_live_at TEXT,
  presale_timezone TEXT,
  presale_is_live INTEGER NOT NULL DEFAULT 0,
  -- Priority alerts: when the shop is detected live and someone holds Priority for this race,
  -- paid watchers are alerted at once and free ones after PRIORITY_FREE_DELAY_MINUTES.
  -- detected_at = when we saw it live; free_alert_after = when the free alert is due
  -- (NULL once sent, or when nobody was held back).
  detected_at TEXT,
  free_alert_after TEXT,
  -- When checkSaleWatches last got an answer for this race; it checks longest-unchecked first.
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_watchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  event_url TEXT NOT NULL REFERENCES sale_watch(event_url) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subscriber_id, event_url)
);

-- A paid per-race Priority pass (Stripe Checkout, one-off): the subscriber is alerted before
-- free watchers of the same race. Written only by the signed Stripe webhook.
CREATE TABLE IF NOT EXISTS race_priority (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  event_url TEXT NOT NULL,
  event_title TEXT NOT NULL,
  stripe_session_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  -- Answer to the optional "Want WhatsApp alerts when they launch?" question at checkout.
  wants_whatsapp INTEGER NOT NULL DEFAULT 0,
  -- The shop's own event name, filled in when the race goes on sale, so this pass also covers
  -- the race's sold-out ticket watches (which are keyed by that name).
  event_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subscriber_id, event_url)
);

-- A paid per-event Priority pass for ticket watches: emailed first when sold-out tickets of
-- that event come back. Keyed by subscriptions.event_name. Written only by the Stripe webhook.
CREATE TABLE IF NOT EXISTS ticket_priority (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  stripe_session_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  wants_whatsapp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subscriber_id, event_name)
);

-- A paid Season Priority pass (Stripe Checkout, one-off): Priority on every race the
-- subscriber watches, and on sold-out tickets coming back, until valid_until.
CREATE TABLE IF NOT EXISTS season_pass (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  season TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  stripe_session_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  wants_whatsapp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subscriber_id, season)
);

-- Remembers the last-seen post per tracked HYROX country/region Instagram
-- account (checked daily via Apify - see checkInstagramAnnouncements() in
-- src/index.ts) so only genuinely new posts get evaluated, not the whole
-- feed every time.
CREATE TABLE IF NOT EXISTS ig_watch (
  handle TEXT PRIMARY KEY,
  last_post_id TEXT,
  last_checked_at TEXT
);

-- Every genuinely new Instagram post from a tracked account. Claude reads
-- the caption and decides whether to auto-publish (see
-- checkInstagramAnnouncements() in src/index.ts) - this table doubles as
-- the publish log and, via live_at_utc + the reminder_* flags, the source
-- for the countdown-reminder emails sent as a matched event's expected
-- go-live time approaches.
CREATE TABLE IF NOT EXISTS ig_flagged_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  post_id TEXT NOT NULL,
  post_url TEXT NOT NULL,
  caption TEXT,
  -- Legacy: which upstream keyword ("pre-sale", "on sale"...) triggered AI
  -- review, back when a keyword pre-filter gated every check. Removed -
  -- non-English captions and future-tense announcements slipped past it -
  -- so every new post now goes straight to the AI. Column kept only so
  -- historic rows keep their original value; never written to anymore.
  matched_keyword TEXT,
  posted_at TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  banner_text TEXT,
  -- Which sale_watch/event_directory event this announcement is about, as
  -- matched by Claude. When set, publishing also emails everyone watching
  -- that event directly - this is often the *only* signal available (e.g.
  -- a gym-only pre-sale uses a private link resolveEvent() can't see), so
  -- it doesn't touch sale_watch.resolved the way a real detected public
  -- sale does.
  event_url TEXT,
  -- Best-effort UTC timestamp of when the caption says the (pre-)sale
  -- goes live, if it says one at all. Drives the countdown reminders
  -- below; null means "no specific time mentioned", not "never".
  live_at_utc TEXT,
  live_at_timezone TEXT,
  presale_is_live INTEGER NOT NULL DEFAULT 0,
  reminder_1d_sent INTEGER NOT NULL DEFAULT 0,
  reminder_1h_sent INTEGER NOT NULL DEFAULT 0,
  reminder_5m_sent INTEGER NOT NULL DEFAULT 0,
  reminder_0m_sent INTEGER NOT NULL DEFAULT 0,
  UNIQUE(handle, post_id)
);

-- One row per countdown reminder step already sent (1d / 1h / 5m / 0m before
-- an announced go-live time), keyed by event and the announced time in
-- 10-minute buckets. checkAnnouncementReminders() (src/index.ts) inserts
-- here first and only emails when the insert actually added a row, so a
-- reminder can never repeat - and it covers Instagram posts AND newsletters
-- under one countdown per event. Replaces the reminder_*_sent flags on
-- ig_flagged_posts, which are no longer read (kept so history survives).
CREATE TABLE IF NOT EXISTS countdown_sent (
  event_url TEXT NOT NULL,
  live_key INTEGER NOT NULL,
  step TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_url, live_key, step)
);

-- Every incoming email to alerts@roxracealerts.com (see the email() handler
-- in src/index.ts), read via Cloudflare Email Routing once the admin
-- subscribes that address to each regional HYROX newsletter. Same
-- read-and-match role as ig_flagged_posts, just fed newsletter bodies
-- instead of Instagram captions through the same AI parser
-- (parseAnnouncementWithAI) - newsletters are first-party and structured,
-- so this is expected to be a more reliable signal than scraping captions.
-- message_id (the email's own Message-ID header) guards against Cloudflare
-- ever redelivering the same message.
CREATE TABLE IF NOT EXISTS newsletter_flagged_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  from_address TEXT NOT NULL,
  subject TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  banner_text TEXT,
  event_url TEXT,
  live_at_utc TEXT,
  live_at_timezone TEXT,
  presale_is_live INTEGER NOT NULL DEFAULT 0,
  -- Diagnostics for tryAutoConfirmSubscription() (src/index.ts) - the link
  -- it found and GETed (if the subject looked like a double opt-in email)
  -- and whether that request came back ok. Without these, a failed
  -- auto-confirm was only ever visible in the one-off Telegram ping at the
  -- moment it happened, with nothing left to inspect afterward.
  confirm_link TEXT,
  confirm_result TEXT,
  UNIQUE(message_id)
);

-- Gyms and brands shown as small tiles in the homepage sidebar ("Gyms &
-- partners"). url must be https and is only ever reached through
-- /out/<id>, which counts the click; logo_url is optional (https) - tiles
-- without one show the name's first letter on the brand gradient. Added and
-- paused by the admin with SQL; sort_order lowest first.
CREATE TABLE IF NOT EXISTS sponsors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'gym',
  tagline TEXT,
  -- Shown on the tile above the pitch, e.g. 'Zurich, Switzerland'.
  location TEXT,
  url TEXT NOT NULL,
  logo_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- 1 = a clearly labelled "Example" sample tile (links to /partners, no
  -- tracking, never counted against the 10 spots, hidden once real tiles
  -- reach half the spots). Never presented as a real partner.
  is_example INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-tile, per-day views and clicks (UTC day). Views are counted when the
-- homepage renders with the tile showing; both skip obvious bots by
-- user-agent, so they are approximate. Shown on /admin/analytics.
CREATE TABLE IF NOT EXISTS sponsor_stats (
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sponsor_id, day)
);

-- Applications for a homepage partner tile (POST /partners), logo included
-- as base64 (validated PNG/JPEG/WebP, max 256 KB). status: pending ->
-- approved (a sponsors row exists: live, or inactive until payment is
-- confirmed) or rejected. The logo is only ever served for a live tile
-- (/partner-logo/<sponsor id>); the admin reviews it inline on
-- /admin/partners. Rejecting or removing deletes the sponsors row.
CREATE TABLE IF NOT EXISTS partner_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'gym',
  -- 'top' if they asked for the single premium top position, else 'any'.
  -- Only a preference shown to the admin; ordering is set by hand.
  placement TEXT NOT NULL DEFAULT 'any',
  link TEXT NOT NULL,
  tagline TEXT,
  location TEXT,
  email TEXT NOT NULL,
  message TEXT,
  logo_type TEXT,
  logo_b64 TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  sponsor_id INTEGER REFERENCES sponsors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_partner_applications_status ON partner_applications(status);

-- One row per Telegram message we sent (alerts and the /start, /stop replies). A 403 from
-- Telegram means the person blocked the bot - their link is cleared automatically.
CREATE TABLE IF NOT EXISTS telegram_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per WhatsApp alert attempt (sendWhatsAppAlert in src/index.ts). ok = 1 means
-- Meta accepted the message; message_id is the wamid later delivery/read webhooks
-- refer to. Failures (unapproved template, expired token, number not on the allowed
-- list) land here with Meta's error text instead of vanishing.
CREATE TABLE IF NOT EXISTS whatsapp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_number TEXT NOT NULL,
  template TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  message_id TEXT,
  -- Latest delivery receipt from Meta's webhook for this message: sent, delivered,
  -- read or failed (ok = 1 only means Meta accepted it).
  delivery_status TEXT,
  status_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per outgoing email attempt (written by sendEmail() in
-- src/index.ts), so "did this person actually get the alert?" can be
-- answered after the fact from /admin/analytics. ok = 1 means Resend
-- accepted the message (HTTP 2xx) - it says nothing about inbox delivery,
-- bounces or spam placement, which only Resend's own dashboard shows.
-- Before this table existed a failed send was only a console.error, and
-- the watch it belonged to had already been marked resolved, so a failure
-- left no trace anywhere.
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);
CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log(to_address);

-- Free-text feedback/feature requests submitted via /feedback. Private -
-- nothing here is shown to other visitors. Each submission also emails
-- ADMIN_EMAIL immediately (see handleFeedback() in src/index.ts); this
-- table is just the durable log behind /admin/feedback.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A hand-prepared queue of Instagram post graphics for the site's own
-- @roxracealerts-style account - not user-facing, purely a personal
-- posting-reminder tool for the admin. day_number is the upload order
-- (matches the branding/ig-posts/DayN_*.png filenames); image_base64 is
-- the same PNG's bytes, stored here so sendDailyIgPostReminder() can
-- attach it to a Telegram message directly (the Worker has no access to
-- local files on the admin's machine). posted_at is set the moment a
-- day's reminder is sent - this is a one-shot notifier, not a tracker of
-- whether the admin actually uploaded it to Instagram.
CREATE TABLE IF NOT EXISTS ig_post_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_number INTEGER NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  caption TEXT NOT NULL,
  hashtags TEXT NOT NULL,
  image_base64 TEXT NOT NULL,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value store for operational facts, e.g. cron_last_run:<cron expr> = when that
-- schedule last fired (written on every run, see scheduled() in src/index.ts).
CREATE TABLE IF NOT EXISTS kv_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Ticket shop of each directory race (e.g. https://gb.hyrox.com/event/...), filled in once found.
-- Lookups go there directly: hyrox.com rate-limits Cloudflare, the country shops don't.
-- (Column added to event_directory by migration on 2026-10-26.)
-- ALTER TABLE event_directory ADD COLUMN shop_url TEXT;

-- Instagram "GOING LIVE SOON" drafts (one per race). Sent to the admin's Telegram with
-- [Post now] / [Skip]; nothing is posted without that tap. media_key is random and part of the
-- public image URL (/ig-media/<id>-<key>.jpg) and of the button data.
-- status: pending | posting | posted | skipped | expired | failed (Telegram send failed)
CREATE TABLE IF NOT EXISTS ig_auto_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_url TEXT NOT NULL UNIQUE,
  presale_live_at TEXT NOT NULL,
  card_json TEXT NOT NULL,
  caption TEXT NOT NULL,
  media_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  ig_media_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  -- After posting, the same card goes up as a story (no link sticker - the API can't add one).
  story_status TEXT, -- NULL (not yet) | posting | posted | failed
  story_media_id TEXT,
  story_error TEXT
);

-- Referrals (2026-10-26): ref_code = the subscriber's personal link code (/?ref=CODE, created on
-- first use); referred_by = who invited this subscriber; referral_level = reward reached
-- (0 none, 1 Season Priority at 5 friends, 2 Priority for life at 10). Rewards are season_pass
-- rows with livemode = 2 (granted, not sold). update_email_sent_at = the one-off update email.
-- ALTER TABLE subscribers ADD COLUMN ref_code TEXT;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_ref_code ON subscribers(ref_code);
-- ALTER TABLE subscribers ADD COLUMN referred_by INTEGER;
-- ALTER TABLE subscribers ADD COLUMN referral_level INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE subscribers ADD COLUMN update_email_sent_at TEXT;

-- Email analytics (2026-10-26): email_log.resend_id = Resend's id for the email; email_events =
-- first event of each type Resend reported for it (delivered, opened, clicked, bounced,
-- complained, ...) via /resend/webhook.
-- ALTER TABLE email_log ADD COLUMN resend_id TEXT;
-- CREATE INDEX IF NOT EXISTS idx_email_log_resend ON email_log(resend_id);
CREATE TABLE IF NOT EXISTS email_events (
  resend_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resend_id, type)
);
