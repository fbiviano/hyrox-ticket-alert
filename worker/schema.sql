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
