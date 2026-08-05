# Hyrox / vivenu ticket-availability monitor

A small local tool that watches specific tickets on vivenu-powered ticket shops
(the system used by hyrox.com and others) and pings you on Telegram the moment
a sold-out ticket becomes available again. Runs on your own PC, no login, no
account, no web app — just a Python script you run yourself.

It works in two steps:
1. `python monitor.py add <url>` — you give it a page (e.g. an event page on
   hyrox.com), it finds the vivenu shop behind it, lists every ticket with its
   current status, and you pick which ones to watch.
2. `python monitor.py check` — re-checks all watched tickets and Telegrams you
   the instant one flips from **SOLD OUT** to **AVAILABLE**. You schedule this
   to run automatically (see the Task Scheduler section below).

---

## 1. One-time setup

You already have Python 3.13 installed on this machine. From this folder, run:

```bash
python -m pip install -r requirements.txt
python -m playwright install chromium
```

The second command downloads a headless Chromium browser (~300 MB). It's only
used as a fallback if a shop's ticket data can't be read directly — most of
the time it's never triggered, but it needs to be installed once up front.

---

## 2. Set up Telegram alerts

This is the part that lets the tool message you on Telegram. It sounds
technical but it's really just: create a bot (a few taps), send it a message,
then paste two things into a text file. Takes about 5 minutes. Go slowly,
step by step — don't skip ahead.

### Step 1 — Create your bot

A "bot" here just means a Telegram account that can send you messages
automatically. You create it by talking to Telegram's official bot-making
bot, called BotFather.

1. Open the **Telegram app** (on your phone or computer — either works).
2. Tap the **search icon** (magnifying glass) at the top.
3. Type `BotFather` and tap on the result called **BotFather** — it has a
   blue verified checkmark next to it. Make sure it's exactly `BotFather`,
   not a lookalike.
4. Tap **Start** at the bottom of the chat (or type `/start` and send it).
5. Now type exactly `/newbot` and send it.
6. It will ask for a **name** — this is just the display name, type anything
   you like, for example `My Ticket Alerts`, and send it.
7. It will then ask for a **username** — this one must be unique and must
   end in the word `bot`, for example `francesco_ticket_alerts_bot`. Type
   one and send it. If it says that username is taken, just try a different
   one (add some numbers, e.g. `francesco_ticket_alerts_2026_bot`).
8. BotFather will reply with a "Congratulations" message containing a long
   line of letters and numbers with a colon in it, like this:
   ```
   123456789:AAHk3jX9abcDEFghiJKLmnoPQRstuVWxyz
   ```
   **This whole line is your bot token.** Tap and hold it to copy it, or
   select and copy it, and paste it somewhere safe for a moment (like a
   Notepad window) — you'll need it in Step 3.

### Step 2 — Get your chat ID

Now you need to tell the tool *who* to message — that's your "chat ID", just
a number that identifies you.

1. In Telegram, use the **search icon** again and search for the bot
   username you picked in Step 1 (e.g. `francesco_ticket_alerts_bot`).
2. Open a chat with it and send it **any message**, like `hello`. (It won't
   reply — that's normal, it doesn't do anything yet.)
3. Open a web browser (Chrome/Edge) on your computer.
4. In the address bar, type this, but **replace `PASTE_YOUR_TOKEN_HERE` with
   the token you copied in Step 1** (keep everything else exactly as is),
   then press Enter:
   ```
   https://api.telegram.org/botPASTE_YOUR_TOKEN_HERE/getUpdates
   ```
   For example, if your token was `123456789:AAHk3jX9abcDEFghiJKLmnoPQRstuVWxyz`,
   you would go to:
   `https://api.telegram.org/bot123456789:AAHk3jX9abcDEFghiJKLmnoPQRstuVWxyz/getUpdates`
5. The page will show a wall of text like this:
   ```
   {"ok":true,"result":[{"update_id":..., "message":{... "chat":{"id":987654321,"first_name":"Francesco",...} ...}}]}
   ```
   Find the part that says `"chat":{"id":` — the number right after it
   (`987654321` in this example) is **your chat ID**. Copy just that number.

   If instead you see `{"ok":true,"result":[]}` (an empty list), it means
   Telegram hasn't seen your "hello" message yet — go back to step 2, make
   sure you actually sent a message to the bot, then reload the browser page.

