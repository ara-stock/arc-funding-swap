// Funding Swap web app, shared by index.html (home), hedge.html, predict.html and how.html.
// Every render function returns early when its root element is missing on the current page.
const { ethers } = window;
const CFG = window.ARC_FUNDING_CONFIG;
const ORACLE_ABI = ["function range(bytes32) view returns (uint64,uint64,bool)", "function indexAt(bytes32,uint64) view returns (int256)"];
const SWAP_ABI = [
  "function swapCount() view returns (uint256)",
  "function getSwap(uint256) view returns (tuple(address maker,bool makerPaysFixed,bytes32 market,uint128 notional,uint128 margin,int256 fixedRatePerDay,uint64 tenorDays,uint64 offerExpiry,address taker,uint64 startDay,uint8 state))",
  "function createOffer(bytes32,bool,uint128,uint128,int256,uint64,uint64) returns (uint256)",
  "function cancelOffer(uint256)", "function takeOffer(uint256)", "function settle(uint256)", "function refundIfOracleFailed(uint256)",
];
const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
const MARKETS = CFG.markets || [{ label: CFG.market, coin: "BTC", name: "BTC", sdApr: 3.9 }];
let mkt = MARKETS.find((m) => m.label === CFG.defaultMarket) || MARKETS[0], liveMarkets = [];
const mkey = (m) => ethers.encodeBytes32String(m.label);
const marketOf = (b32) => { try { const l = ethers.decodeBytes32String(b32); return MARKETS.find((m) => m.label === l) || { label: l, name: l, unknown: true }; } catch { return { label: b32.slice(0, 10) + "…", name: b32.slice(0, 10) + "…", unknown: true }; } };
// The public RPC rate-limits bursts, so never batch: one request at a time, and Multicall3 for lists.
const read = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { staticNetwork: true, batchMaxCount: 1 });
const MULTICALL = new ethers.Contract("0xcA11bde05977b3631167028862bE2a173976CA11",
  ["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])"], read);
async function multicall(contract, fn, argsList) {
  const iface = contract.interface, target = await contract.getAddress();
  const res = await MULTICALL.aggregate3(argsList.map((a) => ({ target, allowFailure: false, callData: iface.encodeFunctionData(fn, a) })));
  return res.map((r) => iface.decodeFunctionResult(fn, r.returnData)[0]);
}
const oracleR = new ethers.Contract(CFG.oracle, ORACLE_ABI, read);
const swapR = new ethers.Contract(CFG.swap, SWAP_ABI, read);
let signer = null, me = null, daily = [];

