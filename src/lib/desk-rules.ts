import type { Candle } from "./engine";
import { breakevenPrice, type RawSetup, type Side, type Style } from "./ta";

/** Most of the top 25 is one BTC trade. TON is the only soft exception. */
export function betaWeight(weex: string): number {
  if (weex === "TONUSDT") return 0.25;
  if (weex === "BTCUSDT" || weex === "ETHUSDT") return 1;
  return 0.9;
}

export function signedBeta(weex: string, side: Side): number {
  return betaWeight(weex) * (side === "long" ? 1 : -1);
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i += 1) e += values[i]!;
  e /= period;
  for (let i = period; i < values.length; i += 1) e = values[i]! * k + e * (1 - k);
  return e;
}

/** Two same-side tickets is the cap. Don't treat a 2nd alt as a 3rd BTC clone. */
export const BETA_SOFT = 2.05;

export function sameSideBeta(open: { weex: string; side: Side }[], side: Side): number {
  return open.filter((p) => p.side === side).reduce((s, p) => s + betaWeight(p.weex), 0);
}

export function blocksBeta(
  _open: { weex: string; side: Side }[],
  _next: { weex: string; side: Side },
  _opts?: { diverges?: boolean },
): boolean {
  return false;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i]!;
  return sum / period;
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return sma(trs, period);
}

/** 4h 21 SMA + S/R. BTC heat aligned → 2% band. Else 0.3%. Bounce/dump still veto. */
export function htfAllows(
  side: Side,
  fourHour: Candle[],
  heat: "long" | "short" | "chop" = "chop",
): boolean {
  if (fourHour.length < 24) return true;
  const closes = fourHour.map((c) => c.close);
  const mid = sma(closes, 21);
  const last = closes[closes.length - 1];
  if (mid == null || last == null) return true;
  const band = heat === side ? 0.02 : 0.003;
  if (side === "long" && last < mid * (1 - band)) return false;
  if (side === "short" && last > mid * (1 + band)) return false;
  const prior = fourHour.slice(-21, -1);
  if (prior.length < 8) return true;
  const sh = Math.max(...prior.map((c) => c.high));
  const sl = Math.min(...prior.map((c) => c.low));
  const a = atr(fourHour, 14) ?? 0;
  if (a <= 0) return true;
  if (side === "long" && last >= sh - 0.2 * a) return false;
  if (side === "short" && last <= sl + 0.2 * a) return false;
  return true;
}

