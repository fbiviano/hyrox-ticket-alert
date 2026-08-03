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

- **One uniform flow for everyone, including you**: paste any HYROX event
  URL, see the real live ticket list (`GET /resolve`, backed by
  `worker/src/resolve.ts` - a TypeScript port of `monitor.py`'s resolution
  logic), pick the ticket(s) you want, enter your email. Nothing is
  pre-shown or shared between visitors - there's no "currently tracked" list
  to browse, by design (a visitor never sees what anyone else, including the
  site owner, is watching).
- **Real email verification**: a confirmation link is sent before any alerts
  start.
- **"My alerts" self-service page** (`GET /my-alerts?token=...`, linked from
  every confirmation/verify/alert email): lets a subscriber see and remove
  individual subscriptions, not just an all-or-nothing unsubscribe.
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

```bash
cd worker
npx wrangler d1 execute roxracealerts-db --remote --command "SELECT email, verified FROM subscribers"
```

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