const $ = (id) => document.getElementById(id);
const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };
const log = (m) => { const el = $("log"); if (!el) { console.log(m); return; } el.textContent = `${new Date().toISOString().slice(11,19)}  ${m}\n` + el.textContent; };
const PAGE = document.body.dataset.page || "home";
const TICKET = PAGE === "hedge" || PAGE === "predict";
const usdc = (v) => Number(ethers.formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (r, d = 4) => (r * 100).toFixed(d) + "%";
const aprOf = (perDay) => (perDay * 365 * 100).toFixed(1) + "%";
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const dayStr = (d) => new Date(Number(d) * 86400000).toISOString().slice(0, 10);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------------------------------------------------------------- market data
const dailyCache = {};
async function loadMarket() {
  const m = mkt;
  daily = [];
  if (dailyCache[m.label]) { daily = dailyCache[m.label]; return showMarket(); }
  const [first, last, started] = await oracleR.range(mkey(m));
  if (!started) { setText("chartNote", "No funding values posted yet."); return; }
  const days = []; for (let d = Number(first); d <= Number(last); d++) days.push(d);
  const idx = await multicall(oracleR, "indexAt", days.map((d) => [mkey(m), d]));
  const series = [];
  for (let i = 1; i < idx.length; i++) series.push({ day: days[i] - 1, rate: Number(ethers.formatUnits(idx[i] - idx[i - 1], 18)) });
  dailyCache[m.label] = series;
  if (m !== mkt) return; // the user switched market while this was loading
  daily = series; showMarket();
}
function showMarket() {
  if (!daily.length) return;
  const lastD = daily[daily.length - 1];
  const last7 = daily.slice(-7); const avg7 = last7.reduce((s, x) => s + x.rate, 0) / last7.length;
  setText("kLast", pct(lastD.rate, 4)); setText("kLastNote", `per day on ${dayStr(lastD.day)} · ${aprOf(lastD.rate)} annualised`);
  setText("k7", aprOf(avg7)); setText("k7Note", `annualised · ${pct(avg7, 4)} per day`);
  setText("kDays", String(daily.length));
  const avg = daily.reduce((s, x) => s + x.rate, 0) / daily.length;
  setText("chartNote", `${daily.length} days since ${dayStr(daily[0].day)} · average ${pct(avg)} per day (${aprOf(avg)} annualised)`);
  const tbl = $("tbl");
  if (tbl) {
    tbl.textContent = "";
    for (const x of [...daily].reverse()) { const tr = tbl.insertRow(); [dayStr(x.day), pct(x.rate), aprOf(x.rate)].forEach((t) => (tr.insertCell().textContent = t)); }
  }
  drawChart(); renderRateChips(); updateSummary();
}

let hourly = [], tRange = "d";
const dailySeries = () => daily.map((x) => ({ label: dayStr(x.day) + " (UTC day)", short: dayStr(x.day).slice(5), rate: x.rate }));
function drawChart() {
  drawHistory("chart", "tip", 260, dailySeries(), false);
  const ts = (tRange === "h48" || !daily.length) && hourly.length ? hourly : dailySeries();
  drawHistory("tchart", "ttip", 220, ts, true);
}
// series: [{label, short, rate}] with rate expressed per day; ticket mode speaks APR and colours by win/lose
function drawHistory(svgId, tipId, H, series, ticket) {
  const svg = $(svgId); if (!svg || !series.length) return;
  const W = svg.clientWidth || 900, narrow = W < 520, L = narrow ? 38 : 56, R = narrow ? 78 : 118, T = 22, B = 28;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const fmt = (r, d) => ticket ? (r * 365 * 100).toFixed(1) + "%" : (r * 100).toFixed(d) + "%";
  const fixed = currentFixed();
  const vals = series.map((x) => x.rate).concat([0, fixed ?? 0]);
  let max = Math.max(...vals), min = Math.min(...vals); const pad = (max - min || 1e-4) * 0.12; max += pad; min = Math.min(0, min - pad);
  const y = (r) => T + (max - r) / (max - min) * (H - T - B);
  const slot = (W - L - R) / series.length, bw = Math.min(24, Math.max(1.5, slot - (series.length > 40 ? 1 : 2)));
  const parts = [];
  const grid = cssVar("--grid"), mute = cssVar("--mute");
  const k = ticket ? 365 * 100 : 100;
  const rawStep = (max - min) * k / 4, mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const tickStep = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= rawStep) / k;
  for (let v = Math.ceil(min / tickStep) * tickStep; v <= max + 1e-15; v += tickStep) {
    const yy = y(v), lbl = (v * k).toFixed(Math.max(0, -Math.floor(Math.log10(tickStep * k))));
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${grid}" stroke-width="1"/>`);
    parts.push(`<text x="${L - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${mute}">${Math.abs(v) < tickStep / 2 ? "0" : lbl}%</text>`);
  }
  if (fixed !== null && ticket) {
    const zoneTop = side === "1" ? T : y(fixed), zoneH = side === "1" ? y(fixed) - T : (H - B) - y(fixed);
    parts.push(`<rect x="${L}" y="${zoneTop}" width="${W - L - R}" height="${Math.max(0, zoneH)}" fill="var(--acc)" opacity=".08" pointer-events="none"/>`);
  }
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${mute}" stroke-width="1"/>`);
  series.forEach((x, i) => {
    const cx = L + i * slot + (slot - bw) / 2, y0 = y(0), y1 = y(x.rate), h = Math.abs(y1 - y0), top = Math.min(y0, y1);
    const color = ticket && fixed !== null
      ? ((x.rate > fixed) === (side === "1") ? "var(--pos)" : "var(--neg)")
      : (x.rate >= 0 ? "var(--pos)" : "var(--neg)");
    const rr = Math.min(4, h, bw / 2);
    const d = x.rate >= 0
      ? `M${cx},${y0} V${top + rr} Q${cx},${top} ${cx + rr},${top} H${cx + bw - rr} Q${cx + bw},${top} ${cx + bw},${top + rr} V${y0} Z`
      : `M${cx},${y0} V${top + h - rr} Q${cx},${top + h} ${cx + rr},${top + h} H${cx + bw - rr} Q${cx + bw},${top + h} ${cx + bw},${top + h - rr} V${y0} Z`;
    parts.push(`<path d="${d}" fill="${color}"/>`);
    parts.push(`<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent" data-i="${i}"/>`);
  });
  const avg = series.reduce((a, x) => a + x.rate, 0) / series.length;
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--ink-2)" stroke-width="2" stroke-linecap="round" pointer-events="none"/>`);
  if (fixed !== null) parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(fixed)}" y2="${y(fixed)}" stroke="var(--acc)" stroke-width="${ticket ? 3 : 2}" stroke-linecap="round" pointer-events="none"/>`);
  if (ticket && fixed !== null) {
    const wins = series.filter((x) => (x.rate > fixed) === (side === "1")).length;
    const unit = tRange === "h48" && hourly.length ? "hours" : "days";
    parts.push(`<text x="${L + 4}" y="${T - 8}" font-size="12" font-weight="700" fill="var(--ink)">${side === "1" ? "Above" : "Below"} ${(fixed * 365 * 100).toFixed(1)}%: ${narrow ? `won ${wins} of ${series.length} ${unit}` : `you would have won ${wins} of the last ${series.length} ${unit}`}</text>`);
  }
  let ya = y(avg), yf = fixed !== null ? y(fixed) : null;
  if (yf !== null && Math.abs(ya - yf) < 14) { const mid = (ya + yf) / 2; if (ya <= yf) { ya = mid - 7; yf = mid + 7; } else { ya = mid + 7; yf = mid - 7; } }
  parts.push(`<text x="${W - R + 6}" y="${ya + 4}" font-size="11" fill="var(--ink-2)">${narrow ? "" : "avg "}${fmt(avg, 3)}</text>`);
  if (yf !== null) parts.push(`<text x="${W - R + 6}" y="${yf + 4}" font-size="12" font-weight="700" fill="var(--acc)">${narrow ? "" : ticket ? "your line " : "fixed "}${fmt(fixed, 3)}</text>`);
  const every = Math.max(1, Math.ceil(series.length / (narrow ? 3 : 6)));
  series.forEach((x, i) => { if (i % every === 0 || i === series.length - 1) parts.push(`<text x="${L + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${mute}">${x.short}</text>`); });
  svg.innerHTML = parts.join("");
  svg.querySelectorAll("rect[data-i]").forEach((el) => {
    el.addEventListener("mousemove", (ev) => {
      const x = series[Number(el.dataset.i)], tip = $(tipId), box = svg.parentElement.getBoundingClientRect();
      tip.textContent = `${x.label} · ${aprOf(x.rate)} APR (${pct(x.rate)} / day)`;
      tip.style.left = Math.min(ev.clientX - box.left + 12, box.width - tip.offsetWidth - 4) + "px"; tip.style.top = (ev.clientY - box.top - 34) + "px"; tip.style.opacity = 1;
    });
    el.addEventListener("mouseleave", () => ($(tipId).style.opacity = 0));
  });
}
// live hourly funding straight from Hyperliquid's public API (read-only)
async function loadLive() {
  const m = mkt;
  const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "fundingHistory", coin: m.coin, startTime: Date.now() - 48 * 3600e3 }) });
  const rows = await r.json();
  if (m !== mkt) return;
  hourly = rows.map((x) => { const d = new Date(Math.round(x.time / 3600e3) * 3600e3); return { label: d.toISOString().slice(5, 13).replace("T", " ") + ":00 UTC", short: d.toISOString().slice(11, 13) + ":00", rate: Number(x.fundingRate) * 24 }; });
  if (!hourly.length) return;
  const now = hourly[hourly.length - 1].rate, h24 = hourly.slice(-24).reduce((a, x) => a + x.rate, 0) / Math.min(24, hourly.length);
  setText("liveNow", aprOf(now) + " APR"); setText("live24", aprOf(h24));
  renderRateChips(); drawChart();
}
// show only markets the oracle has kept up to date (last value at most 2 days old)
async function discoverMarkets() {
  const today = Math.floor(Date.now() / 86400000);
  liveMarkets = [];
  for (const m of MARKETS) {
    const [, last, started] = await oracleR.range(mkey(m)).catch(() => [0n, 0n, false]);
    if (started && today - Number(last) <= 2) liveMarkets.push(m);
  }
  if (!liveMarkets.includes(mkt) && liveMarkets.length) mkt = liveMarkets[0];
  renderMarketChips();
}
function moveTag(m) { return m.sdApr >= 6 ? "moves a lot" : m.sdApr <= 4 ? "steady" : "moves some"; }
function renderMarketChips() {
  for (const id of ["mktChips", "mktChips2"]) {
    const box = $(id); if (!box) continue;
    box.textContent = "";
    box.style.display = liveMarkets.length < 2 ? "none" : "";
    if (id === "mktChips" && $("mktLabel")) $("mktLabel").style.display = box.style.display;
    for (const m of liveMarkets) {
      const b = document.createElement("button"); b.className = "chip"; b.setAttribute("aria-pressed", String(m === mkt));
      b.innerHTML = `${m.name}<small>${moveTag(m)}</small>`;
      b.onclick = () => selectMarket(m);
      box.appendChild(b);
    }
  }
  document.querySelectorAll(".mname").forEach((e) => (e.textContent = mkt.name));
}
function selectMarket(m) {
  if (m === mkt) return;
  mkt = m; hourly = []; aprEdited = false; marginEdited = false;
  ["liveNow", "live24", "live7"].forEach((id) => setText(id, "–"));
  renderMarketChips();
  if (TICKET) loadLive().catch((e) => log(`live funding unavailable: ${e.message}`));
  loadMarket().catch((e) => setText("chartNote", `Could not read the oracle: ${e.shortMessage || e.message}`));
}
window.addEventListener("resize", drawChart);
if ($("tblToggle")) $("tblToggle").onclick = () => { const w = $("tblWrap"); w.hidden = !w.hidden; $("tblToggle").textContent = w.hidden ? "Show as table" : "Hide table"; };

