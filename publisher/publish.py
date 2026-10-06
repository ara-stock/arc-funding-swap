#!/usr/bin/env python3
"""Compute Hyperliquid's daily cumulative funding index and post the missing days to the oracle.

    python3 publisher/publish.py show [--market HL:HYPE]          # print the computed index (no chain access)
    python3 publisher/publish.py post [--dry-run] [--market ...]  # post every day the oracle does not have yet

Markets come from FUNDING_MARKETS ("label=coin:first_day,..."), default HL:BTC, HL:HYPE, HL:SOL, HL:DOGE,
all starting on Arc's mainnet launch day. A market that fails is logged and skipped; the exit code is 1
if any market failed, so cron logs show it.

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
LAUNCH_DAY = 20712  # 2026-09-16, Arc mainnet launch
MARKETS_ENV = os.environ.get(
    "FUNDING_MARKETS", "HL:BTC=BTC:20712,HL:HYPE=HYPE:20712,HL:SOL=SOL:20712,HL:DOGE=DOGE:20712"
)
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


def funding_hours(coin: str, start_ms: int, end_ms: int) -> dict[int, Decimal]:
    """Hourly funding rates keyed by the nearest whole hour (ms), for start_ms < hour <= end_ms."""
    out: dict[int, Decimal] = {}
    cursor = start_ms
    while cursor < end_ms + HOUR_MS // 2:
        rows = _post_json(
            # Entries are stamped a few ms after the hour, so ask for half an hour beyond end_ms
            # and filter on the rounded hour below.
            HL_INFO,
            {"type": "fundingHistory", "coin": coin, "startTime": cursor, "endTime": end_ms + HOUR_MS // 2},
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


def parse_markets(spec: str) -> list[tuple[str, str, int]]:
    """"HL:BTC=BTC:20712,..." -> [("HL:BTC", "BTC", 20712), ...]"""
    out = []
    for item in filter(None, (x.strip() for x in spec.split(","))):
        label, rest = item.split("=", 1)
        coin, _, first = rest.partition(":")
        out.append((label, coin, int(first or LAUNCH_DAY)))
    return out


def daily_index(coin: str, first_day: int, last_day: int) -> list[tuple[int, int]]:
    """[(day, index_1e18)] for first_day..last_day inclusive."""
    hours = funding_hours(coin, first_day * DAY_MS, last_day * DAY_MS)
    result, acc = [], Decimal(0)
    for day in range(first_day, last_day + 1):
        if day > first_day:
            lo, hi = (day - 1) * DAY_MS, day * DAY_MS
            day_hours = [h for h in hours if lo < h <= hi]
            if len(day_hours) != 24:
                raise RuntimeError(f"{coin} day {day}: expected 24 hourly funding entries, got {len(day_hours)}")
            acc += sum((hours[h] for h in day_hours), Decimal(0))
        result.append((day, int(acc * SCALE)))
    return result


def market_bytes32(label: str) -> str:
    raw = label.encode()
    if len(raw) > 32:
        raise SystemExit(f"market label {label!r} longer than 32 bytes")
    return "0x" + raw.hex().ljust(64, "0")


def cast(*args: str) -> str:
    exe = shutil.which("cast") or str(Path.home() / ".foundry/bin/cast")
    return subprocess.run([exe, *args], check=True, capture_output=True, text=True).stdout.strip()


def oracle_range(label: str) -> tuple[int, int] | None:
    """(firstDay, lastDay) on chain, or None if the market has never been posted."""
    out = cast("call", ORACLE, "range(bytes32)(uint64,uint64,bool)", market_bytes32(label), "--rpc-url", ARC_RPC)
    # cast prints one value per line, large numbers with a "[2.071e4]" hint after them
    first, last, started = (line.split()[0] for line in out.splitlines())
    return (int(first), int(last)) if started == "true" else None


def publish_market(label: str, coin: str, first_day: int, today: int, command: str, dry_run: bool) -> None:
    if command == "show":
        for day, idx in daily_index(coin, first_day, today):
            print(label, day, time.strftime("%Y-%m-%d", time.gmtime(day * 86400)), idx)
        return
    rng = oracle_range(label)
    # Once a series exists, its first day on chain is the zero point of the index, whatever the config says.
    base = rng[0] if rng else first_day
    last = rng[1] if rng else None
    series = daily_index(coin, base, today)
    todo = [(d, i) for d, i in series if last is None or d > last]
    print(f"{label}: oracle last day {last}; posting {len(todo)} day(s)")
    for day, idx in todo:
        cmd = ["send", ORACLE, "post(bytes32,uint64,int256)", market_bytes32(label), str(day), str(idx),
               "--rpc-url", ARC_RPC, "--account", ACCOUNT, "--password-file", PASSWORD_FILE]
        print(" ", label, day, idx)
        if not dry_run:
            cast(*cmd)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("command", choices=["show", "post"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--market", action="append", help="only this market label (repeatable)")
    args = ap.parse_args()
    if not ORACLE:
        raise SystemExit("set ORACLE_ADDRESS")

    today = int(time.time() // 86400)  # the boundary at the start of today has passed
    markets = [m for m in parse_markets(MARKETS_ENV) if not args.market or m[0] in args.market]
    failed = []
    for label, coin, first_day in markets:
        try:
            publish_market(label, coin, first_day, today, args.command, args.dry_run)
        except Exception as e:  # keep going so one bad market does not stop the others
            print(f"{label}: FAILED {e}", file=sys.stderr)
            failed.append(label)
    if args.command == "post" and not args.dry_run:
        try:
            bal = int(cast("balance", cast("wallet", "address", "--account", ACCOUNT, "--password-file", PASSWORD_FILE), "--rpc-url", ARC_RPC))
            print(f"publisher balance {bal / 1e18:.4f} USDC" + ("  WARNING: below 1 USDC" if bal < 10**18 else ""))
        except Exception as e:
            print(f"balance check failed: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
