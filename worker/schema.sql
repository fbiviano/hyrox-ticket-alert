CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  unsubscribe_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  ticket_name TEXT NOT NULL,
  shop_url TEXT,
  event_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
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

-- New Instagram posts whose caption matched a ticket-sale keyword, queued
-- for a human (admin) to approve into a homepage banner or dismiss -
-- keyword matching alone isn't reliable enough to auto-publish.
CREATE TABLE IF NOT EXISTS ig_flagged_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  post_id TEXT NOT NULL,
  post_url TEXT NOT NULL,
  caption TEXT,
  matched_keyword TEXT,
  posted_at TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  banner_text TEXT,
  -- Optional: which sale_watch event this announcement is about, picked by
  -- the admin at review time. When set, approving also emails everyone
  -- watching that event directly, not just the homepage banner - this is
  -- often the *only* signal available (e.g. a gym-only pre-sale uses a
  -- private link resolveEvent() can't see), so it doesn't touch
  -- sale_watch.resolved the way a real detected public sale does.
  event_url TEXT,
  UNIQUE(handle, post_id)
);