// ---------------------------------------------------------------- offers
async function loadSwaps() {
  if (!$("swaps")) return;
  const n = Number(await swapR.swapCount());
  const body = $("swaps"); body.textContent = "";
  if (n === 0) {
    const td = body.insertRow().insertCell(); td.colSpan = 9; td.className = "empty";
    td.innerHTML = "No offers yet. <a href=\"#create\">Post the first one</a>."; return;
  }
  const nowDay = Math.floor(Date.now() / 86400000);
  const ids = []; for (let id = n - 1; id >= 0; id--) ids.push(id);
  const all = await multicall(swapR, "getSwap", ids.map((id) => [id]));
  for (const [k, id] of ids.entries()) {
    const s = all[k], st = Number(s.state);
    const rate = Number(ethers.formatUnits(s.fixedRatePerDay, 18));
    const tr = body.insertRow();
    const sm = marketOf(s.market), smOk = !sm.unknown && liveMarkets.some((m) => m.label === sm.label);
    tr.insertCell().textContent = String(id);
    tr.insertCell().textContent = sm.name + (smOk ? "" : " ⚠");
    tr.insertCell().textContent = short(s.maker);
    tr.insertCell().textContent = `${s.makerPaysFixed ? "Pays" : "Receives"} fixed ${pct(rate, 3)}/day (${aprOf(rate)})`;
    tr.insertCell().textContent = usdc(s.notional) + " USDC";
    tr.insertCell().textContent = usdc(s.margin) + " USDC";
    tr.insertCell().textContent = s.startDay > 0n ? `${dayStr(s.startDay)} → ${dayStr(s.startDay + s.tenorDays)}` : `${s.tenorDays} days`;
    const pill = document.createElement("span"); pill.className = "pill" + (st === 1 ? " open" : "");
    pill.textContent = st === 1 ? (Date.now() / 1000 < Number(s.offerExpiry) ? "Open" : "Expired") : st === 2 ? "Active" : "Closed";
    tr.insertCell().appendChild(pill);
    const act = tr.insertCell();
    const btn = (label, fn, ghost) => { const b = document.createElement("button"); b.textContent = label; if (ghost) b.className = "ghost"; b.disabled = !signer; b.onclick = fn; act.appendChild(b); };
    if (st === 1 && me && me.toLowerCase() === s.maker.toLowerCase()) btn("Cancel", () => tx("cancel", (c) => c.cancelOffer(id)), true);
    else if (st === 1 && smOk && Date.now() / 1000 < Number(s.offerExpiry)) btn(`Take: ${s.makerPaysFixed ? "receive" : "pay"} fixed`, () => take(id, s));
    if (st === 2 && nowDay >= Number(s.startDay + s.tenorDays)) {
      btn("Settle", () => tx("settle", (c) => c.settle(id)));
      if (nowDay >= Number(s.startDay + s.tenorDays) + 7) btn("Refund", () => tx("refund", (c) => c.refundIfOracleFailed(id)), true);
    }
  }
}

