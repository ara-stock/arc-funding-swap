# Funding Swap on Arc

Peer-to-peer **fixed-for-floating swaps on a perpetual market's funding rate**, settled in USDC on
[Arc](https://arc.io) mainnet. Markets are Hyperliquid perps:

| Market label (bytes32) | Hyperliquid coin | First day on chain | Daily funding s.d. (60d, % APR) |
|---|---|---|---|
| `HL:BTC` | BTC | 2026-09-16 | 3.9 |
| `HL:HYPE` | HYPE | 2026-09-16 | 7.1 |
| `HL:SOL` | SOL | 2026-09-16 | 4.4 |
| `HL:DOGE` | DOGE | 2026-09-16 | 10.8 |

BTC funding sits at Hyperliquid's 0.00125%/h baseline most hours, so it is the steady reference; HYPE, SOL and DOGE move enough for a swap to matter. The contracts take any bytes32 market; the app lists only markets the oracle has kept up to date.

Perp funding is the largest recurring cash flow in crypto derivatives, and it is volatile. A basis
trader holding spot BTC and short BTC-PERP earns floating funding. With this contract they can lock
in a fixed rate for the next few days. A trader who expects funding to rise takes the other side.

**Live:** https://ara-stock.github.io/arc-funding-swap/ (Arc mainnet, chain 5042) ·
[Hedge](https://ara-stock.github.io/arc-funding-swap/hedge.html) (fix the funding your perp earns or pays) ·
[Predict](https://ara-stock.github.io/arc-funding-swap/predict.html) (take a view on funding) ·
[How it works](https://ara-stock.github.io/arc-funding-swap/how.html)

| Contract | Address |
|---|---|
| FundingIndexOracle | [`0xb2FF125422a9ED3fd42c080B3548b4071AEC8Be6`](https://explorer.arc.io/address/0xb2FF125422a9ED3fd42c080B3548b4071AEC8Be6) |
| FundingRateSwap | [`0x050d05E0e265F412Ed9064518942a6B1d0Bbee39`](https://explorer.arc.io/address/0x050d05E0e265F412Ed9064518942a6B1d0Bbee39) |
| Publisher | `0xDd14e65957eF26fFa2174C2E3C39Bd3eE2B084ED` |

Both contracts are source-verified on Sourcify (exact match):
[oracle](https://repo.sourcify.dev/contracts/full_match/5042/0xb2FF125422a9ED3fd42c080B3548b4071AEC8Be6/) ·
[swap](https://repo.sourcify.dev/contracts/full_match/5042/0x050d05E0e265F412Ed9064518942a6B1d0Bbee39/).
The oracle holds the daily index from 2026-09-16 onwards, and every value matches a recomputation from Hyperliquid's API.

## Why on-chain

Two people who don't know each other lock margin and settle by a rule that neither can change
afterwards. No venue holds the money and no one can refuse the payout. The swap and the funding
index are also open contracts, so other Arc apps can read the index or build on the swap (a
fixed-income vault, a hedge leg). That needs a chain. A website would only show data.

## How it works

| Contract | Role |
|---|---|
| `FundingIndexOracle` | Append-only daily record of a market's **cumulative funding** at every UTC day boundary. Values can't be revised, days must be contiguous, and a day can only be posted after it ends. |
| `FundingRateSwap` | A maker posts an offer: side, fixed rate per day, notional, margin per side, term in days and offer expiry. Their margin is locked. A taker locks the same margin, and the swap runs over the next whole UTC days. At maturity anyone calls `settle`. |

The **fixed payer** receives floating and pays fixed:

    payoff_to_fixed_payer = notional × (Σ funding over the term − fixed_rate_per_day × days)

The payoff moves from the loser's margin to the winner and is capped at the margin. Payouts always
add up to both margins; the fuzz test checks this.

**Safety rails** (this is an experiment, not a venue):
- Margin is capped at **100 USDC per side**, and the term at **30 days**.
- If the oracle has not posted the maturity value **7 days** after maturity, `refundIfOracleFailed`
  returns both margins in full.
- The contracts have no admin, no upgrade path and no fee. Not audited.

## Index rule

Anyone can recompute every on-chain value from Hyperliquid's public API (`POST
https://api.hyperliquid.xyz/info {"type":"fundingHistory","coin":"BTC",...}`):

1. Assign each hourly funding entry to the nearest whole hour. Entries are stamped a few ms after
   the hour.
2. `index(day) = Σ fundingRate` over hours `h` with `FIRST_DAY·24h < h ≤ day·24h`, ×1e18. The
   payment stamped at 00:00 UTC belongs to the day that just ended.
3. `index(FIRST_DAY) = 0`, where `FIRST_DAY` = 2026-09-16 (Arc mainnet launch).

`python3 publisher/publish.py show` prints the series. A positive daily delta means longs paid
shorts.

The publisher is a single key today. Planned next steps: several independent publishers, and a
dispute window before a value can be used for settlement.

## Repository

```
src/FundingIndexOracle.sol   src/FundingRateSwap.sol   test/FundingRateSwap.t.sol
script/Deploy.s.sol          publisher/publish.py      docs/ (the web app, GitHub Pages)
```

The web app has no build step: `docs/index.html`, `hedge.html`, `predict.html` and `how.html` share
`style.css`, `config.js` and `app.js` (an ES module; each page picks its code path from
`<body data-page>`). The order ticket is duplicated in `hedge.html` and `predict.html`; keep the
two in sync.

```sh
forge test                                   # 13 tests incl. a payout-conservation fuzz test
python3 publisher/publish.py show            # compute the index from Hyperliquid
```

## Deploy (operator)

1. Create two keystores. The private keys never leave Foundry's encrypted keystore.
   ```sh
   cast wallet new-mnemonic   # or use existing keys
   cast wallet import arc-deployer --interactive
   cast wallet import arc-funding-publisher --interactive
   ```
2. Fund both addresses with a few USDC on Arc. USDC is the gas token.
3. Deploy:
   ```sh
   PUBLISHER=<publisher address> forge script script/Deploy.s.sol --rpc-url arc --account arc-deployer --broadcast
   ```
4. Put the two addresses in `docs/config.js`.
5. Post the history, then once a day (cron):
   ```sh
   ORACLE_ADDRESS=<oracle> python3 publisher/publish.py post
   ```
   The password for `arc-funding-publisher` is read from `~/.config/arc-funding/keystore-password`
   (chmod 600).

## License

MIT
