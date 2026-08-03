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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_directory_title ON event_directory(title);

-- Events someone wants to be told about the moment ticket sales open
-- (resolveEvent() currently fails for them - no vivenu shop live yet).
-- Checked alongside community_tickets in the 2-minute Cron Trigger.
CREATE TABLE IF NOT EXISTS sale_watch (
  event_url TEXT PRIMARY KEY,
  event_title TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
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