async function ensureAllowance(amount) {
  const token = new ethers.Contract(CFG.usdc, ERC20_ABI, signer);
  if ((await token.allowance(me, CFG.swap)) >= amount) return;
  log(`approving ${usdc(amount)} USDC…`);
  await (await token.approve(CFG.swap, amount)).wait();
}
async function tx(label, call) {
  try {
    const c = new ethers.Contract(CFG.swap, SWAP_ABI, signer);
    log(`${label}: waiting for wallet…`);
    const r = await (await call(c)).wait();
    log(`${label}: confirmed ${r.hash}`);
    await loadSwaps();
  } catch (e) { log(`${label} failed: ${e.shortMessage || e.message}`); }
}
async function take(id, s) {
  const rate = Number(ethers.formatUnits(s.fixedRatePerDay, 18));
  const youPay = s.makerPaysFixed; // the taker is on the other side
  const nm = marketOf(s.market).name;
  const msg = `Take offer #${id} (${nm})?\n\nYou will ${youPay ? `PAY the actual ${nm} funding and RECEIVE` : "PAY"} a fixed ${aprOf(rate)} APR${youPay ? "" : ` and RECEIVE the actual ${nm} funding`} on ${usdc(s.notional)} USDC for ${s.tenorDays} day(s), starting at the next UTC midnight.\n\nDeposit: ${usdc(s.margin)} USDC. This is the most you can lose.\nYour wallet will ask to approve the deposit (if needed) and then to take the offer.`;
  if (!window.confirm(msg)) return;
  try { await ensureAllowance(s.margin); } catch (e) { log(`approve failed: ${e.shortMessage || e.message}`); return; }
  await tx(`take #${id}`, (c) => c.takeOffer(id));
  await readBalances(); refreshAction();
}

