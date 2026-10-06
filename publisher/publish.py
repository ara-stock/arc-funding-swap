#!/usr/bin/env python3
"""Compute Hyperliquid's daily cumulative funding index and post the missing days to the oracle.

    python3 publisher/publish.py show                  # print the computed index (no chain access)
    python3 publisher/publish.py post [--dry-run]      # post every day the oracle does not have yet

Index rule (anyone can recompute it from Hyperliquid's public API):
  - Each hourly `fundingHistory` entry is assigned to the nearest whole hour.
  - index(day) = sum of fundingRate over hours h with FIRST_DAY*24h < h <= day*24h, scaled by 1e18.
    The payment stamped exactly at 00:00 UTC belongs to the day that just ended.
  - index(FIRST_DAY) = 0.

Signing goes through Foundry's encrypted keystore (`cast send --account ... --password-file ...`),
so the private key is never passed on the command line or read by this script.
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from decimal import Decimal
from pathlib import Path

HL_INFO = "https://api.hyperliquid.xyz/info"
ARC_RPC = os.environ.get("ARC_RPC", "https://rpc.mainnet.arc.io")
COIN = os.environ.get("FUNDING_COIN", "BTC")
MARKET = os.environ.get("FUNDING_MARKET", "HL:BTC")  # bytes32 label used on chain
FIRST_DAY = int(os.environ.get("FIRST_DAY", "20712"))  # 2026-09-16, Arc mainnet launch
ORACLE = os.environ.get("ORACLE_ADDRESS", "0xb2FF125422a9ED3fd42c080B3548b4071AEC8Be6")
ACCOUNT = os.environ.get("PUBLISHER_ACCOUNT", "arc-funding-publisher")  # cast keystore name
PASSWORD_FILE = os.environ.get(
    "PUBLISHER_PASSWORD_FILE", str(Path.home() / ".config/arc-funding/keystore-password")
)
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
SCALE = Decimal(10) ** 18


def _post_json(url: str, body: dict) -> object:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def funding_hours(start_ms: int, end_ms: int) -> dict[int, Decimal]:
    """Hourly funding rates keyed by the nearest whole hour (ms), for start_ms < hour <= end_ms."""
    out: dict[int, Decimal] = {}
    cursor = start_ms
    while cursor < end_ms + HOUR_MS // 2:
        rows = _post_json(
            # Entries are stamped a few ms after the hour, so ask for half an hour beyond end_ms
            # and filter on the rounded hour below.
            HL_INFO,
            {"type": "fundingHistory", "coin": COIN, "startTime": cursor, "endTime": end_ms + HOUR_MS // 2},
        )
        if not rows:
            break
        for row in rows:
            hour = round(row["time"] / HOUR_MS) * HOUR_MS
            if start_ms < hour <= end_ms:
                out[hour] = Decimal(row["fundingRate"])
        last = rows[-1]["time"]
        if last <= cursor:
            break
        cursor = last + 1
        time.sleep(0.2)
    return out


def daily_index(last_day: int) -> list[tuple[int, int]]:
    """[(day, index_1e18)] for FIRST_DAY..last_day inclusive."""
    hours = funding_hours(FIRST_DAY * DAY_MS, last_day * DAY_MS)
    result, acc = [], Decimal(0)
    for day in range(FIRST_DAY, last_day + 1):
        if day > FIRST_DAY:
            lo, hi = (day - 1) * DAY_MS, day * DAY_MS
            day_hours = [h for h in hours if lo < h <= hi]
            if len(day_hours) != 24:
                raise SystemExit(f"day {day}: expected 24 hourly funding entries, got {len(day_hours)}")
            acc += sum((hours[h] for h in day_hours), Decimal(0))
        result.append((day, int(acc * SCALE)))
    return result


def market_bytes32() -> str:
    raw = MARKET.encode()
    if len(raw) > 32:
        raise SystemExit("FUNDING_MARKET longer than 32 bytes")
    return "0x" + raw.hex().ljust(64, "0")


def cast(*args: str) -> str:
    exe = shutil.which("cast") or str(Path.home() / ".foundry/bin/cast")
    return subprocess.run([exe, *args], check=True, capture_output=True, text=True).stdout.strip()


def oracle_last_day() -> int | None:
    out = cast("call", ORACLE, "range(bytes32)(uint64,uint64,bool)", market_bytes32(), "--rpc-url", ARC_RPC)
    first, last, started = out.split()
    return int(last) if started == "true" else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("command", choices=["show", "post"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    today = int(time.time() // 86400)  # the boundary at the start of today has passed
    series = daily_index(today)
    if args.command == "show":
        for day, idx in series:
            print(day, time.strftime("%Y-%m-%d", time.gmtime(day * 86400)), idx)
        return 0

    if not ORACLE:
        raise SystemExit("set ORACLE_ADDRESS")
    last = oracle_last_day()
    todo = [(d, i) for d, i in series if last is None or d > last]
    print(f"oracle last day: {last}; posting {len(todo)} day(s)")
    for day, idx in todo:
        cmd = ["send", ORACLE, "post(bytes32,uint64,int256)", market_bytes32(), str(day), str(idx),
               "--rpc-url", ARC_RPC, "--account", ACCOUNT, "--password-file", PASSWORD_FILE]
        print("cast", " ".join(cmd[:6]))
        if not args.dry_run:
            cast(*cmd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
