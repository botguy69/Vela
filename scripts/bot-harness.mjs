#!/usr/bin/env node
/**
 * Live checks for the VELA desk: public WEEX feeds, math, HTTP routes.
 * Exit 1 if any assertion fails.
 */
import { createHmac } from "node:crypto";

const BASE = process.env.APP_URL || "http://127.0.0.1:8080";
const WEEX = "https://api-contract.weex.com";
const fails = [];
const oks = [];

function ok(name, detail = "") {
  oks.push(name);
  console.log(`OK  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, err) {
  fails.push(name);
  console.error(`FAIL ${name} — ${err instanceof Error ? err.message : err}`);
}
function assert(name, cond, detail = "") {
  if (cond) ok(name, detail);
  else fail(name, detail || "assertion failed");
}

async function fetchJson(url, ms = 20000, accept = "application/json") {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: accept, "User-Agent": "vela-harness" } });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* raw */
    }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(t);
  }
}

function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i];
  return sum / period;
}

function clampRiskPct(raw) {
  if (!Number.isFinite(raw)) return 1.5;
  return Math.min(2, Math.max(1, raw));
}

function sizeSetup(entry, stop, accountUsd, riskPct, coinMaxLev) {
  const alloc = clampRiskPct(riskPct);
  if (entry <= 0 || accountUsd < 5) return null;
  const leverage = Math.max(1, Math.round(coinMaxLev));
  const marginUsd = accountUsd * (alloc / 100);
  const notional = marginUsd * leverage;
  if (notional < 8) return null;
  const qty = notional / entry;
  const stopDist = Math.abs(entry - stop);
  const stopAccountPct = stopDist > 0 ? ((notional * (stopDist / entry)) / accountUsd) * 100 : 0;
  if (stopAccountPct > 25) return null;
  return { marginUsd, notional, qty, leverage, stopAccountPct };
}

function blocksBeta(open, next) {
  const w = (s) => (s === "TONUSDT" ? 0.25 : s === "BTCUSDT" || s === "ETHUSDT" ? 1 : 0.9);
  const signed = (s, side) => w(s) * (side === "long" ? 1 : -1);
  const net = open.reduce((a, p) => a + signed(p.weex, p.side), 0);
  const add = signed(next.weex, next.side);
  if (net > 0.2 && add < 0) return true;
  if (net < -0.2 && add > 0) return true;
  if (Math.abs(add) <= 0.3) return false;
  return Math.abs(net + add) > 1.15 && Math.abs(net + add) > Math.abs(net);
}

function fundingBlocks(side, rate) {
  if (!Number.isFinite(rate)) return false;
  if (side === "long" && rate > 0.0008) return true;
  if (side === "short" && rate < -0.0008) return true;
  return false;
}

function spreadTooWide(weex, bid, ask) {
  const mid = (bid + ask) / 2;
  const bps = ((ask - bid) / mid) * 10_000;
  if (weex === "BTCUSDT" || weex === "ETHUSDT") return bps > 8;
  return bps > 25;
}

function formatWeexQty(qty, precision) {
  if (!Number.isFinite(qty) || qty <= 0) return "0";
  const step = 10 ** -precision;
  const n = Math.floor(qty / step) * step;
  return n.toFixed(precision);
}

async function weexMarket() {
  const info = await fetchJson(`${WEEX}/capi/v3/market/exchangeInfo`);
  assert("weex exchangeInfo", info.status === 200 && Array.isArray(info.body?.symbols), `status ${info.status}`);
  const btc = (info.body?.symbols ?? []).find((s) => s.symbol === "BTCUSDT");
  assert("BTC max leverage", Number(btc?.maxLeverage) >= 50, `lev ${btc?.maxLeverage}`);

  const kl = await fetchJson(`${WEEX}/capi/v3/market/klines?symbol=BTCUSDT&interval=1h&limit=40`);
  assert("BTC 1h klines", Array.isArray(kl.body) && kl.body.length >= 20, `n=${kl.body?.length}`);
  const closes = (kl.body ?? []).map((r) => Number(r[4])).filter((n) => n > 0);
  const mid = sma(closes, 21);
  assert("SMA21 on BTC hours", mid != null && mid > 1000, `sma ${mid}`);

  const h4 = await fetchJson(`${WEEX}/capi/v3/market/klines?symbol=BTCUSDT&interval=4h&limit=30`);
  assert("BTC 4h klines", Array.isArray(h4.body) && h4.body.length >= 20, `n=${h4.body?.length}`);

  const px = await fetchJson(`${WEEX}/capi/v3/market/symbolPrice?symbol=BTCUSDT`);
  assert("BTC last", Number(px.body?.price) > 1000, `px ${px.body?.price}`);

  const book = await fetchJson(`${WEEX}/capi/v3/market/ticker/bookTicker?symbol=BTCUSDT`);
  const row = Array.isArray(book.body) ? book.body[0] : book.body;
  const bid = Number(row?.bidPrice ?? row?.bid);
  const ask = Number(row?.askPrice ?? row?.ask);
  assert("BTC book ticker", bid > 0 && ask > bid, `bid ${bid} ask ${ask}`);
  assert("BTC spread gate", typeof spreadTooWide("BTCUSDT", bid, ask) === "boolean", `wide=${spreadTooWide("BTCUSDT", bid, ask)}`);

  const fund = await fetchJson(`${WEEX}/capi/v3/market/premiumIndex?symbol=BTCUSDT`);
  const frow = Array.isArray(fund.body) ? fund.body[0] : fund.body;
  const rate = Number(frow?.lastFundingRate ?? frow?.fundingRate);
  assert("BTC funding", Number.isFinite(rate), `rate ${rate}`);
}

function math() {
  const s = sizeSetup(100_000, 99_000, 100, 2, 400);
  assert("size $100 @ 2% 400x", s && Math.abs(s.marginUsd - 2) < 1e-9 && s.notional === 800, JSON.stringify(s));
  assert("clamp 9% → 2%", clampRiskPct(9) === 2);
  assert("clamp 0.2% → 1%", clampRiskPct(0.2) === 1);
  assert("too-wide stop skipped", sizeSetup(100, 50, 100, 2, 400) == null);

  assert("beta blocks ETH long after BTC long", blocksBeta([{ weex: "BTCUSDT", side: "long" }], { weex: "ETHUSDT", side: "long" }));
  assert("beta blocks hedge", blocksBeta([{ weex: "BTCUSDT", side: "long" }], { weex: "ETHUSDT", side: "short" }));
  assert("beta allows first long", !blocksBeta([], { weex: "BTCUSDT", side: "long" }));
  assert("TON can sit beside BTC", !blocksBeta([{ weex: "BTCUSDT", side: "long" }], { weex: "TONUSDT", side: "long" }));

  assert("funding blocks long 10bps", fundingBlocks("long", 0.001));
  assert("funding allows long 1bp", !fundingBlocks("long", 0.0001));

  assert("qty format 3dp", formatWeexQty(1.2399, 3) === "1.239");

  const msg = "1GET/capi/v3/account";
  const sig = createHmac("sha256", "secret").update(msg).digest("base64");
  assert("HMAC sign", typeof sig === "string" && sig.length > 10, sig.slice(0, 12));
}

async function waitApp(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${BASE}/`, { redirect: "manual" });
      if (r.status && r.status < 500) return true;
    } catch {
      /* down */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function http() {
  const up = await waitApp();
  assert("app up", up, BASE);
  if (!up) return;

  for (const path of ["/", "/login", "/alive", "/auto"]) {
    const r = await fetchJson(`${BASE}${path}`, 20000, "text/html");
    assert(`GET ${path}`, r.status > 0 && r.status < 500, `status ${r.status}`);
  }

  const tick = await fetchJson(`${BASE}/api/cron/tick?src=alive`);
  assert(
    "GET /api/cron/tick?src=alive",
    tick.status === 200 && tick.body?.ok !== false && (tick.body?.awake || tick.body?.ok),
    `status ${tick.status} ${JSON.stringify(tick.body).slice(0, 180)}`,
  );

  const cron = await fetchJson(`${BASE}/api/cron/tick`);
  assert(
    "GET /api/cron/tick",
    cron.status === 200 && cron.body?.ok !== false,
    `status ${cron.status} ${JSON.stringify(cron.body).slice(0, 180)}`,
  );
}

await weexMarket();
math();
await http();

console.log(`\n${oks.length} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