// ---------------------------------------------------------------- create form
const firstGoal = document.querySelector(".choice[data-goal]");
let side = firstGoal ? firstGoal.dataset.side : "0", goal = firstGoal ? firstGoal.dataset.goal : "lock", tier = "fair", aprEdited = false, marginEdited = false, usdcBal = null, allowance = null;
const aprToDay = (apr) => apr / 100 / 365;
function currentFixed() { if (!$("fApr")) return null; const v = Number($("fApr").value); return Number.isFinite(v) ? aprToDay(v) : null; }
function readForm() {
  return {
    paysFixed: side === "1",
    rate: ethers.parseUnits(aprToDay(Number($("fApr").value)).toFixed(18), 18),
    notional: ethers.parseUnits($("fNotional").value || "0", 6),
    margin: ethers.parseUnits($("fMargin").value || "0", 6),
    tenor: BigInt(parseInt($("fTenor").value || "0", 10)),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600 * parseInt($("fExpiry").value || "0", 10)),
  };
}
function suggestedMargin() {
  if (!$("fNotional")) return null;
  // enough to cover funding missing the fixed rate by one typical daily swing (sdApr) over the term
  const n = Number($("fNotional").value), t = parseInt($("fTenor").value, 10);
  if (!(n > 0 && t > 0)) return null;
  return Math.min(100, Math.max(1, Math.ceil(n * mkt.sdApr / 36500 * t)));
}
function avg7() { return daily.length ? daily.slice(-7).reduce((a, x) => a + x.rate, 0) / Math.min(7, daily.length) : null; }
function renderRateChips() {
  const box = $("rateChips"); if (!box) return;
  box.textContent = "";
  const a = avg7(); if (a !== null) setText("live7", aprOf(a));
  const opts = [];
  if (hourly.length) opts.push(["Right now", hourly[hourly.length - 1].rate * 365 * 100]);
  if (hourly.length) opts.push(["Last 24h", hourly.slice(-24).reduce((s2, x) => s2 + x.rate, 0) / Math.min(24, hourly.length) * 365 * 100]);
  if (a !== null) opts.push(["Last 7 days", a * 365 * 100]);
  for (const [label, v] of opts) {
    const b = document.createElement("button"); b.className = "chip"; b.textContent = `${label} ${v.toFixed(1)}%`;
    b.onclick = () => setApr(Math.round(v * 2) / 2);
    box.appendChild(b);
  }
  for (const d of [-2, 2]) { const b = document.createElement("button"); b.className = "chip"; b.textContent = `${d > 0 ? "+" : "−"}2%`; b.onclick = () => setApr(Number($("fApr").value) + d); box.appendChild(b); }
  applyTier();
}
const tierStep = () => Math.max(1, Math.round(mkt.sdApr) / 2); // % APR away from the fair rate: half a typical daily swing
function fairApr() { const a = avg7(); const r = a ?? (hourly.length ? hourly[hourly.length - 1].rate : null); return r === null ? null : r * 365 * 100; }
// "easy" concedes TIER_STEP to the taker: a fixed receiver asks less, a fixed payer offers more
function tierApr(t) { const f = fairApr(); if (f === null) return null; const sgn = side === "1" ? 1 : -1; return Math.round((f + (t === "easy" ? sgn : t === "better" ? -sgn : 0) * tierStep()) * 2) / 2; }
function applyTier() { if (aprEdited || !$("fApr")) return; const v = tierApr(tier); if (v !== null) setApr(v, true); }
function setApr(v, auto) { v = Math.max(-10, Math.min(40, v)); $("fApr").value = v.toFixed(1); if (!auto) aprEdited = true; updateSummary(); }
function syncChips() {
  document.querySelectorAll(".chips[data-for]").forEach((box) => {
    const v = $(box.dataset.for).value;
    box.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.v === v)));
  });
  document.querySelectorAll(".choice[data-goal]").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.goal === goal)));
  document.querySelectorAll(".choice[data-tier]").forEach((c) => c.setAttribute("aria-pressed", String(!aprEdited && c.dataset.tier === tier)));
  if (fairApr() !== null && $("tEasy")) {
    const rec = side === "1" ? "pay" : "receive";
    $("tEasy").textContent = `${rec} ${tierApr("easy").toFixed(1)}% · gives the other side a little extra, so it gets taken sooner`;
    $("tFair").textContent = `${rec} ${tierApr("fair").toFixed(1)}% · the last 7 days' average`;
    $("tBetter").textContent = `${rec} ${tierApr("better").toFixed(1)}% · better terms for you, may wait longer`;
  }
}
function updateSummary() {
  if (!$("fApr")) return;
  const sm = suggestedMargin();
  if (!marginEdited && sm !== null) $("fMargin").value = String(sm);
  { const r = Number($("fApr").value).toFixed(1);
    $("rateQ").textContent = { lock: "Fixed rate you receive", cap: "Fixed rate you pay", up: "Win if funding averages above", down: "Win if funding averages below" }[goal];
    $("goalLine").innerHTML = {
      lock: `You get <b>${r}% APR</b> no matter what funding does. If funding ends up higher, you give up the extra.`,
      cap: `You pay <b>${r}% APR</b> no matter what funding does. If funding ends up lower, you pay more than you would have.`,
      up: `You win if ${mkt.name} funding averages <b>above ${r}% APR</b> over the term.`,
      down: `You win if ${mkt.name} funding averages <b>below ${r}% APR</b> over the term.`,
    }[goal]; }
  $("aprRange").value = $("fApr").value; $("aprBig").textContent = `${Number($("fApr").value).toFixed(1)}% APR`;
  $("marginRange").value = $("fMargin").value; $("marginBig").textContent = `${Number($("fMargin").value)} USDC`;
  $("marginHint").textContent = sm !== null ? `Suggested ${sm} USDC for this size and term. Bigger deposit = your call can be wrong by more before it is capped. Max 100.` : "";
  const f = currentFixed(), n = Number($("fNotional").value), m = Number($("fMargin").value), t = parseInt($("fTenor").value, 10);
  const pays = side === "1";
  syncChips();
  renderPlan();
  if (!(f !== null && n > 0 && m > 0 && t > 0)) { $("sumText").textContent = ""; $("scen").textContent = ""; refreshAction(); return; }
  $("fRateDay").textContent = `= ${pct(f, 4)} per day`;
  $("sumText").innerHTML = pays
    ? `You <b>pay ${Number($("fApr").value).toFixed(1)}% APR fixed</b> and <b>receive the actual ${mkt.name} funding</b> on ${n.toLocaleString()} USDC for ${t} day${t > 1 ? "s" : ""}. You profit if funding averages above your rate. Most you can lose: <b>${m} USDC</b>.`
    : `You <b>receive ${Number($("fApr").value).toFixed(1)}% APR fixed</b> and <b>pay the actual ${mkt.name} funding</b> on ${n.toLocaleString()} USDC for ${t} day${t > 1 ? "s" : ""}. You profit if funding averages below your rate. Most you can lose: <b>${m} USDC</b>.`;
  const ref = avg7() ?? f;
  const rows = [[`If funding averages ${(f * 365 * 100 - 3.65).toFixed(1)}% APR (lower)`, f - 0.0001], ["If funding equals your fixed rate", f], [`If funding averages ${(f * 365 * 100 + 3.65).toFixed(1)}% APR (higher)`, f + 0.0001], [`If the last 7 days repeat (${aprOf(ref)} APR)`, ref]];
  $("sumText").innerHTML += ` Every 1% APR that funding misses your rate moves <b>±${(n * 0.01 / 365 * t).toFixed(2)} USDC</b>; the deposit is used up at a miss of ${(m / (n * t) * 36500).toFixed(1)}% APR.`;
  $("scen").innerHTML = "";
  for (const [label, actual] of rows) {
    let pnl = n * (actual - f) * t * (pays ? 1 : -1); pnl = Math.max(-m, Math.min(m, pnl));
    const tr = $("scen").insertRow(); tr.insertCell().textContent = label;
    tr.insertCell().textContent = (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " USDC";
  }
  drawChart(); drawPayoff(); refreshAction();
}
// "What will happen": the plan in plain words, next to the action button
function renderPlan() {
  const box = $("plan"); if (!box || !$("fApr")) return;
  const n = Number($("fNotional").value), t = parseInt($("fTenor").value, 10), m = Number($("fMargin").value), r = Number($("fApr").value);
  if (!(n > 0 && t > 0 && m > 0 && Number.isFinite(r))) { box.innerHTML = "<h4>What will happen</h4><p>Choose a size, a term and a deposit above.</p>"; return; }
  const M = mkt.name, rs = r.toFixed(1), ns = n.toLocaleString(), ms = m.toLocaleString();
  const per1 = (n * 0.01 / 365 * t).toFixed(2), fixedLeg = (n * r / 100 / 365 * t).toFixed(2);
  const days = `${t} day${t === 1 ? "" : "s"}`, refund = `If nobody takes it, cancel and get ${ms} USDC back.`;
  const text = {
    lock: `You lock <b>${ms} USDC</b> now. If someone takes it, for ${days} from the next UTC midnight you receive ${rs}% APR fixed on ${ns} USDC (<b>${fixedLeg} USDC</b>) and give the taker the actual ${M} funding. If funding ends lower, the contract pays you the difference, making up what your short earned less. If it ends higher, you pay the difference, but your short earned that extra. The most you can lose here is ${ms} USDC. ${refund}`,
    cap: `You lock <b>${ms} USDC</b> now. If someone takes it, for ${days} from the next UTC midnight you pay ${rs}% APR fixed on ${ns} USDC (<b>${fixedLeg} USDC</b>) and receive the actual ${M} funding from the taker. If funding ends higher, the contract pays you the difference, covering the extra your long pays. If it ends lower, you pay the difference, but your long paid that much less. The most you can lose here is ${ms} USDC. ${refund}`,
    up: `You lock <b>${ms} USDC</b>. If taken, you win ${per1} USDC for every 1% APR that ${M} funding averages above ${rs}% over ${days}, and lose the same below it, capped at ${ms} USDC either way. ${refund}`,
    down: `You lock <b>${ms} USDC</b>. If taken, you win ${per1} USDC for every 1% APR that ${M} funding averages below ${rs}% over ${days}, and lose the same above it, capped at ${ms} USDC either way. ${refund}`,
  }[goal];
  box.innerHTML = `<h4>What will happen</h4><p>${text}</p>`;
}
function drawPayoff() {
  const svg = $("payoff"); if (!svg) return;
  const f = currentFixed(), n = Number($("fNotional").value), m = Number($("fMargin").value), t = parseInt($("fTenor").value, 10);
  if (!(f !== null && n > 0 && m > 0 && t > 0)) { svg.innerHTML = ""; return; }
  const pays = side === "1";
  const W = svg.clientWidth || 800, H = 220, L = 52, R = 16, T = 18, B = 34;
  const fA = f * 365 * 100;                                   // fixed, % APR
  const capA = m / (n * t) * 365 * 100;                      // APR distance at which the deposit is used up
  const span = Math.max(capA * 1.5, 6);
  const x0 = fA - span, x1 = fA + span;
  const pnl = (a) => { let v = n * ((a - fA) / 100 / 365) * t * (pays ? 1 : -1); return Math.max(-m, Math.min(m, v)); };
  const X = (a) => L + (a - x0) / (x1 - x0) * (W - L - R);
  const Y = (v) => T + (m - v) / (2 * m) * (H - T - B);
  const mute = cssVar("--mute"), grid = cssVar("--grid");
  const parts = [];
  // win / lose zones
  const winLeft = !pays;
  parts.push(`<rect x="${X(x0)}" y="${T}" width="${X(fA) - X(x0)}" height="${H - T - B}" fill="${winLeft ? "var(--pos)" : "var(--neg)"}" opacity=".07"/>`);
  parts.push(`<rect x="${X(fA)}" y="${T}" width="${X(x1) - X(fA)}" height="${H - T - B}" fill="${winLeft ? "var(--neg)" : "var(--pos)"}" opacity=".07"/>`);
  for (const v of [m, 0, -m]) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? mute : grid}" stroke-width="1"/>`);
    parts.push(`<text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="${mute}">${v > 0 ? "+" : ""}${v.toFixed(v % 1 ? 2 : 0)}</text>`);
  }
  // payoff line: blue where you win, red where you lose
  const pts = (a, b) => { const out = []; for (let i = 0; i <= 60; i++) { const a2 = a + (b - a) * i / 60; out.push(`${X(a2)},${Y(pnl(a2))}`); } return out.join(" "); };
  const leftColor = winLeft ? "var(--pos)" : "var(--neg)", rightColor = winLeft ? "var(--neg)" : "var(--pos)";
  parts.push(`<polyline points="${pts(x0, fA)}" fill="none" stroke="${leftColor}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  parts.push(`<polyline points="${pts(fA, x1)}" fill="none" stroke="${rightColor}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  // fixed-rate marker
  parts.push(`<line x1="${X(fA)}" x2="${X(fA)}" y1="${T}" y2="${H - B}" stroke="var(--acc)" stroke-width="2"/>`);
  parts.push(`<text x="${X(fA)}" y="${T - 5}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--acc)">your fixed ${fA.toFixed(1)}%</text>`);
  // zone labels
  // "you win" sits at the bottom and "you lose" at the top: the payoff line runs high where you win and low where you lose
  const yWin = H - B - 8, yLose = T + 16;
  parts.push(`<text x="${(X(x0) + X(fA)) / 2}" y="${winLeft ? yWin : yLose}" text-anchor="middle" font-size="12" font-weight="700" fill="${leftColor}">${winLeft ? "you win" : "you lose"}</text>`);
  parts.push(`<text x="${(X(fA) + X(x1)) / 2}" y="${winLeft ? yLose : yWin}" text-anchor="middle" font-size="12" font-weight="700" fill="${rightColor}">${winLeft ? "you lose" : "you win"}</text>`);
  // 7-day average marker
  const a7 = avg7();
  if (a7 !== null) {
    const a7A = a7 * 365 * 100;
    if (a7A > x0 && a7A < x1) {
      parts.push(`<circle cx="${X(a7A)}" cy="${Y(pnl(a7A))}" r="5" fill="var(--ink)" stroke="var(--surface-2)" stroke-width="2"/>`);
      const away = a7A < fA ? -8 : 8; // put the label on the side away from the fixed-rate marker
      parts.push(`<text x="${X(a7A) + away}" y="${Y(pnl(a7A)) - 8}" text-anchor="${away < 0 ? "end" : "start"}" font-size="11" fill="var(--ink-2)">last 7 days: ${a7A.toFixed(1)}%</text>`);
    }
  }
  // x axis labels
  for (const a of [x0, (x0 + fA) / 2, fA, (fA + x1) / 2, x1]) parts.push(`<text x="${X(a)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="${mute}">${a.toFixed(1)}%</text>`);
  parts.push(`<text x="${W - R}" y="${H - 1}" text-anchor="end" font-size="11" fill="${mute}">average ${mkt.name} funding over the term (APR) →</text>`);
  parts.push(`<text x="${L}" y="${T - 5}" font-size="11" fill="${mute}">${W < 520 ? "USDC" : "profit / loss (USDC)"}</text>`);
  parts.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="phit"/>`);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = parts.join("");
  $("phit").addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect(), a = x0 + (ev.clientX - box.left - L) / (W - L - R) * (x1 - x0), v = pnl(a), tip = $("ptip");
    tip.textContent = `funding ${a.toFixed(1)}% APR → ${v >= 0 ? "+" : ""}${v.toFixed(2)} USDC`;
    tip.style.left = Math.min(ev.clientX - box.left + 12, box.width - tip.offsetWidth - 4) + "px"; tip.style.top = (ev.clientY - box.top - 34) + "px"; tip.style.opacity = 1;
  });
  $("phit").addEventListener("mouseleave", () => ($("ptip").style.opacity = 0));
}
function bindTicket() {
window.addEventListener("resize", () => drawPayoff());
document.querySelectorAll(".choice[data-goal]").forEach((c) => (c.onclick = () => { goal = c.dataset.goal; side = c.dataset.side; applyTier(); updateSummary(); }));
document.querySelectorAll(".choice[data-tier]").forEach((c) => (c.onclick = () => { tier = c.dataset.tier; aprEdited = false; applyTier(); updateSummary(); }));
document.querySelectorAll(".chips[data-for]").forEach((box) => box.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { $(box.dataset.for).value = c.dataset.v; updateSummary(); })));
$("aprRange").addEventListener("input", (e) => setApr(Number(e.target.value)));
$("marginRange").addEventListener("input", (e) => { $("fMargin").value = e.target.value; marginEdited = true; updateSummary(); });
document.querySelectorAll("#rangeTabs .chip").forEach((b) => (b.onclick = () => { tRange = b.dataset.range; document.querySelectorAll("#rangeTabs .chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b))); drawChart(); }));
$("fMargin").addEventListener("input", () => { marginEdited = true; updateSummary(); });
["fNotional", "fTenor", "fExpiry"].forEach((id) => $(id).addEventListener("input", updateSummary));
}

// ---------------------------------------------------------------- wallet & the one action button
let onArc = false;
function setCheck(id, state, text) { const el = $(id); if (!el) return; el.className = state; if (text) el.textContent = text; }
async function readBalances() {
  if (!signer || !onArc) { usdcBal = allowance = null; return; }
  const token = new ethers.Contract(CFG.usdc, ERC20_ABI, read);
  [usdcBal, allowance] = await Promise.all([token.balanceOf(me), token.allowance(me, CFG.swap)]);
}
function refreshAction() {
  const btn = $("actionBtn"), note = $("actionNote");
  if (!btn || !note) return;
  let need = null; try { need = readForm().margin; } catch { need = null; }
  setCheck("cWallet", signer ? "ok" : "", signer ? `Wallet ${short(me)}` : "Wallet connected");
  setCheck("cChain", signer ? (onArc ? "ok" : "bad") : "");
  const enough = usdcBal !== null && need !== null && usdcBal >= need;
  setCheck("cBal", usdcBal === null ? "" : enough ? "ok" : "bad", usdcBal === null ? "Enough USDC" : `${usdc(usdcBal)} USDC on Arc`);
  const approved = allowance !== null && need !== null && allowance >= need;
  setCheck("cAllow", allowance === null ? "" : approved ? "ok" : "", "Deposit approved");
  btn.disabled = false;
  if (!signer) { btn.textContent = "Connect wallet"; btn.onclick = connect; note.textContent = "MetaMask, Rabby or any EVM wallet."; return; }
  if (!onArc) { btn.textContent = "Switch to Arc"; btn.onclick = connect; note.textContent = "Arc mainnet, chain 5042."; return; }
  if (!enough) { btn.textContent = "Not enough USDC"; btn.disabled = true; note.innerHTML = `Bridge USDC to Arc with <a href="https://across.to" target="_blank" rel="noopener">Across</a>, then refresh.`; return; }
  if (!approved) { btn.textContent = `Approve ${usdc(need)} USDC`; btn.onclick = approve; note.textContent = "Step 1 of 2: lets the contract take your deposit."; return; }
  btn.textContent = "Post offer"; btn.onclick = post; note.textContent = "Step 2 of 2: you can cancel any time before it is taken.";
}
async function connect() {
  if (!window.ethereum) { log("No browser wallet found. Install MetaMask or Rabby."); return; }
  try {
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x" + CFG.chainId.toString(16), chainName: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [CFG.rpc], blockExplorerUrls: [CFG.explorer] }] });
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CFG.chainId.toString(16) }] }).catch(() => {});
    const bp = new ethers.BrowserProvider(window.ethereum);
    signer = await bp.getSigner(); me = await signer.getAddress();
    onArc = Number((await bp.getNetwork()).chainId) === CFG.chainId;
    setText("connect", short(me));
    log(`connected ${me}${onArc ? "" : " (not on Arc)"}`);
    await readBalances(); refreshAction(); await loadSwaps();
  } catch (e) { log(`connect failed: ${e.shortMessage || e.message}`); }
}
async function approve() {
  const btn = $("actionBtn"); btn.disabled = true; btn.textContent = "Approving…";
  try {
    const token = new ethers.Contract(CFG.usdc, ERC20_ABI, signer);
    const r = await (await token.approve(CFG.swap, readForm().margin)).wait();
    log(`approved: ${r.hash}`);
  } catch (e) { log(`approve failed: ${e.shortMessage || e.message}`); }
  await readBalances(); refreshAction();
}
async function post() {
  const btn = $("actionBtn"); btn.disabled = true; btn.textContent = "Posting…";
  const f = readForm();
  await tx("post offer", (c) => c.createOffer(mkey(mkt), f.paysFixed, f.notional, f.margin, f.rate, f.tenor, f.expiry));
  await readBalances(); refreshAction();
  if ($("offers")) location.hash = "#offers";
}
if ($("connect")) $("connect").onclick = connect;
if (window.ethereum) { window.ethereum.on?.("accountsChanged", () => connect()); window.ethereum.on?.("chainChanged", () => connect()); }

// ---------------------------------------------------------------- boot
function fillContracts() {
  for (const [id, addr] of [["Oracle", CFG.oracle], ["Swap", CFG.swap]]) {
    const a = $("a" + id), so = $("s" + id);
    if (a) { a.textContent = short(addr); a.href = `${CFG.explorer}/address/${addr}`; }
    if (so) so.href = `https://repo.sourcify.dev/contracts/full_match/${CFG.chainId}/${addr}/`;
  }
}
async function bootMarkets() {
  try { await discoverMarkets(); } catch (e) { log(`market list: ${e.shortMessage || e.message}`); renderMarketChips(); }
}
fillContracts();
switch (PAGE) {
  case "home":
    renderMarketChips();
    (async () => {
      await bootMarkets();
      try { await loadMarket(); } catch (e) { setText("chartNote", `Could not read the oracle: ${e.shortMessage || e.message}`); }
    })();
    break;
  case "hedge":
  case "predict":
    bindTicket();
    renderMarketChips();
    updateSummary();
    (async () => {
      await bootMarkets();
      loadLive().catch((e) => log(`live funding unavailable: ${e.message}`));
      try { await loadMarket(); } catch (e) { setText("chartNote", `Could not read the oracle: ${e.shortMessage || e.message}`); log(`oracle: ${e.shortMessage || e.message}`); }
      try { await loadSwaps(); } catch (e) { log(e.shortMessage || e.message); const b = $("swaps"); if (b) b.innerHTML = `<tr><td colspan="9" class="empty">Could not read offers from Arc. Try again later.</td></tr>`; }
    })();
    break;
  case "how":
  default:
    break;
}
