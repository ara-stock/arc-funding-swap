// Filled in after deployment (addresses printed by script/Deploy.s.sol).
window.ARC_FUNDING_CONFIG = {
  chainId: 5042,
  rpc: "https://rpc.mainnet.arc.io",
  explorer: "https://explorer.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  // Markets the page offers. Only those the oracle has data for (posted within the last 2 days) are shown.
  // sdApr: standard deviation of daily funding in % APR over the 60 days to statsAsOf (Hyperliquid API).
  markets: [
    { label: "HL:HYPE", coin: "HYPE", name: "HYPE", sdApr: 7.1 },
    { label: "HL:SOL", coin: "SOL", name: "SOL", sdApr: 4.4 },
    { label: "HL:DOGE", coin: "DOGE", name: "DOGE", sdApr: 10.8 },
    { label: "HL:BTC", coin: "BTC", name: "BTC", sdApr: 3.9 },
  ],
  defaultMarket: "HL:HYPE",
  statsAsOf: "2026-10-07",
  oracle: "0xb2FF125422a9ED3fd42c080B3548b4071AEC8Be6",
  swap: "0x050d05E0e265F412Ed9064518942a6B1d0Bbee39",
};