### Step 3 — Save both into the `.env` file

Now you'll put the token and chat ID into a file the tool reads.

1. Open the `hyrox-alert` folder in File Explorer.
2. Find the file named **`.env.example`**, right-click it, choose **Copy**,
   then right-click in empty space in the same folder and choose **Paste**.
   This makes a copy called `.env.example - Copy` (or similar).
3. Rename that copy to exactly **`.env`** (just `.env`, nothing before the
   dot, nothing after). Windows may warn you about changing a file extension
   — click Yes/OK to confirm.
4. Right-click the new `.env` file and open it with **Notepad**.
5. It contains two empty lines. Fill them in so it looks like this (using
   *your own* token and chat ID from Steps 1 and 2, not these examples):
   ```
   TELEGRAM_BOT_TOKEN=123456789:AAHk3jX9abcDEFghiJKLmnoPQRstuVWxyz
   TELEGRAM_CHAT_ID=987654321
   ```
   No quotes, no spaces around the `=`, nothing else in the file.
6. Save the file (Ctrl+S) and close Notepad.

That's it — the tool will now be able to message you. `.env` is listed in
`.gitignore`, meaning it's treated as a private file that's never meant to be
shared with anyone or uploaded anywhere.

---

## 2b. (Optional) Also get alerts by email

Telegram alone is enough - only do this if you'd like a backup channel or
just prefer email. This uses your own Gmail account to send the email, so
it's free and needs no new signup.

