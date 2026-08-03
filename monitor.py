"""
Vivenu ticket-availability monitor.

Usage:
  python monitor.py add "<page url or vivenu shop url>"
  python monitor.py list
  python monitor.py remove
  python monitor.py check
  python monitor.py watch [--interval-minutes 5]

See README.md for the full walkthrough.
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

if sys.platform == "win32":
    # Windows terminals often default to a legacy encoding that can't print
    # accented ticket names / emoji without crashing, and can't correctly
    # decode a UTF-8 BOM some shells prepend to piped input.
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
LOG_PATH = BASE_DIR / "logs" / "monitor.log"
ENV_PATH = BASE_DIR / ".env"

EVENT_ID_IN_URL_RE = re.compile(r"/api/public/events/([a-f0-9]{24})(?:\?|$)")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
HEADERS = {"User-Agent": USER_AGENT}
LINK_KEYWORDS = ["ticket", "shop", "buy", "vivenu", "useembed", "checkout", "register", "event"]


# ---------------------------------------------------------------------------
# Logging / config / Telegram
# ---------------------------------------------------------------------------

def log(line):
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().isoformat(timespec="seconds")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"{timestamp} | {line}\n")


def load_config():
    if not CONFIG_PATH.exists():
        return {"events": []}
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(config):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)


def send_telegram_message(text):
    import os

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        log("Telegram not configured (missing .env values) - alert not sent: " + text.replace("\n", " / "))
        return False
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data={"chat_id": chat_id, "text": text},
            timeout=15,
        )
        if resp.status_code != 200:
            log(f"Telegram send failed: HTTP {resp.status_code} {resp.text[:200]}")
            return False
        return True
    except requests.RequestException as e:
        log(f"Telegram send error: {e}")
        return False


def send_email_message(subject, body):
    import os
    import smtplib
    from email.mime.text import MIMEText

    email_from = os.environ.get("EMAIL_FROM")
    email_password = os.environ.get("EMAIL_APP_PASSWORD")
    email_to = os.environ.get("EMAIL_TO") or email_from

    if not email_from or not email_password:
        log("Email not configured (missing .env values) - email not sent: " + subject)
        return False

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = email_from
    msg["To"] = email_to

    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=15) as server:
            server.starttls()
            server.login(email_from, email_password)
            server.sendmail(email_from, [email_to], msg.as_string())
        return True
    except Exception as e:
        log(f"Email send error: {e}")
        return False


def notify_subscribers_webhook(event_name, ticket_name, link):
    """Fan out to public roxracealerts.com subscribers via the Cloudflare Worker."""
    import os

    webhook_url = os.environ.get("WEBHOOK_URL")
    webhook_secret = os.environ.get("WEBHOOK_SECRET")
    if not webhook_url or not webhook_secret:
        return  # public subscriber alerts not configured - not an error, just optional

    try:
        resp = requests.post(
            f"{webhook_url}/notify",
            headers={"Authorization": f"Bearer {webhook_secret}"},
            json={"event_name": event_name, "ticket_name": ticket_name, "link": link},
            timeout=15,
        )
        if resp.status_code == 200:
            sent = resp.json().get("sent", 0)
            log(f"SUBSCRIBER ALERTS SENT | {event_name} | {ticket_name} | {sent} subscriber(s)")
        else:
            log(f"Subscriber webhook failed: HTTP {resp.status_code} {resp.text[:200]}")
    except requests.RequestException as e:
        log(f"Subscriber webhook error: {e}")


def send_alert(event_name, ticket_name, link):
    """Send the same alert over every configured channel; log each independently."""
    text = f"Ticket available!\n{event_name}\n{ticket_name}\n{link}"
    subject = f"Ticket available: {ticket_name}"
    sent = False
    if send_telegram_message(text):
        sent = True
        log(f"ALERT SENT (Telegram) | {event_name} | {ticket_name}")
    if send_email_message(subject, text):
        sent = True
        log(f"ALERT SENT (Email) | {event_name} | {ticket_name}")
    notify_subscribers_webhook(event_name, ticket_name, link)
    return sent


# ---------------------------------------------------------------------------
# Vivenu event resolution
# ---------------------------------------------------------------------------

def ticket_status(ticket):
    """A ticket is sold out when its real remaining stock (the 'v' field vivenu's
    own checkout page uses) is exhausted - not merely when the admin-configured
    'active' flag is off. 'active' still gates purchasability on top of that."""
    if not ticket.get("active"):
        return "sold_out"
    remaining = ticket.get("v") or 0
    min_rule = ticket.get("minAmountPerOrderRule") or 0
    min_per_order = ticket.get("minAmountPerOrder") or 0
    if min_rule <= 1 and remaining < min_per_order:
        remaining = 0
    return "available" if remaining > 0 else "sold_out"


def checkout_url_for(shop_url, event_id):
    parsed = urlparse(shop_url)
    return f"{parsed.scheme}://{parsed.netloc}/checkout/{event_id}"


def fetch_html(url, timeout=15):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        if resp.status_code == 200:
            return resp.text
    except requests.RequestException:
        pass
    return None


def extract_next_data_event(html):
    if not html:
        return None
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    event = data.get("props", {}).get("pageProps", {}).get("event")
    if event and event.get("_id") and "tickets" in event:
        return event
    return None


def find_candidate_links(html, base_url, limit=15):
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    scored = []
    for tag_name, attr in (("a", "href"), ("iframe", "src")):
        for el in soup.find_all(tag_name):
            href = el.get(attr)
            if not href:
                continue
            abs_url = urljoin(base_url, href)
            if not abs_url.lower().startswith("http") or abs_url in seen:
                continue
            seen.add(abs_url)
            score = sum(1 for kw in LINK_KEYWORDS if kw in abs_url.lower())
            if score > 0:
                scored.append((score, abs_url))
    scored.sort(key=lambda x: -x[0])
    return [url for _, url in scored[:limit]]


def resolve_via_static(url):
    """Try to find a vivenu event by fetching plain HTML (no browser)."""
    html = fetch_html(url)
    if not html:
        return None, None
    event = extract_next_data_event(html)
    if event:
        return event, url
    for candidate in find_candidate_links(html, url):
        event = extract_next_data_event(fetch_html(candidate))
        if event:
            return event, candidate
    return None, None


def resolve_via_playwright(url):
    """Render the page with a real browser and look for the vivenu event.

    Used when the plain HTML fetch can't find anything (e.g. the shop link
    is injected by client-side JavaScript), and as the fallback data source
    when the public API call fails during a routine check.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log("Playwright not installed - skipping browser fallback. "
            "Run: pip install -r requirements.txt && playwright install chromium")
        return None, None

    captured = {}

    def on_response(response):
        m = EVENT_ID_IN_URL_RE.search(response.url)
        if m and "json" not in captured:
            try:
                body = response.json()
                if isinstance(body, dict) and "tickets" in body:
                    captured["json"] = body
                    captured["url"] = response.url
            except Exception:
                pass

    html, final_url = None, url
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(user_agent=USER_AGENT)
            page.on("response", on_response)
            try:
                page.goto(url, wait_until="networkidle", timeout=30000)
            except Exception:
                pass
            html = page.content()
            final_url = page.url
            browser.close()
    except Exception as e:
        log(f"Playwright error while loading {url}: {e}")
        return None, None

    if captured.get("json"):
        return captured["json"], final_url

    event = extract_next_data_event(html)
    if event:
        return event, final_url

    for candidate in find_candidate_links(html, final_url):
        event = extract_next_data_event(fetch_html(candidate))
        if event:
            return event, candidate

    return None, None


