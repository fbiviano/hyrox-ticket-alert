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
  nudge_sent_at TEXT
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
  UNIQUE(handle, post_id)
);

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
