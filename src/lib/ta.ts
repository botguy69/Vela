import type { MarketId } from "./markets";
import type { Candle } from "./engine";

export type Side = "long" | "short";
export type Style = "scalp" | "swing";
export type EntryType = "market" | "limit";

export type RawSetup = {
  symbol: string;
  weexSymbol: string;
  side: Side;
  style: Style;
  entryType: EntryType;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  score: number;
  thesis: string;
  invalidation: string;
  atr: number;
  rsi: number;
  last: number;
  targets: number[];
  scale: number[];
  plan: "single" | "scale2" | "scale3";
  confidence: number;
  bypassHtf?: boolean;
};

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i]!;
  return sum / period;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return sma(trs, period);
}

function swing(candles: Candle[], lookback: number, kind: "high" | "low"): number {
  const slice = candles.slice(-lookback);
  return kind === "high"
    ? Math.max(...slice.map((c) => c.high))
    : Math.min(...slice.map((c) => c.low));
}

export function scoreToConf(score: number): number {
  return Math.round(Math.min(86, Math.max(58, score)));
}

export function weexSymbol(id: MarketId | string): string {
  return String(id).includes("USDT") ? String(id) : String(id).replace("-USD", "USDT").replace("-", "");
}

export function analyzeMarket(
  symbol: string,
  hourly: Candle[],
  style: Style,
  minRr: number,
): RawSetup[] {
  if (hourly.length < 40) return [];
  const closes = hourly.map((c) => c.close);
  const last = closes[closes.length - 1]!;
  const fast = sma(closes, 9);
  const mid = sma(closes, 21);
  const slow = sma(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(hourly, 14);
  if (fast == null || mid == null || r == null || a == null || a <= 0) return [];

  const hi = swing(hourly, 20, "high");
  const lo = swing(hourly, 20, "low");
  const up = mid > (slow ?? mid) && last > mid;
  const down = mid < (slow ?? mid) && last < mid;
  const stopPad = style === "scalp" ? 1.15 : 2.1;

  type Idea = {
    side: Side;
    entry: number;
    stop: number;
    entryType: EntryType;
    score: number;
    thesis: string;
    invalidation: string;
    plan: "single" | "scale2" | "scale3";
    bypassHtf?: boolean;
  };

  const ideas: Idea[] = [];

  if (up && r <= 58 && r >= 28) {
    const entry = Math.max(mid, last - 0.35 * a);
    const stop = Math.min(lo, entry) - stopPad * a * 0.35;
    ideas.push({
      side: "long",
      entry,
      stop,
      entryType: last - entry < 0.2 * a ? "market" : "limit",
      score: 70 + Math.max(0, 52 - Math.abs(r - 44)) / 4 + (up ? 8 : 0),
      thesis: `Bid 21h mean, RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close back through the 21-hour average.`,
      plan: "scale2",
    });
  }

  if (down && r >= 42 && r <= 72) {
    const entry = Math.min(mid, last + 0.35 * a);
    const stop = Math.max(hi, entry) + stopPad * a * 0.35;
    ideas.push({
      side: "short",
      entry,
      stop,
      entryType: entry - last < 0.2 * a ? "market" : "limit",
      score: 70 + Math.max(0, 52 - Math.abs(r - 56)) / 4 + (down ? 8 : 0),
      thesis: `Offer 21h mean, RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close back above the 21-hour average.`,
      plan: "scale2",
    });
  }

  // Continuation: with the mean, not already 1 ATR into the spike.
  if (up && r >= 42 && r <= 62 && last <= mid + 0.85 * a && last >= mid * 0.998) {
    const entry = Math.min(last, fast + 0.1 * a);
    const stop = Math.min(lo, mid) - stopPad * a * 0.4;
    ideas.push({
      side: "long",
      entry,
      stop,
      entryType: last - entry < 0.25 * a ? "market" : "limit",
      score: 76 + (66 - r) * 0.2,
      thesis: `Continuation on 21h, RSI ${r.toFixed(0)}`,
      invalidation: `Lose the 21-hour average.`,
      plan: "scale2",
    });
  }

  if (down && r >= 38 && r <= 58 && last >= mid - 0.85 * a && last <= mid * 1.002) {
    const entry = Math.max(last, fast - 0.1 * a);
    const stop = Math.max(hi, mid) + stopPad * a * 0.4;
    ideas.push({
      side: "short",
      entry,
      stop,
      entryType: entry - last < 0.25 * a ? "market" : "limit",
      score: 76 + (r - 34) * 0.2,
      thesis: `Continuation short on 21h, RSI ${r.toFixed(0)}`,
      invalidation: `Reclaim the 21-hour average.`,
      plan: "scale2",
    });
  }

  if (r <= 32 && last > (slow ?? last) * 0.96) {
    const entry = last;
    const stop = lo - 0.8 * a;
    ideas.push({
      side: "long",
      entry,
      stop,
      entryType: "market",
      score: 70 + (32 - r),
      thesis: `Washout RSI ${r.toFixed(0)}, slow mean intact`,
      invalidation: `Break of the local swing low.`,
      plan: "scale2",
    });
  }

  if (r <= 42 && last < mid && last > (slow ?? last) * 0.93) {
    ideas.push({
      side: "long",
      entry: last,
      stop: lo - stopPad * a * 0.35,
      entryType: "market",
      score: 71 + Math.min(6, 42 - r) * 0.5,
      thesis: `Oversold bounce RSI ${r.toFixed(0)} under 21h`,
      invalidation: `Hourly close through the swing low.`,
      plan: "scale2",
    });
  }

  if (r >= 72 && last < (slow ?? last) * 1.08) {
    const entry = last;
    const stop = hi + 0.8 * a;
    ideas.push({
      side: "short",
      entry,
      stop,
      entryType: "market",
      score: 68 + (r - 72),
      thesis: `Overbought RSI ${r.toFixed(0)}`,
      invalidation: `Break of the local swing high.`,
      plan: "scale2",
      bypassHtf: true,
    });
  }

  const lastBar = hourly[hourly.length - 1]!;
  const lastRange = lastBar.high - lastBar.low;
  const exhausted = lastRange > 2.15 * a;
  const vols = hourly.slice(-20).map((c) => c.volume).filter((v) => v > 0).sort((x, y) => x - y);
  const medVol = vols.length ? vols[Math.floor(vols.length / 2)]! : 0;
  const thinBreak = medVol > 0 && lastBar.volume < 0.75 * medVol;

  const rAgo = rsi(closes.slice(0, -4), 14);
  if (rAgo != null && r >= 64 && r <= rAgo + 0.5 && last > mid * 0.997) {
    const bearBar = lastBar.close <= lastBar.open;
    if (bearBar || r >= 70) {
      ideas.push({
        side: "short",
        entry: last,
        stop: Math.max(hi, last) + stopPad * a * 0.35,
        entryType: "market",
        score: 73 + Math.min(6, r - 64),
        thesis: `Trend cooling, RSI ${r.toFixed(0)} off ${rAgo.toFixed(0)}`,
        invalidation: `Hourly close makes a new high.`,
        plan: "scale2",
        bypassHtf: true,
      });
    }
  }

  const brokeHigh = !exhausted && !thinBreak && last > hi && fast > mid && r > 50 && r < 72;
  if (brokeHigh) {
    const entry = last;
    const stop = mid - 0.4 * a;
    ideas.push({
      side: "long",
      entry,
      stop,
      entryType: "market",
      score: 66,
      thesis: `Range high taken, fast still leading`,
      invalidation: `Failed break — back inside the 20-hour range.`,
      plan: "scale3",
    });
  }

  const brokeLow = !exhausted && !thinBreak && last < lo && fast < mid && r < 50 && r > 28;
  if (brokeLow) {
    const entry = last;
    const stop = mid + 0.4 * a;
    ideas.push({
      side: "short",
      entry,
      stop,
      entryType: "market",
      score: 66,
      thesis: `Range low lost, fast still leading`,
      invalidation: `Failed break — back inside the 20-hour range.`,
      plan: "scale3",
    });
  }

  const prior = hourly.slice(0, -1);
  if (prior.length >= 24) {
    const hiPrior = swing(prior, 20, "high");
    const loPrior = swing(prior, 20, "low");
    const failedHigh =
      lastBar.high > hiPrior && lastBar.close < hiPrior && lastBar.close <= lastBar.open && r >= 52;
    if (failedHigh) {
      ideas.push({
        side: "short",
        entry: last,
        stop: lastBar.high + stopPad * a * 0.35,
        entryType: "market",
        score: 74,
        thesis: `Failed range high, RSI ${r.toFixed(0)}`,
        invalidation: `Hourly close back above the failed high.`,
        plan: "scale2",
        bypassHtf: true,
      });
    }
    const failedLow =
      lastBar.low < loPrior && lastBar.close > loPrior && lastBar.close >= lastBar.open && r <= 48;
    if (failedLow) {
      ideas.push({
        side: "long",
        entry: last,
        stop: lastBar.low - stopPad * a * 0.35,
        entryType: "market",
        score: 74,
        thesis: `Failed range low, RSI ${r.toFixed(0)}`,
        invalidation: `Hourly close back below the failed low.`,
        plan: "scale2",
      });
    }
  }

  const finish = (best: Idea): RawSetup | null => {
    const risk = Math.abs(best.entry - best.stop);
    if (risk <= 0) return null;
    const push = (mult: number) =>
      best.side === "long" ? best.entry + risk * mult : best.entry - risk * mult;
    const targets =
      best.plan === "scale3"
        ? [push(1), push(2), push(3.2)]
        : best.plan === "scale2"
          ? [push(1), push(2.5)]
          : [push(style === "scalp" ? 1.8 : 2.2)];
    const scale =
      best.plan === "scale3" ? [0.34, 0.33, 0.33] : best.plan === "scale2" ? [0.5, 0.5] : [1];
    const target = targets[targets.length - 1]!;
    const rr = Math.abs(target - best.entry) / risk;
    if (rr < minRr) return null;
    const conf = scoreToConf(best.score);
    const planTag = best.plan === "scale2" ? "hold" : best.plan === "scale3" ? "break" : "fade";
    const thesis = `${best.side} ${planTag} · RSI ${r.toFixed(0)} · ${rr.toFixed(1)}R · conf ${conf}% · ${best.thesis}`;
    return {
      symbol,
      weexSymbol: weexSymbol(symbol),
      side: best.side,
      style,
      entryType: best.entryType,
      entry: best.entry,
      stop: best.stop,
      target,
      targets,
      scale,
      plan: best.plan,
      rr,
      score: best.score,
      confidence: conf,
      thesis,
      invalidation: best.invalidation,
      atr: a,
      rsi: r,
      last,
      bypassHtf: Boolean(best.bypassHtf),
    };
  };

  const out: RawSetup[] = [];
  for (const side of ["long", "short"] as const) {
    let best: Idea | null = null;
    for (const idea of ideas) {
      if (idea.side !== side) continue;
      if (!best || idea.score > best.score) best = idea;
    }
    const s = best ? finish(best) : null;
    if (s) out.push(s);
  }
  return out;
}

export function pickStyle(accountUsd: number, forced?: Style | "auto"): Style {
  if (forced === "scalp" || forced === "swing") return forced;
  return accountUsd >= 1000 ? "swing" : "scalp";
}

export function scanUniverse(
  books: Record<string, Candle[]>,
  style: Style,
  minRr: number,
  method: "vela" | "trend" | "fade" | "break" = "vela",
): RawSetup[] {
  const out: RawSetup[] = [];
  for (const [symbol, candles] of Object.entries(books)) {
    const setups = analyzeMarket(symbol, candles, style, minRr);
    for (const setup of setups) out.push(setup);
  }
  const filtered =
    method === "trend"
      ? out.filter((s) => s.plan === "scale2")
      : method === "fade"
        ? out.filter((s) => s.plan === "single")
        : method === "break"
          ? out.filter((s) => s.plan === "scale3")
          : out;
  const pick = filtered.length ? filtered : out;
  return pick.sort((a, b) => b.score - a.score);
}

/** WEEX-style BE: round-trip taker (~0.06% in + 0.06% out) plus a hair so leftover isn't a fee loss. */
export function breakevenPrice(side: Side, entry: number): number {
  const roundTrip = 0.0006 * 2 + 0.0002;
  return side === "long" ? entry * (1 + roundTrip) : entry * (1 - roundTrip);
}

export function taggedTake(side: Side, last: number, target: number): boolean {
  if (!(target > 0) || !(last > 0)) return false;
  return side === "long" ? last >= target * 0.999 : last <= target * 1.001;
}
export function shouldLockBreakeven(opts: {
  side: Side;
  entry: number;
  stop: number;
  last: number;
  targets: number[];
  already: boolean;
  reduced?: boolean;
}): boolean {
  if (opts.already || opts.entry <= 0) return false;
  if (opts.reduced) return true;
  if (Math.abs(opts.stop - opts.entry) / opts.entry < 0.001) return false;
  const risk = Math.abs(opts.entry - opts.stop);
  if (risk <= 0) return false;
  const favor = opts.side === "long" ? opts.last - opts.entry : opts.entry - opts.last;
  const r = favor / risk;
  const firstTake = opts.targets[0];
  const hitFirst =
    firstTake != null && (opts.side === "long" ? opts.last >= firstTake : opts.last <= firstTake);
  return hitFirst || r >= 1;
}

/** Realized takes + mark on leftover. Full flatten at last prints the whole ticket at that price. */
export function ticketPnl(opts: {
  side: Side;
  entry: number;
  last: number;
  qty: number;
  leftover?: number | null;
  targets: number[];
  beMoved: boolean;
  tp1Hit?: boolean;
}): number {
  const orig = opts.qty;
  if (!(orig > 0) || !(opts.entry > 0)) return 0;
  const favor = (px: number, q: number) =>
    opts.side === "short" ? (opts.entry - px) * q : (px - opts.entry) * q;
  const tp1 = opts.targets[0];
  const reduced =
    opts.leftover != null && Number.isFinite(opts.leftover) && orig > 0 && opts.leftover < orig * 0.72;
  const tagged = tp1 != null && taggedTake(opts.side, opts.last, tp1);
  const tp1Hit = Boolean(opts.tp1Hit) || reduced || tagged;
  const half = orig * 0.5;
  const atBe = Math.abs(opts.last - opts.entry) / opts.entry < 0.004;
  if (opts.leftover === 0) {
    if (opts.beMoved && tp1Hit && tp1 != null && atBe && !tagged) {
      return favor(tp1, half) + favor(opts.last, half);
    }
    return favor(opts.last, orig);
  }
  if (opts.beMoved && tp1Hit && tp1 != null) {
    const left =
      opts.leftover != null && Number.isFinite(opts.leftover) && opts.leftover >= 0
        ? opts.leftover
        : half;
    return favor(tp1, half) + favor(opts.last, left);
  }
  const left =
    opts.leftover != null && Number.isFinite(opts.leftover) && opts.leftover >= 0
      ? opts.leftover
      : orig;
  const closed = Math.max(0, orig - left);
  let realized = 0;
  if (closed > 0 && tp1 != null) realized += favor(tp1, closed);
  return realized + favor(opts.last, left);
}