def resolve_event(url):
    event, shop_url = resolve_via_static(url)
    if event:
        return event, shop_url
    log(f"Static resolution failed for {url} - trying Playwright")
    return resolve_via_playwright(url)


def get_event_data(event_id, shop_url=None):
    """Fetch current ticket data, including real stock counts.

    The public marketing API (/api/public/events/{id}) only exposes an
    admin-configured 'active' on/off flag per ticket type - it does NOT
    reflect real-time sold-out state. The actual stock ('v', remaining
    volume) is only present on the shop's own checkout page
    (/checkout/{id}), server-rendered into that page's data - so that page
    is fetched directly instead. Plain HTTP first (fast, no browser);
    Playwright is the fallback if that ever stops working.
    """
    if not shop_url:
        log(f"No shop URL known for event {event_id} - cannot fetch checkout data")
        return None

    checkout_url = checkout_url_for(shop_url, event_id)
    event = extract_next_data_event(fetch_html(checkout_url))
    if event:
        return event
    log(f"Checkout page fetch failed for event {event_id} at {checkout_url}")

    log(f"Falling back to Playwright for event {event_id}")
    event, _ = resolve_via_playwright(checkout_url)
    if event:
        return event
    return None


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

def parse_selection(selection, max_n):
    selection = selection.strip().lstrip("﻿").lower()
    if selection == "all":
        return list(range(1, max_n + 1))
    indices = []
    for part in selection.split(","):
        part = part.strip()
        if part.isdigit():
            n = int(part)
            if 1 <= n <= max_n:
                indices.append(n)
    return sorted(set(indices))