1. Go to **[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)**
   and sign in if asked. (If you don't see this page, your account needs
   2-Step Verification turned on first - Google will prompt you to enable it
   at **[myaccount.google.com/security](https://myaccount.google.com/security)**,
   then come back to the App Passwords link above.)
2. Under "App name", type something like `hyrox-alert` and click **Create**.
3. Google shows a 16-character password (four groups of 4 letters, e.g.
   `abcd efgh ijkl mnop`). Copy it - this is **not** your normal Gmail
   password, and Google only shows it once.
4. Open your `.env` file in Notepad and add these three lines (using your
   own Gmail address and the app password you just copied, with the spaces
   removed):
   ```
   EMAIL_FROM=youraddress@gmail.com
   EMAIL_APP_PASSWORD=abcdefghijklmnop
   EMAIL_TO=youraddress@gmail.com
   ```
   `EMAIL_TO` is who receives the alert - use the same address to email
   yourself, or a different address if you'd rather it land somewhere else.
5. Save and close.

That's it - `check` will now email you (in addition to Telegram) every time
a watched ticket becomes available.

---

## 3. Add an event to watch

```bash
python monitor.py add "https://hyrox.com/event/hyrox-rome/"
```

This prints something like:

```
Event: HYROX Rome | Season 26/27
Shop URL: https://italy.hyrox.com/event/hyrox-rome-season-26-27-ny5kx9?useEmbed=true

    1. [SOLD OUT ] HYROX MEN | Thursday
    2. [SOLD OUT ] HYROX WOMEN | Thursday
    3. [AVAILABLE] CHARITY | HYROX WOMEN | Thursday
    9. [AVAILABLE] HYROX PRO MEN | Friday
   14. [AVAILABLE] CHARITY | HYROX PRO MEN | Friday
   ...

Which tickets do you want to monitor? (comma-separated numbers, or 'all'):
```

Type the numbers you care about (e.g. `9,14`) or `all`, press Enter, and
they're saved to `config.json` with their exact full names — so "HYROX PRO
MEN | Friday" and "CHARITY | HYROX PRO MEN | Friday" are tracked as the
distinct tickets they are.

Run `add` again with a different URL any time to watch more events — it
merges into the same `config.json` rather than overwriting it.

Other commands:

```bash
python monitor.py list      # show everything you're watching and its last known status
python monitor.py remove    # stop watching one or more tickets
python monitor.py check     # run one check cycle right now
```

---

## 4. Test it once by hand

```bash
python monitor.py check
```

This checks every watched ticket, logs a line per ticket (with a timestamp)
to `logs/monitor.log`, and sends a Telegram message only for tickets that just
flipped from sold out to available. On a normal run with nothing changed,
you'll see `0 alert(s) sent` — that's expected, it only alerts on the
transition, not on every "still available" check.

---

## 5. Schedule automatic checks

You have two options. Task Scheduler is recommended for actually leaving this
running day-to-day; `watch` is handy for quick testing.

### Option A — Windows Task Scheduler (recommended)

This runs `check` every 5 minutes in the background — no window has to stay open.

1. Open **Task Scheduler** (search for it in the Start menu).
2. Click **Create Task...** (not "Create Basic Task", so you get the repeat-indefinitely option).
3. **General tab**: name it e.g. `Hyrox ticket monitor`. Check "Run whether user is logged on or not" if you want it to run even when locked (you'll be asked for your Windows password once).
4. **Triggers tab** → **New...**:
   - Begin the task: *On a schedule*
   - Settings: *Daily*, starting now
   - Check **Repeat task every: 5 minutes**, **for a duration of: Indefinitely**
   - Click OK.
5. **Actions tab** → **New...**:
   - Action: *Start a program*
   - Program/script: the full path to `python.exe` — find it by running `(Get-Command python).Source` in PowerShell
   - Add arguments: `monitor.py check`
   - Start in: the full path to this folder, e.g. `C:\Users\user\OneDrive - Arcton Switzerland AG\hyrox-alert`
   - Click OK.
6. **Conditions tab**: uncheck "Start the task only if the computer is on AC power" if this is a laptop you want checking on battery too.
7. Click OK to save.

Check `logs/monitor.log` after a few minutes to confirm it's running.

### Option B — leave a terminal open

```bash
python monitor.py watch
```

Checks every 5 minutes by default. Change with `--interval-minutes`, e.g.
`python monitor.py watch --interval-minutes 2`. Stops if you close the window,
log off, or the PC sleeps — Task Scheduler doesn't have that problem.

---

## 6. If a shop can't be auto-resolved (manual endpoint capture)

`add` works by finding the vivenu shop linked from the page you give it. Most
shops embed a link vivenu itself renders; if a shop is structured differently
and auto-resolution fails, you can find the right URL yourself from your
browser's Network tab and hand it to `add` directly:

1. Open the ticket page in Chrome/Edge and open **DevTools** (F12).
2. Click through to the actual ticket-buying flow (click "Buy tickets" or
   similar) until the browser's address bar shows a URL containing
   **`/checkout/`** followed by a long ID, e.g.
   `https://italy.hyrox.com/checkout/69c15f9717adbb5c17e9c3b5` — that's the
   real vivenu checkout page for this event.
3. Copy that URL and run:
   `python monitor.py add "<that URL>"`

   This works even if the shop uses its own custom domain (like
   `italy.hyrox.com`) instead of `vivenu.com` directly.

---

## 7. Public signup site — roxracealerts.com

Besides your own personal Telegram/email alerts, anyone can subscribe to
alerts for any HYROX ticket at **[roxracealerts.com](https://roxracealerts.com)**.
This is a separate, self-contained system with its own database - it doesn't
read `config.json` or otherwise know about anything you're personally
tracking, and your own alerts (Telegram/email via `monitor.py`) work exactly
as before, untouched by any of this.

- **One uniform flow for everyone, including you**: type a city name (or
  paste a full HYROX event URL directly) to find the event, see the real
  live ticket list (`GET /resolve`, backed by `worker/src/resolve.ts` - a
  TypeScript port of `monitor.py`'s resolution logic), pick the ticket(s)
  you want, enter your email. Nothing is pre-shown or shared between
  visitors - there's no "currently tracked" list to browse, by design (a
  visitor never sees what anyone else, including the site owner, is
  watching).
- **City-name search**: `GET /search-events` matches against
  `event_directory`, a cache of all ~116 current HYROX event pages' titles,
  built by crawling `hyrox.com/event-sitemap.xml` in small batches via a
  separate daily Cron Trigger (`indexEvents()` in `worker/src/index.ts`) -
  kept small per run to stay under Cloudflare's free-plan cap of 50 outbound
  requests per invocation. `POST /admin/reindex` (same bearer-secret pattern
  as `/notify`) forces a batch on demand instead of waiting for the schedule.
- **"Notify me when tickets go on sale"**: if `/resolve` finds a real event
  page but no live vivenu shop yet, the signup page offers this instead of a
  dead end. Tracked in `sale_watch`/`sale_watchers` and checked by
  `checkSaleWatches()` alongside the regular 2-minute ticket cron - it just
  re-runs `resolveEvent()` and treats success (where it previously failed)
  as "tickets just went on sale." Confirmed live against a real event and a
  real cron tick, not just a manual test call.
- **Real email verification**: a confirmation link is sent before any alerts
  start.
- **"My alerts" self-service page** (`GET /my-alerts?token=...`, linked from
  every confirmation/verify/alert email): lets a subscriber see and remove
  individual subscriptions, not just an all-or-nothing unsubscribe.
- **Remembers you**: once verified, a session cookie (the same
  `unsubscribe_token` already used for email links, set `HttpOnly`/`Secure`)
  keeps you signed in - the homepage shows your current tickets directly and
  lets you add more without re-entering your email each time. Sign out via
  the link on the homepage.
- **Checking pipeline**: every subscribed ticket lands in D1's
  `community_tickets` table and is re-checked by the Worker's own Cloudflare
  Cron Trigger (`scheduled()` in `worker/src/index.ts`, every 2 minutes) -
  fully independent of, and more reliable than, the GitHub Actions schedule
  used for your own personal alerts.
- **Rate limiting**: a Cloudflare dashboard rate-limiting rule on `/subscribe`
  (Security → WAF → Rate limiting rules on the roxracealerts.com zone) guards
  against abuse - the free plan allows one such rule, used there since that's
  the endpoint with real abuse consequences (emailing strangers).

### Architecture

- **Cloudflare Workers** (free tier) — hosts the site and its small API
  (`worker/src/index.ts`): the signup page, `/resolve`, `/subscribe`,
  `/verify`, `/unsubscribe`, `/my-alerts`, `/remove-subscription`, the
  internal `/notify` webhook, and the `scheduled()` Cron Trigger handler.
- **Cloudflare D1** (free tier, SQLite) — stores subscribers, their chosen
  tickets, and community-tracked tickets (`worker/schema.sql`).
- **Resend** (free tier) — sends the verification and alert emails, from
  `alerts.roxracealerts.com` (a subdomain kept separate from the root domain
  so its sending reputation can't affect anything else on roxracealerts.com).
- Cost: $0/month at this scale (all three services' free tiers), beyond the
  domain's own yearly renewal.

### Making changes to the site

The Worker isn't redeployed automatically — after editing anything in
`worker/src/index.ts` or `worker/schema.sql`, redeploy manually:

```bash
cd worker
npx wrangler deploy
```

Secrets (`RESEND_API_KEY`, `WEBHOOK_SECRET`) are stored on Cloudflare, not in
this repo — set/update them with `wrangler secret put <NAME>`. On Windows,
pipe the value in through Bash/WSL rather than PowerShell if possible —
PowerShell's pipeline can silently prepend an invisible character to piped
input that corrupts secrets (this bit us once already).

### Checking on subscribers

`https://roxracealerts.com/admin/subscribers?token=<WEBHOOK_SECRET>` -
private, token-gated page listing every subscriber (email, verified
status, signup date, how many tickets/races they're watching, and how
many they've marked as bought - see below). Resend itself has no
subscriber list to show you - it only relays individual sends, so this
page (backed by the `subscribers` table) is the actual source of truth
for who's registered.

For anything beyond that quick list (custom filters, counts, etc.), query
D1 directly:

```bash
cd worker
npx wrangler d1 execute roxracealerts-db --remote --command "SELECT email, verified FROM subscribers"
```

**Marking a ticket as bought.** On `/my-alerts`, each watched ticket has
an "I bought this" button alongside "Remove" - clicking it sets
`purchased_at` on that one subscription row, which (a) stops further
availability alerts for that subscriber on that ticket only (other
subscribers watching the same event/ticket are unaffected), and (b)
moves it from "Your watched tickets" into a separate "Purchased" section
instead of deleting it, so there's a record. `/admin/subscribers` shows
the aggregate ("N of M watched tickets marked as bought") and a per-
subscriber count, as a rough sense of how many alerts actually convert.

### Telegram mirroring for your own alerts

If `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set (same bot/chat as the
original personal checker - see "Set up Telegram alerts" above), every
alert email the site sends to `ADMIN_EMAIL` specifically - ticket became
available, a watched race's sale just went live, an Instagram pre-sale
announcement matched a watched race, or a countdown reminder - is also
mirrored to Telegram. Other subscribers never receive Telegram messages;
this is purely a personal secondary channel for the site owner's own
watched tickets, keyed off `notifyAdminTelegram()` in `src/index.ts`
checking the recipient against `ADMIN_EMAIL` on every send. If either
secret is unset, alerts are simply email-only, same as before.

### Instagram ticket-announcement watcher

HYROX country/region Instagram accounts (e.g. `@hyroxitalia`) usually
announce ticket sales days to weeks before hyrox.com's own pages reflect
it, so a daily check (`0 8 * * *` Cron Trigger) asks
[Apify's Instagram Post Scraper](https://apify.com/apify/instagram-post-scraper)
for each tracked account's latest post. Every genuinely new post (not
just ones matching a keyword - an earlier version pre-filtered by phrases
like "ticket sale"/"secret shop", but that missed non-English captions and
future-tense announcements like "Tickets Are Almost Here") gets sent to
Claude (the Anthropic API) to read - captions are in whatever language
that country speaks - and decide whether it's genuinely a race ticket-sale
announcement, producing a short English summary plus (when it can
confidently tell) which known HYROX event it's about. The
result is **published automatically**: it shows up in a "Recent
ticket-sale news" section on the homepage, and if it matched an event
someone's watching via "notify me when on sale", they're emailed directly
too. No approval step - the admin log at `/admin/ig-posts` is for
after-the-fact visibility and retracting a bad publish, not a gate.

- Tracked accounts: the `IG_HANDLES` list in `worker/src/index.ts` —
  edit and redeploy to add/remove one.
- Published log: `https://roxracealerts.com/admin/ig-posts?token=<WEBHOOK_SECRET>`
  — shows the last 30 auto-published announcements with a "Remove from
  homepage" button on each. You'll also get an email at the address in
  `ADMIN_EMAIL` (`wrangler.toml`) whenever something new gets published.
- Matching to a specific event doesn't mark it resolved in `sale_watch`,
  since an Instagram pre-sale announcement (e.g. a gym-only early-access
  link) often isn't the same as the real public sale being live -
  `checkSaleWatches` keeps polling the actual shop independently.
- Cost: checking ~28 accounts once a day is ~840 Apify results/month,
  comfortably inside Apify's free 2,000/month tier. The Claude API call
  runs for every genuinely new post (typically well under 28/day, since
  most accounts don't post daily), using the cheapest current model
  (`claude-haiku-4-5`) - a few cents a month at most either way.
- Secrets: `APIFY_API_TOKEN` (Apify account → Settings → API tokens) and
  `ANTHROPIC_API_KEY` (console.anthropic.com → API keys), set the same way
  as the other secrets above.
- Manual trigger for testing: `POST /admin/check-instagram` with
  `Authorization: Bearer <WEBHOOK_SECRET>`, same pattern as
  `/admin/reindex`.

**Pre-sale status and countdown reminders.** When Claude can tell the
caption states a specific date/time (e.g. "public sale opens Thursday 6
Aug at 12:00"), it converts that to an absolute UTC timestamp
(`live_at_utc`) plus the IANA timezone it inferred for the event
(`live_at_timezone`, e.g. `Europe/Rome`) - a best-effort estimate, not a
guarantee. Every display of that timestamp - emails and both web pages -
renders it back in that local timezone (`formatInTimezone()` server-side,
the same logic client-side for the homepage's fetched event list) instead
of UTC/GMT, so a Milan pre-sale reads "12:00 CEST", not a confusing GMT
time. This unlocks two things:

- **Visible to everyone**, not just people with a "notify me" watch: the
  homepage's browsable event list and `/my-alerts` split not-yet-on-sale
  events into three sections instead of one flat bucket - **Live now**
  (something is buyable right this moment: a real on-sale shop, or Claude
  judged the caption to mean an early-access/gym link or the sale itself
  is currently open - `presale_is_live`), **Going live soon** (not live
  yet, but a specific expected date/time is known - `presale_live_at`),
  and **Not on sale yet** (nothing known). Each row shows a badge plus a
  subtitle with the announcement text and, when known, "Public sale:
  <local date/time>" - via `presale_note`/`presale_live_at`/
  `presale_timezone`/`presale_is_live` on `event_directory` and
  `sale_watch`. `presale_is_live` is a separate signal from
  `presale_live_at` on purpose: a caption can say "gym pre-sale open now,
  public sale Thursday" - live *and* going-live-soon at once - so Claude
  judges "is something open right now" independently of "is there a
  future date mentioned".
- **Countdown reminder emails** to everyone watching that event: one when
  the estimated go-live time is ~1 day away, another at ~1 hour, and
  another at ~5 minutes - on top of the immediate "just announced" email.
  Driven by `checkAnnouncementReminders()` on the same 2-minute Cron
  Trigger as the ticket checks, with one-shot flags per threshold on
  `ig_flagged_posts` so each only ever fires once. This is separate from
  the real "it's actually on sale now" alert (`checkSaleWatches`, which
  polls the real shop) - these are heads-ups toward an *estimated* time,
  worded as such in the email.

Dismissing a bad match on `/admin/ig-posts` clears the associated
`presale_note`/`presale_live_at`/`presale_timezone` on both tables too, so
a retracted announcement doesn't keep showing stale info.

### Feedback

A "Have feedback? Let us know" link in the footer of every page opens
`/feedback` - a plain message box (email optional, for follow-up). Each
submission is stored in the `feedback` table and immediately emails
`ADMIN_EMAIL`. Private by design: nothing here is shown to other
visitors, there's no voting or public board.

- Inbox: `https://roxracealerts.com/admin/feedback?token=<WEBHOOK_SECRET>`
  - newest first, with a "Delete" button per entry to clean up spam.

---

## How it works, briefly

- `add` fetches the page you give it, looks for a vivenu shop link (or checks
  if the page itself is one), and confirms the event.
- Ongoing `check` (and the ticket list shown by `add`) reads live data
  straight from the shop's own **checkout page** (`/checkout/<id>` on the
  shop's domain) — this is a plain, fast HTTP request, no browser needed.
  This matters: vivenu's separate "public API" endpoint only exposes an
  admin on/off switch per ticket type, not real stock — a ticket can show as
  "on" there while genuinely being sold out to real customers. The checkout
  page is what actually drives the real "Sold out" badge a buyer sees, so
  that's the one this tool trusts.
- If that fetch ever fails (vivenu changes something, network hiccup, etc.),
  `check` automatically falls back to loading the same checkout page with a
  headless browser (Playwright) and reading the same data from the rendered
  page — this is the fallback mentioned above, and it's why Playwright is a
  dependency even though it's rarely actually used.
- A ticket counts as "sold out" when vivenu's own remaining-stock count for
  it has hit zero (or the ticket type is switched off entirely), and
  "available" otherwise — matching exactly what you'd see if you opened the
  real checkout page yourself. Alerts fire only on the sold_out → available
  transition, never on every check, so you won't get spammed for tickets
  that were already available.

## Files

- `monitor.py` — the tool.
- `config.json` — your watched events/tickets (created by `add`, not committed to git).
- `.env` — your Telegram secrets (created by you, not committed to git).
- `logs/monitor.log` — timestamped history of every check.
