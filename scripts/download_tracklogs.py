#!/usr/bin/env python3
"""
ForeFlight Tracklog Downloader
==============================
Downloads all tracklogs as KML files from ForeFlight.

Setup:
1. Log into ForeFlight at https://plan.foreflight.com
2. Open DevTools (F12) → Network tab
3. Navigate to the Tracklogs section so a request fires
4. Click any request to plan.foreflight.com
5. In Request Headers, find the "Cookie" header and copy its full value
6. Run: FOREFLIGHT_COOKIE='...' python3 download_tracklogs.py
"""

import os
import re
import time
import requests
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────

COOKIE     = os.environ.get("FOREFLIGHT_COOKIE", "PASTE_YOUR_COOKIE_STRING_HERE")
OUTPUT_DIR = Path(__file__).parent / "foreflight_tracklogs"  # same dir as script
PAGE_SIZE  = 20
SLEEP_SECS = 0.5

BASE = "https://plan.foreflight.com"

# ── Helpers ────────────────────────────────────────────────────────────────────

def make_session(cookie_str: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0",
        "Referer":    f"{BASE}/tracklogs",
        "Cookie":     cookie_str,
    })
    return s


def fetch_page(session: requests.Session, page: int) -> dict | None:
    r = session.get(
        f"{BASE}/tracklogs/api/tracklogs/",
        params={"page": page, "pageSize": PAGE_SIZE},
    )
    if r.status_code == 500:
        print(f"  ⚠  Page {page} returned 500 — skipping")
        return None
    r.raise_for_status()
    return r.json()


def sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip()


def download_kml(session: requests.Session, tl: dict, out_dir: Path) -> bool:
    uuid     = tl["trackUuid"]
    date     = tl["timestampStart"][:10]
    name     = sanitize(tl.get("name", uuid))
    filename = f"{date}__{name}__{uuid}.kml"
    dest     = out_dir / filename

    if dest.exists():
        print(f"  ↩  Already exists: {filename}")
        return True

    r = session.get(f"{BASE}/tracklogs/export/{uuid}/kml")

    if r.status_code in (404, 500):
        print(f"  ✗  HTTP {r.status_code} for: {filename}")
        return False

    r.raise_for_status()
    dest.write_bytes(r.content)
    kb = len(r.content) // 1024
    print(f"  ✓  {filename}  ({kb} KB)")
    return True


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    if COOKIE == "PASTE_YOUR_COOKIE_STRING_HERE":
        print("❌  Set your cookie first.")
        print("    FOREFLIGHT_COOKIE='...' python3 download_tracklogs.py")
        return

    OUTPUT_DIR.mkdir(exist_ok=True)
    print(f"Output directory: {OUTPUT_DIR}\n")

    session = make_session(COOKIE)

    # Page 1: establish total
    print("Fetching page 1...")
    data = fetch_page(session, 1)
    if data is None:
        print("❌  Page 1 failed — cannot continue.")
        return

    total = data["totalTracklogs"]
    pages = -(-total // PAGE_SIZE)
    all_tracklogs = list(data["tracklogs"])
    print(f"Found {total} tracklogs across {pages} page(s).\n")

    # Remaining pages
    skipped_pages = []
    for page in range(2, pages + 1):
        print(f"Fetching page {page}/{pages}...")
        data = fetch_page(session, page)
        if data is None:
            skipped_pages.append(page)
        else:
            all_tracklogs.extend(data["tracklogs"])
        time.sleep(SLEEP_SECS)

    if skipped_pages:
        print(f"\n⚠  Skipped pages (server error): {skipped_pages}")

    print(f"\nDownloading {len(all_tracklogs)} KML files → {OUTPUT_DIR}\n")

    ok = fail = 0
    for tl in all_tracklogs:
        if download_kml(session, tl, OUTPUT_DIR):
            ok += 1
        else:
            fail += 1
        time.sleep(SLEEP_SECS)

    print(f"\nDone.  ✓ {ok} downloaded   ✗ {fail} skipped/failed")
    if skipped_pages:
        print(f"       ~{len(skipped_pages) * PAGE_SIZE} tracklogs on skipped pages were not downloaded")


if __name__ == "__main__":
    main()