def cmd_add(url):
    print(f"Resolving {url} ...")
    event, shop_url = resolve_event(url)
    if not event:
        print("\nCould not find a vivenu event on that page.")
        print("See README.md 'Manual endpoint capture' section, then re-run:")
        print('  python monitor.py add "<the vivenu shop URL you found>"')
        sys.exit(1)

    print(f"Found event: {event.get('name')}")
    print("Fetching live ticket availability from the checkout page ...")
    live_event = get_event_data(event["_id"], shop_url)
    if live_event:
        event = live_event
    else:
        print("(Could not confirm live stock - falling back to basic on/off status,")
        print(" which may not reflect real sold-out tickets. Try again shortly.)")

    tickets = event.get("tickets", [])
    if not tickets:
        print("Found the event but it has no tickets listed.")
        sys.exit(1)

    print(f"\nEvent: {event.get('name')}")
    print(f"Shop URL: {shop_url}\n")
    for i, t in enumerate(tickets, 1):
        status = "AVAILABLE" if ticket_status(t) == "available" else "SOLD OUT "
        print(f"  {i:3d}. [{status}] {t['name']}")

    selection = input("\nWhich tickets do you want to monitor? (comma-separated numbers, or 'all'): ")
    indices = parse_selection(selection, len(tickets))
    if not indices:
        print("No valid tickets selected. Nothing saved.")
        sys.exit(1)

    config = load_config()
    existing = next((e for e in config["events"] if e["event_id"] == event["_id"]), None)
    if existing is None:
        existing = {
            "source_url": url,
            "shop_url": shop_url,
            "event_id": event["_id"],
            "event_name": event.get("name"),
            "watched_tickets": {},
        }
        config["events"].append(existing)
    else:
        existing["shop_url"] = shop_url

    added = []
    for i in indices:
        t = tickets[i - 1]
        existing["watched_tickets"][t["name"]] = {"last_status": ticket_status(t)}
        added.append(t["name"])

    save_config(config)
    print(f"\nSaved. Now watching {len(added)} ticket(s) for '{event.get('name')}':")
    for name in added:
        print(f"  - {name}")
    print("\nRun 'python monitor.py check' to check now, or see README.md to schedule automatic checks.")


def cmd_list():
    config = load_config()
    if not config.get("events"):
        print("Nothing configured yet. Run: python monitor.py add <url>")
        return
    for ev in config["events"]:
        print(f"\n{ev.get('event_name')}  ({ev['event_id']})")
        print(f"  Shop: {ev.get('shop_url')}")
        for name, w in ev.get("watched_tickets", {}).items():
            status = (w.get("last_status") or "?").upper()
            print(f"  [{status:9s}] {name}")


def cmd_remove():
    config = load_config()
    flat = []
    for ev in config.get("events", []):
        for name in ev.get("watched_tickets", {}):
            flat.append((ev, name))
    if not flat:
        print("Nothing configured yet.")
        return
    for i, (ev, name) in enumerate(flat, 1):
        print(f"  {i:3d}. {ev.get('event_name')} -- {name}")
    selection = input("\nWhich to stop watching? (comma-separated numbers, or 'all'): ")
    indices = parse_selection(selection, len(flat))
    for i in indices:
        ev, name = flat[i - 1]
        ev["watched_tickets"].pop(name, None)
    config["events"] = [ev for ev in config["events"] if ev.get("watched_tickets")]
    save_config(config)
    print(f"Removed {len(indices)} ticket(s).")


def run_check():
    config = load_config()
    events = config.get("events", [])
    if not events:
        print("No events configured yet. Run: python monitor.py add <url>")
        return

    total_tickets = 0
    total_alerts = 0
    for ev in events:
        data = get_event_data(ev["event_id"], ev.get("shop_url"))
        if not data:
            log(f"CHECK FAILED | {ev.get('event_name', ev['event_id'])} | "
                f"could not fetch ticket data (API and Playwright fallback both failed)")
            continue

        tickets_by_name = {t["name"]: t for t in data.get("tickets", [])}
        for name, watched in ev.get("watched_tickets", {}).items():
            total_tickets += 1
            ticket = tickets_by_name.get(name)
            if ticket is None:
                log(f"{ev.get('event_name')} | {name} | NOT FOUND in current ticket list")
                continue

            new_status = ticket_status(ticket)
            old_status = watched.get("last_status")
            log(f"{ev.get('event_name')} | {name} | {new_status}")

            if old_status == "sold_out" and new_status == "available":
                link = ev.get("shop_url") or ev.get("source_url")
                if send_alert(ev.get("event_name"), name, link):
                    total_alerts += 1

            watched["last_status"] = new_status

    save_config(config)
    log(f"CHECK COMPLETE | {len(events)} event(s), {total_tickets} ticket(s) watched, {total_alerts} alert(s) sent")
    print(f"Check complete: {total_tickets} ticket(s) watched, {total_alerts} alert(s) sent. See logs/monitor.log")


def cmd_watch(interval_minutes):
    print(f"Watching every {interval_minutes} minute(s). Press Ctrl+C to stop.")
    while True:
        run_check()
        time.sleep(interval_minutes * 60)


def main():
    load_dotenv(ENV_PATH)

    parser = argparse.ArgumentParser(description="Vivenu ticket-availability monitor")
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="Resolve a page and choose tickets to monitor")
    p_add.add_argument("url")

    sub.add_parser("list", help="Show configured events and tickets")
    sub.add_parser("remove", help="Stop watching one or more tickets")
    sub.add_parser("check", help="Run one check cycle now")

    p_watch = sub.add_parser("watch", help="Keep checking on a loop")
    p_watch.add_argument("--interval-minutes", type=int, default=5)

    args = parser.parse_args()

    if args.command == "add":
        cmd_add(args.url)
    elif args.command == "list":
        cmd_list()
    elif args.command == "remove":
        cmd_remove()
    elif args.command == "check":
        run_check()
    elif args.command == "watch":
        cmd_watch(args.interval_minutes)


if __name__ == "__main__":
    main()
