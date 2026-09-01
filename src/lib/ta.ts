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

function swingBar(candles: Candle[], lookback: number, kind: "high" | "low"): Candle | null {
  const slice = candles.slice(-lookback);
  if (!slice.length) return null;
  let best = slice[0]!;
  for (const c of slice) {
    if (kind === "high" && c.high >= best.high) best = c;
    if (kind === "low" && c.low <= best.low) best = c;
  }
  return best;
}

export function scoreToConf(score: number): number {
  return Math.round(Math.min(94, Math.max(58, score)));
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((s, x) => s + x, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

export type VolTape = "thrust" | "climax" | "dry_extreme" | "coil" | "dead" | "normal";

/** Volume is a signal, not a mute button. */
export function volumeTape(opts: {
  lastBar: Candle;
  medVol: number;
  last: number;
  mid: number;
  atr: number;
  bbUpper: number;
  bbLower: number;
}): { tape: VolTape; ratio: number } {
  const { lastBar, medVol, last, mid, atr: a, bbUpper, bbLower } = opts;
  const ratio = medVol > 0 ? lastBar.volume / medVol : 1;
  const atHigh = last >= Math.max(bbUpper * 0.995, mid + 1.05 * a);
  const atLow = last <= Math.min(bbLower * 1.005, mid - 1.05 * a);
  const atMean = Math.abs(last - mid) <= 0.5 * a;
  const bodyUp = lastBar.close >= lastBar.open;
  if (ratio >= 2 && (atHigh || atLow)) return { tape: "climax", ratio };
  if (ratio >= 1.25 && ((atHigh && !bodyUp) || (atLow && bodyUp))) return { tape: "climax", ratio };
  if (ratio >= 1.15) return { tape: "thrust", ratio };
  if (ratio < 0.55 && !atHigh && !atLow && !atMean) return { tape: "dead", ratio };
  if (ratio < 0.75 && (atHigh || atLow)) return { tape: "dry_extreme", ratio };
  if (ratio < 0.8 && atMean) return { tape: "coil", ratio };
  return { tape: "normal", ratio };
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
  const lastBar = hourly[hourly.length - 1]!;
  const vols = hourly.slice(-20).map((c) => c.volume).filter((v) => v > 0).sort((x, y) => x - y);
  const medVol = vols.length ? vols[Math.floor(vols.length / 2)]! : 0;
  const sd = stdev(closes.slice(-20));
  const bbUpper = mid + 2 * sd;
  const bbLower = mid - 2 * sd;
  const { tape, ratio: volRatio } = volumeTape({
    lastBar,
    medVol,
    last,
    mid,
    atr: a,
    bbUpper,
    bbLower,
  });

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

  if (r <= 25 && last > (slow ?? last) * 0.96) {
    const entry = last;
    const stop = lo - 0.8 * a;
    ideas.push({
      side: "long",
      entry,
      stop,
      entryType: "market",
      score: 86 + (25 - r) * 0.4,
      thesis: `Washout RSI ${r.toFixed(0)}, slow mean intact`,
      invalidation: `Break of the local swing low.`,
      plan: "scale2",
    });
  }

  if (r <= 28 && last < mid && last > (slow ?? last) * 0.93) {
    ideas.push({
      side: "long",
      entry: last,
      stop: lo - stopPad * a * 0.35,
      entryType: "market",
      score: 84 + Math.min(6, 28 - r) * 0.5,
      thesis: `Oversold bounce RSI ${r.toFixed(0)} under 21h`,
      invalidation: `Hourly close through the swing low.`,
      plan: "scale2",
    });
  }

  if (r >= 70 && lastBar.close <= lastBar.open && last < (slow ?? last) * 1.08) {
    const entry = last;
    const stop = hi + 0.8 * a;
    ideas.push({
      side: "short",
      entry,
      stop,
      entryType: "market",
      score: 86 + Math.min(6, r - 70) * 0.35,
      thesis: `Overbought RSI ${r.toFixed(0)} reject`,
      invalidation: `Break of the local swing high.`,
      plan: "scale2",
    });
  }

  const rAgo = rsi(closes.slice(0, -4), 14);
  if (rAgo != null && r >= 64 && r <= rAgo + 0.5 && last > mid * 0.997) {
    const bearBar = lastBar.close <= lastBar.open;
    if (bearBar || r >= 70) {
      ideas.push({
        side: "short",
        entry: last,
        stop: Math.max(hi, last) + stopPad * a * 0.35,
        entryType: "market",
        score: 83 + Math.min(6, r - 64) * 0.3,
        thesis: `Trend cooling, RSI ${r.toFixed(0)} off ${rAgo.toFixed(0)}`,
        invalidation: `Hourly close makes a new high.`,
        plan: "scale2",
      });
    }
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
        score: 85,
        thesis: `Failed range high, RSI ${r.toFixed(0)}`,
        invalidation: `Hourly close back above the failed high.`,
        plan: "scale2",
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
        score: 85,
        thesis: `Failed range low, RSI ${r.toFixed(0)}`,
        invalidation: `Hourly close back below the failed low.`,
        plan: "scale2",
      });
    }
  }

  const firstSlice = hourly.slice(0, -2);
  if (firstSlice.length >= 24) {
    const firstHighBar = swingBar(firstSlice, 22, "high");
    const firstLowBar = swingBar(firstSlice, 22, "low");
    if (firstHighBar) {
      const dist = lastBar.high - firstHighBar.high;
      const tagged = dist >= -0.2 * a && dist <= 0.35 * a;
      const fading = firstHighBar.volume > 0 && lastBar.volume <= 0.85 * firstHighBar.volume;
      const expanding = firstHighBar.volume > 0 && lastBar.volume >= 1.15 * firstHighBar.volume;
      const rejected = lastBar.close <= lastBar.open && lastBar.close <= firstHighBar.high + 0.05 * a;
      const broke = lastBar.close > firstHighBar.high + 0.1 * a;
      if (tagged && r >= 50 && r <= 72 && !broke) {
        if (fading || (expanding && rejected)) {
          ideas.push({
            side: "short",
            entry: rejected ? last : firstHighBar.high,
            stop: Math.max(lastBar.high, firstHighBar.high) + stopPad * a * 0.35,
            entryType: rejected ? "market" : "limit",
            score: 86,
            thesis: fading
              ? `Double top, vol fade ${firstHighBar.volume > 0 ? (lastBar.volume / firstHighBar.volume).toFixed(2) : "?"}× vs first peak, RSI ${r.toFixed(0)}`
              : `Double top, supply on 2nd test ${volRatio.toFixed(1)}× + reject, RSI ${r.toFixed(0)}`,
            invalidation: `Hourly close through the double top.`,
            plan: "scale2",
          });
        }
      }
    }
    if (firstLowBar) {
      const dist = firstLowBar.low - lastBar.low;
      const tagged = dist >= -0.2 * a && dist <= 0.35 * a;
      const fading = firstLowBar.volume > 0 && lastBar.volume <= 0.85 * firstLowBar.volume;
      const expanding = firstLowBar.volume > 0 && lastBar.volume >= 1.15 * firstLowBar.volume;
      const rejected = lastBar.close >= lastBar.open && lastBar.close >= firstLowBar.low - 0.05 * a;
      const broke = lastBar.close < firstLowBar.low - 0.1 * a;
      if (tagged && r <= 50 && r >= 28 && !broke) {
        if (fading || (expanding && rejected)) {
          ideas.push({
            side: "long",
            entry: rejected ? last : firstLowBar.low,
            stop: Math.min(lastBar.low, firstLowBar.low) - stopPad * a * 0.35,
            entryType: rejected ? "market" : "limit",
            score: 86,
            thesis: fading
              ? `Double bottom, vol fade ${firstLowBar.volume > 0 ? (lastBar.volume / firstLowBar.volume).toFixed(2) : "?"}× vs first trough, RSI ${r.toFixed(0)}`
              : `Double bottom, buyers on 2nd test ${volRatio.toFixed(1)}× + reject, RSI ${r.toFixed(0)}`,
            invalidation: `Hourly close through the double bottom.`,
            plan: "scale2",
          });
        }
      }
    }
  }

  if (tape === "dry_extreme" && last >= Math.max(bbUpper * 0.997, hi) * 0.999 && r >= 58) {
    ideas.push({
      side: "short",
      entry: last,
      stop: Math.max(hi, lastBar.high) + stopPad * a * 0.35,
      entryType: "limit",
      score: 85,
      thesis: `Dry-up at high, vol ${volRatio.toFixed(1)}× RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close makes a new high on volume.`,
      plan: "scale2",
    });
  }
  if (tape === "dry_extreme" && last <= Math.min(bbLower * 1.003, lo) * 1.001 && r <= 42) {
    ideas.push({
      side: "long",
      entry: last,
      stop: Math.min(lo, lastBar.low) - stopPad * a * 0.35,
      entryType: "limit",
      score: 85,
      thesis: `Dry-up at low, vol ${volRatio.toFixed(1)}× RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close makes a new low on volume.`,
      plan: "scale2",
    });
  }
  if (tape === "climax" && last >= bbUpper * 0.998 && lastBar.close <= lastBar.open && r >= 60) {
    ideas.push({
      side: "short",
      entry: last,
      stop: lastBar.high + stopPad * a * 0.4,
      entryType: lastBar.close < lastBar.open ? "market" : "limit",
      score: 85,
      thesis: `Volume climax rejection at highs, ${volRatio.toFixed(1)}× RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close back through the wick high.`,
      plan: "scale2",
    });
  }
  if (tape === "climax" && last <= bbLower * 1.002 && lastBar.close >= lastBar.open && r <= 40) {
    ideas.push({
      side: "long",
      entry: last,
      stop: lastBar.low - stopPad * a * 0.4,
      entryType: lastBar.close > lastBar.open ? "market" : "limit",
      score: 85,
      thesis: `Volume climax rejection at lows, ${volRatio.toFixed(1)}× RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close back through the wick low.`,
      plan: "scale2",
    });
  }

  const body = Math.abs(lastBar.close - lastBar.open);
  const upperWick = lastBar.high - Math.max(lastBar.close, lastBar.open);
  const lowerWick = Math.min(lastBar.close, lastBar.open) - lastBar.low;
  if (body > 0 && lowerWick >= 1.6 * body && lastBar.close >= lastBar.open && r <= 48 && last <= mid + 0.35 * a) {
    ideas.push({
      side: "long",
      entry: last,
      stop: lastBar.low - stopPad * a * 0.3,
      entryType: "market",
      score: 85,
      thesis: `Pin bar at lows, RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close through the pin low.`,
      plan: "scale2",
    });
  }
  if (body > 0 && upperWick >= 1.6 * body && lastBar.close <= lastBar.open && r >= 52 && last >= mid - 0.35 * a) {
    ideas.push({
      side: "short",
      entry: last,
      stop: lastBar.high + stopPad * a * 0.3,
      entryType: "market",
      score: 85,
      thesis: `Pin bar at highs, RSI ${r.toFixed(0)}`,
      invalidation: `Hourly close through the pin high.`,
      plan: "scale2",
    });
  }
  const prevBar = hourly[hourly.length - 2];
  if (prevBar) {
    const prevBear = prevBar.close < prevBar.open;
    const prevBull = prevBar.close > prevBar.open;
    const bullEngulf =
      lastBar.close > lastBar.open &&
      lastBar.open <= prevBar.close &&
      lastBar.close >= prevBar.open &&
      prevBear &&
      r <= 55 &&
      last >= mid * 0.994;
    const bearEngulf =
      lastBar.close < lastBar.open &&
      lastBar.open >= prevBar.close &&
      lastBar.close <= prevBar.open &&
      prevBull &&
      r >= 45 &&
      last <= mid * 1.006;
    if (bullEngulf) {
      ideas.push({
        side: "long",
        entry: last,
        stop: Math.min(lastBar.low, prevBar.low) - stopPad * a * 0.3,
        entryType: "market",
        score: 85,
        thesis: `Bull engulf 21h, RSI ${r.toFixed(0)}`,
        invalidation: `Hourly close back through the engulf low.`,
        plan: "scale2",
      });
    }
    if (bearEngulf) {
      ideas.push({
        side: "short",
        entry: last,
        stop: Math.max(lastBar.high, prevBar.high) + stopPad * a * 0.3,
        entryType: "market",
        score: 85,
        thesis: `Bear engulf 21h, RSI ${r.toFixed(0)}`,
        invalidation: `Hourly close back through the engulf high.`,
        plan: "scale2",
      });
    }
  }

  const wickLow = Math.min(lo, ...hourly.slice(-3).map((c) => c.low));
  const wickHigh = Math.max(hi, ...hourly.slice(-3).map((c) => c.high));
  const minStopFrac = style === "scalp" ? 0.008 : 0.012;

  const finish = (best: Idea): RawSetup | null => {
    let stop = best.stop;
    if (best.side === "long") {
      const beyond = wickLow - 0.25 * a;
      const floor = best.entry * (1 - minStopFrac);
      stop = Math.min(stop, beyond, floor);
      if (!(stop < best.entry)) stop = best.entry - Math.max(0.8 * a, best.entry * minStopFrac);
    } else {
      const beyond = wickHigh + 0.25 * a;
      const ceil = best.entry * (1 + minStopFrac);
      stop = Math.max(stop, beyond, ceil);
      if (!(stop > best.entry)) stop = best.entry + Math.max(0.8 * a, best.entry * minStopFrac);
    }
    const risk = Math.abs(best.entry - stop);
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
    if (best.side === "long" && last > bbUpper * 1.001 && tape !== "climax" && tape !== "dry_extreme") return null;
    if (best.side === "short" && last < bbLower * 0.999 && tape !== "climax" && tape !== "dry_extreme") return null;
    if (tape === "dead") return null;
    let score = best.score;
    let entryType = best.entryType;
    if (tape === "climax") {
      if (best.side === "long" && last >= mid + 0.6 * a) return null;
      if (best.side === "short" && last <= mid - 0.6 * a) return null;
      score += 6;
    } else if (tape === "dry_extreme") {
      if (best.side === "long" && last > mid + 0.5 * a) return null;
      if (best.side === "short" && last < mid - 0.5 * a) return null;
      score += 5;
      entryType = "limit";
    } else if (tape === "coil") {
      entryType = "limit";
      score += 2;
    } else if (tape === "thrust") {
      const withTape =
        (best.side === "long" && lastBar.close >= lastBar.open) ||
        (best.side === "short" && lastBar.close <= lastBar.open);
      score += withTape ? 5 : -6;
    } else if (volRatio >= 1.15) {
      score += 3;
    }
    if (score < 82) return null;
    const conf = scoreToConf(score);
    const planTag = best.plan === "scale2" ? "hold" : best.plan === "scale3" ? "break" : "fade";
    const thesis = `${best.side} ${planTag} · RSI ${r.toFixed(0)} · vol ${tape} ${volRatio.toFixed(1)}× · ${rr.toFixed(1)}R · conf ${conf}% · ${best.thesis}`;
    return {
      symbol,
      weexSymbol: weexSymbol(symbol),
      side: best.side,
      style,
      entryType,
      entry: best.entry,
      stop,
      target,
      targets,
      scale,
      plan: best.plan,
      rr,
      score,
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

/** WEEX-style BE: round-trip taker plus a hair so leftover isn't a fee loss. */
export function breakevenPrice(side: Side, entry: number): number {
  const roundTrip = 0.0008 * 2 + 0.0004;
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
  if (opts.already || opts.entry <= 0 || !(opts.last > 0) || !(opts.stop > 0)) return false;
  const risk = Math.abs(opts.entry - opts.stop);
  if (!(risk > 0)) return false;
  const run = opts.side === "long" ? opts.last - opts.entry : opts.entry - opts.last;
  return run >= 0.8 * risk;
}