function rsiAt(closes: number[], end: number, period = 14): number | null {
  if (end - period < 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = end - period; i < end; i += 1) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Price made a new extreme, RSI did not — confirms RSI-knife, doesn't replace structure. */
export function rsiDivergence(hourly: Candle[], side: Side): boolean {
  if (hourly.length < 24) return false;
  const closes = hourly.map((c) => c.close);
  const last = hourly.slice(-8);
  const prev = hourly.slice(-16, -8);
  const rNow = rsiAt(closes, closes.length);
  const rPrev = rsiAt(closes, Math.max(14, closes.length - 8));
  if (rNow == null || rPrev == null) return false;
  if (side === "long") {
    const pLo = Math.min(...last.map((c) => c.low));
    const pLo2 = Math.min(...prev.map((c) => c.low));
    return pLo <= pLo2 * 1.002 && rNow >= rPrev + 1.5 && rNow <= 42;
  }
  const pHi = Math.max(...last.map((c) => c.high));
  const pHi2 = Math.max(...prev.map((c) => c.high));
  return pHi >= pHi2 * 0.998 && rNow <= rPrev - 1.5 && rNow >= 58;
}

/** 15m mean must not be selling a 1h long (and reverse). */
export function ltfAllows(side: Side, fifteen: Candle[]): boolean {
  if (fifteen.length < 24) return true;
  const closes = fifteen.map((c) => c.close);
  const mid = sma(closes, 21);
  const last = closes[closes.length - 1];
  if (mid == null || last == null) return true;
  if (side === "long") return last >= mid * 0.992;
  return last <= mid * 1.008;
}

/**
 * 15m entry: EMA 9/21 pullback + session VWAP.
 * Above VWAP favor longs. Below favor shorts. Chop across VWAP = skip.
 */
export function sessionVwap(candles: Candle[], bars = 96): number | null {
  const win = candles.slice(-Math.min(bars, candles.length));
  if (win.length < 12) return null;
  let pv = 0;
  let vol = 0;
  for (const c of win) {
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume > 0 ? c.volume : 1;
    pv += tp * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

function vwapCrosses(candles: Candle[], n: number, vwap: number): number {
  const win = candles.slice(-n);
  let x = 0;
  for (let i = 1; i < win.length; i += 1) {
    const a = win[i - 1]!.close - vwap;
    const b = win[i]!.close - vwap;
    if (a * b < 0) x += 1;
  }
  return x;
}

export function ltfTrigger(
  side: Side,
  fifteen: Candle[],
): { ok: boolean; wait: boolean; reason: string; pullback: number | null } {
  if (fifteen.length < 24) return { ok: true, wait: false, reason: "thin 15m", pullback: null };
  const closes = fifteen.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e200 = ema(closes, 200);
  const a = atr(fifteen, 14);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (e9 == null || e21 == null || a == null || a <= 0 || last == null) {
    return { ok: true, wait: false, reason: "thin 15m", pullback: null };
  }
  const lastBar = fifteen[fifteen.length - 1]!;
  const trs: number[] = [];
  for (let i = Math.max(1, fifteen.length - 50); i < fifteen.length; i += 1) {
    const c = fifteen[i]!;
    const p = fifteen[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const medAtr = [...trs].sort((x, y) => x - y)[Math.floor(trs.length / 2)] ?? a;
  if (a < 0.45 * medAtr || a / last < 0.0012) {
    return { ok: false, wait: false, reason: "ATR dead — fees eat 1R", pullback: null };
  }
  const vols = fifteen.slice(-20).map((c) => c.volume).filter((v) => v > 0).sort((x, y) => x - y);
  const medVol = vols[Math.floor(vols.length / 2)] ?? 0;
  const volR = medVol > 0 ? lastBar.volume / medVol : 1;
  if (volR < 0.5) return { ok: false, wait: false, reason: "15m dry-up", pullback: null };
  const chaseVol =
    volR >= 2.2 &&
    ((side === "long" && lastBar.close > lastBar.open && last > e21 + 0.35 * a) ||
      (side === "short" && lastBar.close < lastBar.open && last < e21 - 0.35 * a));
  if (chaseVol) return { ok: false, wait: false, reason: "15m climax chase", pullback: null };
  let fails = 0;
  for (const c of fifteen.slice(-8)) {
    const tagged = Math.abs(c.close - e21) <= 0.2 * a;
    if (!tagged) continue;
    if (side === "long" && c.close < c.open) fails += 1;
    if (side === "short" && c.close > c.open) fails += 1;
  }
  if (fails >= 2) {
    return { ok: false, wait: true, reason: "limit at 21 — level tagged", pullback: e21 };
  }
  const vwap = sessionVwap(fifteen, Math.min(288, fifteen.length));
  if (vwap != null && vwapCrosses(fifteen, 8, vwap) >= 3) {
    return { ok: false, wait: false, reason: "VWAP chop", pullback: null };
  }
  const mean = (e9 + e21) / 2;
  const reclaim =
    vwap != null && prev != null
      ? side === "long"
        ? prev < vwap && last >= vwap
        : prev > vwap && last <= vwap
      : false;
  if (vwap != null && !reclaim) {
    if (side === "long" && last < vwap * 0.998) {
      return { ok: false, wait: true, reason: "limit — below VWAP", pullback: vwap };
    }
    if (side === "short" && last > vwap * 1.002) {
      return { ok: false, wait: true, reason: "limit — above VWAP", pullback: vwap };
    }
  }
  if (side === "long") {
    if (last < e21 - 0.7 * a) {
      return { ok: false, wait: true, reason: "limit at 21 — still dumping", pullback: e21 };
    }
    if (last > e21 + 0.35 * a && !reclaim) {
      return { ok: false, wait: true, reason: "limit at 15m mean / VWAP", pullback: vwap ?? mean };
    }
    return { ok: true, wait: false, reason: reclaim ? "VWAP reclaim" : "15m pullback + VWAP", pullback: mean };
  }
  if (last > e21 + 0.7 * a) {
    return { ok: false, wait: true, reason: "limit at 21 — still ripping", pullback: e21 };
  }
  if (last < e21 - 0.35 * a && !reclaim) {
    return { ok: false, wait: true, reason: "limit at 15m mean / VWAP", pullback: vwap ?? mean };
  }
  return { ok: true, wait: false, reason: reclaim ? "VWAP reject" : "15m bounce + VWAP", pullback: mean };
}

/** BTC is heat, not a compass. Hard chop → 1 seat. Mixed → 2 same-side. Offer/bid → 4. */
export function btcHeat(fifteen: Candle[]): {
  chop: boolean;
  side: "long" | "short" | "chop";
  maxSeats: number;
  note: string;
} {
  if (fifteen.length < 24) return { chop: true, side: "chop", maxSeats: 4, note: "BTC 15m thin — info only. 4 seats, best A++." };
  const closes = fifteen.map((c) => c.close);
  const last = closes[closes.length - 1];
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const vwap = sessionVwap(fifteen);
  if (last == null) return { chop: true, side: "chop", maxSeats: 4, note: "BTC 15m thin — info only. 4 seats, best A++." };
  const crosses = vwap != null ? vwapCrosses(fifteen, 8, vwap) : 0;
  const tangled = e9 != null && e21 != null && Math.abs(e9 - e21) / e21 < 0.0015;
  const midVwap = vwap != null && Math.abs(last - vwap) / vwap < 0.002;
  if (crosses >= 3 || (tangled && midVwap)) {
    return { chop: true, side: "chop", maxSeats: 4, note: "BTC 15m chop — heat info only." };
  }
  if (e9 != null && e21 != null && last > e21 && e9 >= e21 * 0.999) {
    return { chop: false, side: "long", maxSeats: 4, note: "BTC 15m bid — heat info." };
  }
  if (e9 != null && e21 != null && last < e21 && e9 <= e21 * 1.001) {
    return { chop: false, side: "short", maxSeats: 4, note: "BTC 15m offer — heat info." };
  }
  return { chop: true, side: "chop", maxSeats: 4, note: "BTC 15m mixed — heat info only." };
}

/** 1h decides long-book vs short-book. 15m heat is display only. */
export function btcBook(hourly: Candle[]): { side: "long" | "short" | "chop"; note: string } {
  if (hourly.length < 24) return { side: "chop", note: "BTC 1h thin — no book side." };
  const closes = hourly.map((c) => c.close);
  const last = closes[closes.length - 1];
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  if (last == null || e9 == null || e21 == null) return { side: "chop", note: "BTC 1h thin — no book side." };
  if (last > e21 && e9 >= e21 * 0.999) return { side: "long", note: "BTC 1h bid — long book." };
  if (last < e21 && e9 <= e21 * 1.001) return { side: "short", note: "BTC 1h offer — short book." };
  return { side: "chop", note: "BTC 1h mixed — book from live majority." };
}

/** Stop: 1.0–1.5× 15m ATR or beyond the pullback swing. Never a tick behind VWAP. */
export function structureStop(side: Side, entry: number, stop: number, fifteen: Candle[]): number {
  const a = atr(fifteen, 14);
  if (a == null || a <= 0 || entry <= 0) return stop;
  const win = fifteen.slice(-8);
  const swing = side === "long" ? Math.min(...win.map((c) => c.low)) : Math.max(...win.map((c) => c.high));
  const atrStop = side === "long" ? entry - 1.25 * a : entry + 1.25 * a;
  const swingStop = side === "long" ? swing - 0.2 * a : swing + 0.2 * a;
  let s = side === "long" ? Math.min(stop, atrStop, swingStop) : Math.max(stop, atrStop, swingStop);
  const vwap = sessionVwap(fifteen);
  if (vwap != null && Math.abs(s - vwap) / vwap < 0.0018) {
    s = side === "long" ? Math.min(s, vwap - 0.45 * a, swingStop) : Math.max(s, vwap + 0.45 * a, swingStop);
  }
  if (side === "long" && !(s < entry)) s = entry - 1.25 * a;
  if (side === "short" && !(s > entry)) s = entry + 1.25 * a;
  return s;
}

/** Book side from BTC heat, else live majority. Max one opposite, and only extreme A++ after 2+ with-tape. */
export function mixAllows(
  pickSide: Side,
  thesis: string,
  conf: number,
  heat: "long" | "short" | "chop",
  live: { side: string }[],
): { ok: boolean; why: string } {
  const liveL = live.filter((p) => (p.side === "short" ? "short" : "long") === "long").length;
  const liveS = live.filter((p) => p.side === "short").length;
  const book: Side | "chop" =
    heat !== "chop" ? heat : liveL + liveS === 0 ? "chop" : liveL >= liveS ? "long" : "short";
  if (book === "chop" || pickSide === book) return { ok: true, why: "with book" };
  const withN = book === "short" ? liveS : liveL;
  const againstN = book === "short" ? liveL : liveS;
  if (againstN >= 1) return { ok: false, why: `already 1 ${pickSide} vs ${book} book` };
  if (withN < 2) return { ok: false, why: `need 2+ ${book} before a special ${pickSide}` };
  const extreme = /double (top|bottom)|Pin bar|failed range|climax rejection|vol fade|buyers on 2nd|supply on 2nd/i.test(
    thesis,
  );
  if (!extreme || conf < 88) return { ok: false, why: `special ${pickSide} needs 88% extreme vs ${book}` };
  return { ok: true, why: "special 1-lot vs book" };
}
export function divergesFromBtc(side: Side, coin15: Candle[], btc15: Candle[]): boolean {
  if (coin15.length < 24 || btc15.length < 24) return false;
  const coinWith = ltfAllows(side, coin15);
  const btcWith = ltfAllows(side, btc15);
  return coinWith && !btcWith;
}

/** Live tape, not last week's P&L. 4h+1h agree = bias. Mixed = chop. */
export function marketBias(
  fourHour: Candle[],
  hourly: Candle[],
  fifteen: Candle[],
): { bias: "long" | "short" | "chop"; note: string } {
  const h4L = htfAllows("long", fourHour);
  const h4S = htfAllows("short", fourHour);
  const h1L = htfAllows("long", hourly);
  const h1S = htfAllows("short", hourly);
  if (h4L && h1L) {
    const ltf = ltfAllows("long", fifteen);
    return {
      bias: "long",
      note: ltf
        ? "BTC pumping — longs only. No fade shorts."
        : "BTC pumping, 15m pausing — longs only. Wait for 15m. No fade shorts.",
    };
  }
  if (h4S && h1S) {
    const ltf = ltfAllows("short", fifteen);
    return {
      bias: "short",
      note: ltf
        ? "BTC bleeding — shorts only. No dip-buy longs."
        : "BTC bleeding, 15m pausing — shorts only. Wait for 15m. No dip-buy longs.",
    };
  }
  return { bias: "chop", note: "BTC mixed / chopping. A++ both ways. 15m must confirm." };
}

/** Snap limit to the 15m mean. Stop / targets stay — breathing room is unchanged. */
export function withLtfEntry(setup: RawSetup, pullback: number | null): RawSetup {
  if (pullback == null || !(pullback > 0)) return setup;
  if (setup.side === "long") {
    if (pullback <= setup.stop) return setup;
    const entry = Math.min(setup.entry, pullback);
    const near = Math.abs(setup.last - entry) < 0.2 * setup.atr;
    return { ...setup, entry, entryType: near ? "market" : "limit" };
  }
  if (pullback >= setup.stop) return setup;
  const entry = Math.max(setup.entry, pullback);
  const near = Math.abs(setup.last - entry) < 0.2 * setup.atr;
  return { ...setup, entry, entryType: near ? "market" : "limit" };
}

export function spreadBps(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return 999;
  return ((ask - bid) / mid) * 10_000;
}

export function closedCandles(candles: Candle[], intervalMs: number): Candle[] {
  const openMs = (t: number) => (t > 0 && t < 1e12 ? t * 1000 : t);
  const cutoff = Date.now() - intervalMs;
  return candles.filter((c) => openMs(c.time) <= cutoff);
}

export function sizeMult(weex: string): number {
  if (weex === "BTCUSDT" || weex === "ETHUSDT") return 1;
  if (weex === "BNBUSDT" || weex === "XRPUSDT" || weex === "SOLUSDT") return 0.7;
  return 0.45;
}

export function spreadTooWide(weex: string, bid: number, ask: number): boolean {
  const bps = spreadBps(bid, ask);
  if (weex === "BTCUSDT" || weex === "ETHUSDT") return bps > 8;
  if (weex === "BNBUSDT" || weex === "XRPUSDT" || weex === "SOLUSDT") return bps > 15;
  return bps > 18;
}

/** True if lifting/hitting our size would walk > ~0.2% of the book. Fail open if depth missing. */
export function depthTooThin(
  side: Side,
  entry: number,
  notional: number,
  bids: [number, number][],
  asks: [number, number][],
): boolean {
  if (!(entry > 0) || !(notional > 0)) return false;
  const band = entry * 0.002;
  const levels = side === "long" ? asks : bids;
  let usd = 0;
  for (const [px, qty] of levels) {
    if (side === "long" && px > entry + band) continue;
    if (side === "short" && px < entry - band) continue;
    usd += px * qty;
  }
  return usd < notional * 2;
}

export function limitMaxAgeMs(style: Style): number {
  return style === "scalp" ? 4 * 3600_000 : 10 * 3600_000;
}

/** Fills before this keep the old clock. Scalp fills still red after 6h flatten. Green / BE hold. */
export const CHOP_V2_SINCE = Date.parse("2026-08-24T02:00:00.000Z");

export function fillMaxAgeMs(style: Style): number {
  return style === "scalp" ? 6 * 3600_000 : 12 * 3600_000;
}

export function shouldCancelStaleLimit(createdAt: string | Date, style: Style): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > limitMaxAgeMs(style);
}

/** Dead loser after 6h → flatten. Green / BE hold. */
export function chopAction(opts: {
  since: string | Date;
  style: Style;
  side: Side;
  entry: number;
  last: number;
  stop: number;
  beMoved: boolean;
}): "hold" | "flatten" {
  if (opts.beMoved) return "hold";
  const t = new Date(opts.since).getTime();
  if (!Number.isFinite(t)) return "hold";
  if (t < CHOP_V2_SINCE) return "hold";
  const age = Date.now() - t;
  if (age < fillMaxAgeMs(opts.style)) return "hold";
  const risk = Math.abs(opts.entry - opts.stop);
  const favor = opts.side === "long" ? opts.last - opts.entry : opts.entry - opts.last;
  const r = risk > 0 ? favor / risk : 0;
  if (r >= 0) return "hold";
  return "flatten";
}

export function shouldTimeStopFill(opts: {
  since: string | Date;
  style: Style;
  side: Side;
  entry: number;
  last: number;
  stop: number;
}): boolean {
  return (
    chopAction({ ...opts, beMoved: false }) === "flatten"
  );
}

/** Alts don't long into a BTC 15m dump (and reverse). */
export function btcLeads(side: Side, btc15: Candle[]): boolean {
  return ltfAllows(side, btc15);
}

export function trailStop(opts: {
  side: Side;
  entry: number;
  stop: number;
  hourly: Candle[];
  fifteen?: Candle[];
}): number | null {
  const book =
    opts.fifteen && opts.fifteen.length >= 12 ? opts.fifteen.slice(-12) : opts.hourly.slice(-8);
  const a = atr(opts.fifteen && opts.fifteen.length >= 16 ? opts.fifteen : opts.hourly, 14);
  if (a == null || a <= 0 || book.length < 6) return null;
  const be = breakevenPrice(opts.side, opts.entry);
  if (opts.side === "long") {
    const floor = Math.min(...book.map((c) => c.low)) - 0.12 * a;
    const next = Math.max(opts.stop, floor, be);
    return next > opts.stop * 1.0002 ? next : null;
  }
  const ceil = Math.max(...book.map((c) => c.high)) + 0.12 * a;
  const next = Math.min(opts.stop, ceil, be);
  return next < opts.stop * 0.9998 ? next : null;
}

/** BTC hourly ATR vs its own recent median — stand down on a shock wick, not a trend grind. */
export function regimeState(btcHourly: Candle[]): { hot: boolean; ratio: number; atr: number; med: number } {
  const empty = { hot: false, ratio: 0, atr: 0, med: 0 };
  const now = atr(btcHourly, 14);
  if (now == null || now <= 0 || btcHourly.length < 40) return empty;
  const window: number[] = [];
  for (let i = 20; i < btcHourly.length; i += 1) {
    const a = atr(btcHourly.slice(0, i + 1), 14);
    if (a) window.push(a);
  }
  if (window.length < 8) return empty;
  const sorted = [...window].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  const ratio = now / med;
  const last = btcHourly[btcHourly.length - 1]!;
  const prev = btcHourly[btcHourly.length - 2];
  const range = last.high - last.low;
  const prevRange = prev ? prev.high - prev.low : 0;
  const shock = range > now * 1.7 || (range > now * 1.25 && prevRange > now * 1.25);
  return { hot: ratio > 2.2 && shock, ratio, atr: now, med };
}

export function regimeHot(btcHourly: Candle[]): boolean {
  return regimeState(btcHourly).hot;
}

/** Skip chasing the side already paying up for funding. */
export function fundingBlocks(side: Side, rate: number): boolean {
  if (!Number.isFinite(rate)) return false;
  if (side === "long" && rate > 0.0008) return true;
  if (side === "short" && rate < -0.0008) return true;
  return false;
}

export type PlanRecord = { plan: string; closed: number; wins: number; pnl: number };

export type ClosedTicket = {
  plan: string | null;
  side: string | null;
  weex: string | null;
  pnl: number;
};

export type Ledger = {
  plans: PlanRecord[];
  skipSymbols: Set<string>;
  note: string;
};

function bucket(map: Map<string, PlanRecord>, key: string, pnl: number) {
  const cur = map.get(key) ?? { plan: key, closed: 0, wins: 0, pnl: 0 };
  cur.closed += 1;
  if (pnl > 0) cur.wins += 1;
  cur.pnl += pnl;
  map.set(key, cur);
}

export function buildLedger(rows: ClosedTicket[]): Ledger {
  const plans = new Map<string, PlanRecord>();
  const symbols = new Map<string, PlanRecord>();
  for (const r of rows) {
    bucket(plans, r.plan || "vela", r.pnl);
    if (r.weex) bucket(symbols, r.weex, r.pnl);
  }
  const skipSymbols = new Set<string>();
  for (const s of symbols.values()) {
    if (s.closed >= 6 && s.wins / s.closed < 0.25 && s.pnl <= 0) skipSymbols.add(s.plan);
  }
  const bits: string[] = [];
  const best = [...plans.values()].sort((a, b) => b.pnl - a.pnl)[0];
  if (best && best.pnl > 0 && best.closed >= 4) bits.push(`keeping ${best.plan} ($${best.pnl.toFixed(1)})`);
  if (skipSymbols.size) bits.push(`skip ${[...skipSymbols].slice(0, 3).join(", ")}`);
  return {
    plans: [...plans.values()],
    skipSymbols,
    note: skipSymbols.size
      ? `Sitting out ${[...skipSymbols].slice(0, 3).join(", ")}.`
      : "Hunting A++ longs and shorts this tick.",
  };
}

export function applyLedger(setups: RawSetup[], ledger: Ledger): RawSetup[] {
  const filtered = setups.filter((s) => !ledger.skipSymbols.has(s.weexSymbol));
  return filtered.length ? filtered : setups;
}

/** A++ — location structure only. No mid-range engulf, no dip-buy, no failed-bounce. */
export function eliteScalp(
  thesis: string,
  conf: number,
  bar: number,
  bias?: "long" | "short" | "chop",
): boolean {
  const floor = Math.max(85, bar);
  if (
    /Failed bounce|lower high|Continuation (on|short on) 21h|Oversold bounce|washout RSI|Trend cooling|Dry-up at/i.test(
      thesis,
    )
  )
    return false;
  const structure =
    /double (top|bottom)|failed range|vol fade|climax rejection|Pin bar|engulf|buyers on 2nd|supply on 2nd|With-trend 1h/i.test(
      thesis,
    );
  return structure && conf >= floor;
}

export const APLUS_MENU =
  "Double · pin · engulf · climax · with-trend with the 1h book. No dump-longs. No bounce-shorts.";

/** Higher = cleaner. Oversold/washout last so a 92 RSI dump doesn't beat an 86 double. */
export function setupQuality(thesis: string): number {
  const k = aPlusKind(thesis);
  if (k === "continuation" || k === "failed bounce") return -1;
  if (
    k === "double" ||
    k === "pin" ||
    k === "engulf" ||
    k === "failed range" ||
    k === "climax" ||
    k === "with-trend"
  )
    return 2;
  return 0;
}

export function aPlusKind(thesis: string): string | null {
  const t = thesis;
  if (/double (top|bottom)|buyers on 2nd|supply on 2nd|vol fade/i.test(t)) return "double";
  if (/Failed bounce|lower high/i.test(t)) return "failed bounce";
  if (/failed range/i.test(t)) return "failed range";
  if (/Pin bar/i.test(t)) return "pin";
  if (/engulf/i.test(t)) return "engulf";
  if (/climax rejection/i.test(t)) return "climax";
  if (/With-trend 1h/i.test(t)) return "with-trend";
  if (/Dry-up at/i.test(t)) return "dry-up";
  if (/washout RSI/i.test(t)) return "washout";
  if (/Trend cooling/i.test(t)) return "trend cooling";
  if (/Oversold bounce RSI (1\d|2[0-8])/i.test(t)) return "oversold";
  if (/Overbought RSI (7[0-9]|8\d)/i.test(t)) return "overbought";
  if (/Continuation/i.test(t)) return "continuation";
  return null;
}

/** Stable journal key. Not a win-rate. */
export function setupTag(thesis: string): string {
  const k = aPlusKind(thesis);
  if (!k) return "OTHER";
  return k.toUpperCase().replace(/[-\s]+/g, "_");
}

/**
 * 4h trend + S/R. 1h EMA 9/21 + RSI momentum. No chase / blow-off.
 * 15m + VWAP is ltfTrigger.
 */
export function mtfAllows(
  side: Side,
  fourHour: Candle[],
  hourly: Candle[],
  thesis = "",
  heat: "long" | "short" | "chop" = "chop",
): { ok: boolean; why: string } {
  if (!htfAllows(side, fourHour, heat)) return { ok: false, why: "4h reject" };
  const knife = /washout|Oversold|Overbought/i.test(thesis);
  if (hourly.length >= 24) {
    const closes = hourly.map((c) => c.close);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const last = closes[closes.length - 1];
    if (e21 != null && last != null) {
      if (side === "long" && last < e21 * 0.997) return { ok: false, why: "1h reject" };
      if (side === "short" && last > e21 * 1.003) return { ok: false, why: "1h reject" };
    }
    if (!knife && e9 != null && e21 != null) {
      if (side === "long" && e9 < e21 * 0.997) return { ok: false, why: "1h momentum down" };
      if (side === "short" && e9 > e21 * 1.003) return { ok: false, why: "1h momentum up" };
    }
    const rsi1 = rsiAt(closes, closes.length - 1);
    const rsiAgo = rsiAt(closes, Math.max(15, closes.length - 4));
    if (!knife && rsi1 != null && rsiAgo != null) {
      if (side === "long" && rsi1 < rsiAgo - 6 && rsi1 < 48) return { ok: false, why: "1h selling impulse" };
      if (side === "short" && rsi1 > rsiAgo + 6 && rsi1 > 52) return { ok: false, why: "1h buying impulse" };
    }
  }
  if (fourHour.length >= 16) {
    const c4 = fourHour.map((c) => c.close);
    const rsi4 = rsiAt(c4, c4.length - 1);
    const mid = sma(c4, 21);
    const last4 = c4[c4.length - 1];
    const bar = fourHour[fourHour.length - 1]!;
    const range = bar.high - bar.low;
    if (side === "short") {
      if (rsi4 != null && rsi4 <= 28) return { ok: false, why: "4h washout — no short" };
      if (mid != null && last4 != null && last4 < mid * 0.96) {
        return { ok: false, why: "4h extended — no chase short" };
      }
      if (range > 0 && bar.close > bar.open && (bar.close - bar.low) / range > 0.62) {
        return { ok: false, why: "4h bounce bar — no short" };
      }
    } else {
      if (rsi4 != null && rsi4 >= 72) return { ok: false, why: "4h blow-off — no long" };
      if (mid != null && last4 != null && last4 > mid * 1.04) {
        return { ok: false, why: "4h extended — no chase long" };
      }
      if (range > 0 && bar.close < bar.open && (bar.high - bar.close) / range > 0.62) {
        return { ok: false, why: "4h rejection bar — no long" };
      }
    }
  }
  const late = /Failed bounce|lower high|failed range|double (top|bottom)/i.test(thesis);
  if (late && hourly.length >= 16) {
    const rsi1 = rsiAt(hourly.map((c) => c.close), hourly.length - 1);
    const a = hourly[hourly.length - 1]!;
    const b = hourly[hourly.length - 2];
    const c = hourly[hourly.length - 3];
    if (side === "short") {
      if (rsi1 != null && rsi1 < 42) return { ok: false, why: "failed bounce late" };
      if (b && c && a.high >= b.high && a.high >= c.high) {
        return { ok: false, why: "no 1h lower high" };
      }
    } else {
      if (rsi1 != null && rsi1 > 58) return { ok: false, why: "bounce late" };
      if (b && c && a.low <= b.low && a.low <= c.low) {
        return { ok: false, why: "no 1h higher low" };
      }
    }
  }
  return { ok: true, why: "" };
}

/** 1R would print into 4h demand/supply — skip. ONDO TP sat on the 4h low. */
export function targetIntoLocation(
  side: Side,
  entry: number,
  stop: number,
  fourHour: Candle[],
): boolean {
  if (fourHour.length < 16 || !(entry > 0) || !(stop > 0)) return false;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return false;
  const tp = side === "short" ? entry - risk : entry + risk;
  const prior = fourHour.slice(-21, -1);
  const sl = Math.min(...prior.map((c) => c.low));
  const sh = Math.max(...prior.map((c) => c.high));
  const a = atr(fourHour, 14) ?? 0;
  if (side === "short" && entry <= sl + 0.35 * a) return true;
  if (side === "long" && entry >= sh - 0.35 * a) return true;
  return false;
}

export function whyTookTrade(opts: {
  symbol: string;
  side: "long" | "short";
  conf: number;
  thesis: string;
  bias: "long" | "short" | "chop";
  live?: boolean;
  working?: boolean;
}): string {
  const pair = opts.symbol.replace(/USDT/g, "");
  const kind = aPlusKind(opts.thesis);
  const raw = (opts.thesis.split("·").pop() ?? opts.thesis).replace(/\s+/g, " ").trim();
  const short = opts.side === "short";
  const setup =
    kind === "washout"
      ? `Washout at the lows (${raw}). Slow mean holding — bounce, not a knife.`
      : kind === "pin"
        ? short
          ? `Pin bar at the highs (${raw}). Upper wick rejected — fade it.`
          : `Pin bar at the lows (${raw}). Lower wick held — buy the dip.`
        : kind === "engulf"
          ? short
            ? `Bear engulf on the 21h (${raw}).`
            : `Bull engulf on the 21h (${raw}).`
          : kind === "double"
            ? short
              ? `Double top / 2nd-test supply (${raw}).`
              : `Double bottom / 2nd-test buyers (${raw}).`
            : kind === "climax"
              ? `Volume climax rejection (${raw}).`
              : kind === "dry-up"
                ? `Volume dry-up at the extreme (${raw}).`
                : kind === "overbought"
                  ? `Overbought (${raw}). Fade the stretch.`
                  : kind === "oversold"
                    ? `Oversold bounce (${raw}).`
                    : kind === "trend cooling"
                      ? `Trend cooling (${raw}). RSI rolling over — short the stall.`
                      : kind === "failed range"
                        ? `Failed range (${raw}).`
                        : kind === "continuation"
                          ? `Continuation pullback with the 21h (${raw}).`
                          : raw || "A+ structure.";
  const tape = opts.live
    ? ""
    : /BTC/i.test(opts.symbol)
      ? opts.bias === "chop"
        ? "BTC mixed on 4h/1h."
        : `BTC ${opts.bias} on 4h+1h.`
    : opts.bias === "chop"
      ? "BTC mixed — structure scalp, not a tape-follow."
      : opts.side === opts.bias
        ? `With BTC ${opts.bias} on 4h+1h.`
        : `Fading BTC ${opts.bias} — this coin is doing the other side.`;
  const verb = opts.working ? "Limit" : opts.live ? "Live" : "Took";
  return `${verb} ${pair} ${opts.side} · A++ score ${opts.conf}. ${setup}${tape ? ` ${tape}` : ""}`;
}

export function writeDeskNote(opts: {
  phase: string;
  equity: number;
  marginPct: number;
  correction: string;
  tickets: {
    symbol: string;
    side: string;
    leverage: number;
    entry: number;
    stop: number;
    target: number;
    last: number;
    beMoved: boolean;
    status: string;
    targets: number[];
  }[];
}): string {
  const eq = opts.equity;
  const lines: string[] = [];
  lines.push(
    `${opts.phase}. Equity $${eq.toFixed(2)}. Margin cap ${opts.marginPct.toFixed(1)}% of the WEEX wallet, coin-max lev, cross. The stop is the SL — not isolated-style “liq in 0.25%.” Unused wallet backs the ticket. Residual risk is a gap through the SL, not liquidation before it.`,
  );
  if (!opts.tickets.length) {
    lines.push("Nothing on. Waiting for an A++ 1h idea that tags the 15m, clears spread, and fits 4 at-risk.");
    if (opts.correction) lines.push(opts.correction);
    return lines.join(" ");
  }
  for (const t of opts.tickets) {
    const risk = Math.abs(t.entry - t.stop);
    const favor = t.side === "short" ? t.entry - t.last : t.last - t.entry;
    const r = risk > 0 ? favor / risk : 0;
    const tp1 = t.targets[0] ?? t.target;
    const hitTp1 =
      tp1 > 0 && (t.side === "short" ? t.last <= tp1 : t.last >= tp1);
    let action = "Hold.";
    if (t.status === "working") action = "Limit working. Not filled.";
    else if (r <= -0.85) action = "Against us. SL is the plan — do not add.";
    else if (hitTp1 && !t.beMoved) action = "TP1 tagged. Next tick should lock BE.";
    else if (t.beMoved && r > 1.2) action = "BE locked. Let the trail work.";
    else if (r >= 0.4) action = "In the money. Hold for remaining takes.";
    lines.push(
      `${t.symbol} ${t.side} ${t.leverage}x · last ${t.last.toFixed(4)} vs entry ${t.entry.toFixed(4)} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R) · ${action}`,
    );
  }
  if (opts.correction) lines.push(opts.correction);
  return lines.join(" ");
}
