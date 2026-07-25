#!/usr/bin/env python3
"""
Quick debug script — fetches one KML and prints the response details.
"""

import os
import requests

COOKIE = os.environ.get("FOREFLIGHT_COOKIE", "PASTE_YOUR_COOKIE_STRING_HERE")
BASE   = "https://plan.foreflight.com"

# A known trackUuid from your data
TEST_UUID = "661B4131-DFB5-42B7-8CDE-8757D53A86F9"  # KTEX - KEGE, 2025-12-23

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0",
    "Referer":    f"{BASE}/tracklogs",
    "Cookie":     COOKIE,
})

url = f"{BASE}/tracklogs/export/{TEST_UUID}/kml"
print(f"GET {url}\n")

r = session.get(url, allow_redirects=True)

print(f"Status:        {r.status_code}")
print(f"Final URL:     {r.url}")
print(f"Content-Type:  {r.headers.get('Content-Type')}")
print(f"Content-Length:{r.headers.get('Content-Length', '(not set)')}")
print(f"Body (first 500 chars):\n{r.text[:500]}")
