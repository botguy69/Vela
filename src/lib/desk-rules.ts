import type { Candle } from "./engine";
import type { RawSetup, Side, Style } from "./ta";

/** Most of the top 25 is one BTC trade. TON is the only soft exception. */
export function betaWeight(weex: string): number {
  if (weex === "TONUSDT") return 0.25;
  if (weex === "BTCUSDT" || weex === "ETHUSDT") return 1;
  return 0.9;
}

export function signedBeta(weex: string, side: Side): number {
  return betaWeight(weex) * (side === "long" ? 1 : -1);
}

export function blocksBeta(
  open: { weex: string; side: Side }[],
  next: { weex: string; side: Side },
): boolean {
  const net = open.reduce((s, p) => s + signedBeta(p.weex, p.side), 0);
  const add = signedBeta(next.weex, next.side);
  if (net > 0.2 && add < 0) return true;
  if (net < -0.2 && add > 0) return true;
  if (Math.abs(add) <= 0.3) return false;
  return Math.abs(net + add) > 1.15 && Math.abs(net + add) > Math.abs(net);
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

/** 4h mean must agree with the 1h idea. */
export function htfAllows(side: Side, fourHour: Candle[]): boolean {
  if (fourHour.length < 24) return true;
  const closes = fourHour.map((c) => c.close);
  const mid = sma(closes, 21);
  const last = closes[closes.length - 1];
  if (mid == null || last == null) return true;
  if (side === "long") return last >= mid * 0.997;
  return last <= mid * 1.003;
}

/** 15m mean must not be selling a 1h long (and reverse). */
export function ltfAllows(side: Side, fifteen: Candle[]): boolean {
  if (fifteen.length < 24) return true;
  const closes = fifteen.map((c) => c.close);
  const mid = sma(closes, 21);
  const last = closes[closes.length - 1];
  if (mid == null || last == null) return true;
  if (side === "long") return last >= mid * 0.996;
  return last <= mid * 1.004;
}

export function spreadBps(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return 999;
  return ((ask - bid) / mid) * 10_000;
}

export function spreadTooWide(weex: string, bid: number, ask: number): boolean {
  const bps = spreadBps(bid, ask);
  if (weex === "BTCUSDT" || weex === "ETHUSDT") return bps > 8;
  return bps > 25;
}

export function limitMaxAgeMs(style: Style): number {
  return style === "scalp" ? 4 * 3600_000 : 10 * 3600_000;
}

export function fillMaxAgeMs(style: Style): number {
  return style === "scalp" ? 8 * 3600_000 : 20 * 3600_000;
}

export function shouldCancelStaleLimit(createdAt: string | Date, style: Style): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > limitMaxAgeMs(style);
}

export function shouldTimeStopFill(opts: {
  since: string | Date;
  style: Style;
  side: Side;
  entry: number;
  last: number;
  stop: number;
}): boolean {
  const t = new Date(opts.since).getTime();
  if (!Number.isFinite(t) || Date.now() - t < fillMaxAgeMs(opts.style)) return false;
  const risk = Math.abs(opts.entry - opts.stop);
  if (risk <= 0) return true;
  const favor = opts.side === "long" ? opts.last - opts.entry : opts.entry - opts.last;
  return favor / risk < 0.3;
}

export function trailStop(opts: {
  side: Side;
  entry: number;
  stop: number;
  hourly: Candle[];
}): number | null {
  const a = atr(opts.hourly, 14);
  if (a == null || a <= 0 || opts.hourly.length < 8) return null;
  const slice = opts.hourly.slice(-8);
  if (opts.side === "long") {
    const floor = Math.min(...slice.map((c) => c.low)) - 0.15 * a;
    const next = Math.max(opts.stop, floor, opts.entry);
    return next > opts.stop * 1.0002 ? next : null;
  }
  const ceil = Math.max(...slice.map((c) => c.high)) + 0.15 * a;
  const next = Math.min(opts.stop, ceil, opts.entry);
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

export type PlanRecord = { plan: string; closed: number; wins: number };

export function rankSetups(setups: RawSetup[], records: PlanRecord[]): RawSetup[] {
  const byPlan = new Map(records.map((r) => [r.plan, r]));
  return [...setups]
    .map((s) => {
      const rec = byPlan.get(s.plan);
      if (!rec || rec.closed < 8) return s;
      const wr = rec.wins / rec.closed;
      const adj = wr < 0.3 ? 0.55 : wr > 0.55 ? 1.2 : 1;
      return { ...s, score: s.score * adj };
    })
    .sort((a, b) => b.score - a.score);
}
