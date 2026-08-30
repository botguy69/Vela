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
  if (side === "long") return last >= mid * 0.992;
  return last <= mid * 1.008;
}

/**
 * 1h already picked the side. Fill only on a 15m pullback to EMA 9/21 — not the spike of the hour.
 * Does not move the stop.
 */
export function ltfTrigger(
  side: Side,
  fifteen: Candle[],
): { ok: boolean; wait: boolean; reason: string; pullback: number | null } {
  if (fifteen.length < 24) return { ok: true, wait: false, reason: "thin 15m", pullback: null };
  const closes = fifteen.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const a = atr(fifteen, 14);
  const last = closes[closes.length - 1];
  if (e9 == null || e21 == null || a == null || a <= 0 || last == null) {
    return { ok: true, wait: false, reason: "thin 15m", pullback: null };
  }
  const mean = (e9 + e21) / 2;
  if (side === "long") {
    if (last < e21 - 0.7 * a) return { ok: false, wait: false, reason: "15m still dumping", pullback: null };
    if (last > e21 + 0.35 * a) {
      return { ok: false, wait: true, reason: "limit at 15m mean", pullback: mean };
    }
    return { ok: true, wait: false, reason: "15m pullback", pullback: mean };
  }
  if (last > e21 + 0.7 * a) return { ok: false, wait: false, reason: "15m still ripping", pullback: null };
  if (last < e21 - 0.35 * a) {
    return { ok: false, wait: true, reason: "limit at 15m mean", pullback: mean };
  }
  return { ok: true, wait: false, reason: "15m bounce", pullback: mean };
}

/** Coin 15m is doing the side while BTC 15m is not — 2nd same-side name is allowed. */
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
        ? "BTC pumping — leaning long. Still take A++ shorts if a coin fades vs BTC."
        : "BTC pumping, 15m pausing — leaning long. A++ shorts still ok if a coin diverges.",
    };
  }
  if (h4S && h1S) {
    const ltf = ltfAllows("short", fifteen);
    return {
      bias: "short",
      note: ltf
        ? "BTC bleeding — leaning short. Still take A++ longs if a coin holds vs BTC."
        : "BTC bleeding, 15m pausing — leaning short. A++ longs still ok if a coin diverges.",
    };
  }
  return { bias: "chop", note: "BTC mixed / chopping. A++ both ways. Opposite the book only on a fade." };
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

export function spreadTooWide(weex: string, bid: number, ask: number): boolean {
  const bps = spreadBps(bid, ask);
  if (weex === "BTCUSDT" || weex === "ETHUSDT") return bps > 8;
  return bps > 25;
}

export function limitMaxAgeMs(style: Style): number {
  return style === "scalp" ? 4 * 3600_000 : 10 * 3600_000;
}

/** Fills before this keep the old clock. Scalp fills still red after 5h flatten. Green / BE hold. */
export const CHOP_V2_SINCE = Date.parse("2026-08-24T02:00:00.000Z");

export function fillMaxAgeMs(style: Style): number {
  return style === "scalp" ? 5 * 3600_000 : 12 * 3600_000;
}

export function shouldCancelStaleLimit(createdAt: string | Date, style: Style): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > limitMaxAgeMs(style);
}

/** Dead loser after 5h → flatten. Green tickets hold. BE leftovers trail. */
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

/** A++ scalp — only the best structure. No continuation, no trend-cooling, no RSI 48 mean. */
export function eliteScalp(
  thesis: string,
  conf: number,
  bar: number,
  _bias?: "long" | "short" | "chop",
): boolean {
  if (conf < Math.max(86, bar)) return false;
  return /double (top|bottom)|failed range|Failed bounce|vol fade|washout RSI (1\d|2[0-5])|climax rejection|Dry-up at|Pin bar|engulf|buyers on 2nd|supply on 2nd|Oversold bounce RSI (1\d|2[0-5])|Overbought RSI (7[0-9]|8\d)/i.test(
    thesis,
  );
}

export const APLUS_MENU =
  "A++ double · pin · engulf · climax · dry-up · washout ≤25 · failed range · failed bounce · overbought reject ≥70. Continuation and trend-cooling are off.";

export function aPlusKind(thesis: string): string | null {
  const t = thesis;
  if (/double (top|bottom)|buyers on 2nd|supply on 2nd|vol fade/i.test(t)) return "double";
  if (/Failed bounce|lower high/i.test(t)) return "failed bounce";
  if (/failed range/i.test(t)) return "failed range";
  if (/Pin bar/i.test(t)) return "pin";
  if (/engulf/i.test(t)) return "engulf";
  if (/climax rejection/i.test(t)) return "climax";
  if (/Dry-up at/i.test(t)) return "dry-up";
  if (/washout RSI/i.test(t)) return "washout";
  if (/Trend cooling/i.test(t)) return "trend cooling";
  if (/Oversold bounce RSI (1\d|2[0-8])/i.test(t)) return "oversold";
  if (/Overbought RSI (7[0-9]|8\d)/i.test(t)) return "overbought";
  if (/Continuation/i.test(t)) return "continuation";
  return null;
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
  return `${verb} ${pair} ${opts.side} · ${opts.conf}% confidence. ${setup}${tape ? ` ${tape}` : ""}`;
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
    lines.push("Nothing on. Waiting for an A++ 1h idea that tags the 15m, clears spread, and fits 2 at-risk (3rd after one TP1/BE).");
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
