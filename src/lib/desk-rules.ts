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
  open: { weex: string; side: Side }[],
  next: { weex: string; side: Side },
  opts?: { diverges?: boolean },
): boolean {
  const same = open.filter((p) => p.side === next.side && p.weex !== next.weex);
  return same.length >= 2;
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
        ? "BTC 4h+1h+15m bid — longs only unless a coin is fading."
        : "BTC 4h+1h bid, 15m pausing — longs on pullback, shorts only if a coin fades.",
    };
  }
  if (h4S && h1S) {
    const ltf = ltfAllows("short", fifteen);
    return {
      bias: "short",
      note: ltf
        ? "BTC 4h+1h+15m offer — shorts only unless a coin is fading."
        : "BTC 4h+1h offer, 15m pausing — shorts on bounce, longs only if a coin fades.",
    };
  }
  return { bias: "chop", note: "BTC mixed — A+ scalps only (structure, pin, engulf, climax, washout). 15m must be clean." };
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

/** Fills before this keep the old clock — live TON/IMX/JUP play out. New fills use 5h / 0.3R. */
export const CHOP_V2_SINCE = Date.parse("2026-08-24T02:00:00.000Z");

export function fillMaxAgeMs(style: Style): number {
  return style === "scalp" ? 5 * 3600_000 : 12 * 3600_000;
}

export function chopTakeMs(style: Style): number {
  return style === "scalp" ? 12 * 3600_000 : 28 * 3600_000;
}

export function shouldCancelStaleLimit(createdAt: string | Date, style: Style): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > limitMaxAgeMs(style);
}

/** Dead loser after 5h → flatten. Green tickets hold or lock fee-BE. BE leftovers trail. */
export function chopAction(opts: {
  since: string | Date;
  style: Style;
  side: Side;
  entry: number;
  last: number;
  stop: number;
  beMoved: boolean;
}): "hold" | "flatten" | "lockBe" {
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
  skipPlans: Set<string>;
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
  const skipPlans = new Set<string>();
  for (const p of plans.values()) {
    if (p.closed >= 8 && p.wins / p.closed < 0.28 && p.pnl <= 0) skipPlans.add(p.plan);
  }
  const skipSymbols = new Set<string>();
  for (const s of symbols.values()) {
    if (s.closed >= 6 && s.wins / s.closed < 0.25 && s.pnl <= 0) skipSymbols.add(s.plan);
  }
  const bits: string[] = [];
  const best = [...plans.values()].sort((a, b) => b.pnl - a.pnl)[0];
  const worst = [...plans.values()].filter((p) => p.closed >= 5).sort((a, b) => a.pnl - b.pnl)[0];
  if (best && best.pnl > 0 && best.closed >= 4) bits.push(`keeping ${best.plan} ($${best.pnl.toFixed(1)})`);
  if (worst && skipPlans.has(worst.plan)) bits.push(`killed ${worst.plan}`);
  if (skipSymbols.size) bits.push(`skip ${[...skipSymbols].slice(0, 3).join(", ")}`);
  return {
    plans: [...plans.values()],
    skipPlans,
    skipSymbols,
    note: bits.length ? `Setups: ${bits.join("; ")}.` : "Side is from BTC 4h+1h this tick, not last week's P&L.",
  };
}

export function rankSetups(setups: RawSetup[], records: PlanRecord[]): RawSetup[] {
  const byPlan = new Map(records.map((r) => [r.plan, r]));
  return [...setups]
    .map((s) => {
      const rec = byPlan.get(s.plan);
      if (!rec || rec.closed < 6) return s;
      const wr = rec.wins / rec.closed;
      const edge = rec.pnl;
      let adj = 1;
      if (wr < 0.28 || edge < 0) adj = 0.45;
      else if (wr > 0.55 && edge > 0) adj = 1.35;
      else if (wr > 0.45) adj = 1.12;
      return { ...s, score: s.score * adj };
    })
    .sort((a, b) => b.score - a.score);
}

export function applyLedger(setups: RawSetup[], ledger: Ledger): RawSetup[] {
  const ranked = rankSetups(setups, ledger.plans);
  const filtered = ranked.filter(
    (s) => !ledger.skipPlans.has(s.plan) && !ledger.skipSymbols.has(s.weexSymbol),
  );
  if (filtered.length) return filtered;
  return ranked;
}

/** Real A+ scalp — structure, extremes, tape. Not generic 21h mean RSI 48. */
export function eliteScalp(thesis: string, conf: number, bar: number): boolean {
  if (conf < Math.max(82, bar)) return false;
  return /double (top|bottom)|failed range|vol fade|washout RSI|climax rejection|Dry-up at|Trend cooling|Pin bar|engulf|buyers on 2nd|supply on 2nd|Oversold bounce RSI (1\d|2[0-8])|Overbought RSI (7[2-9]|8\d)/i.test(
    thesis,
  );
}

export const APLUS_MENU =
  "double · pin · engulf · climax · dry-up · washout · failed range · trend cooling · continuation (with BTC)";

export function aPlusKind(thesis: string): string | null {
  const t = thesis;
  if (/double (top|bottom)|buyers on 2nd|supply on 2nd|vol fade/i.test(t)) return "double";
  if (/failed range/i.test(t)) return "failed range";
  if (/Pin bar/i.test(t)) return "pin";
  if (/engulf/i.test(t)) return "engulf";
  if (/climax rejection/i.test(t)) return "climax";
  if (/Dry-up at/i.test(t)) return "dry-up";
  if (/washout RSI/i.test(t)) return "washout";
  if (/Trend cooling/i.test(t)) return "trend cooling";
  if (/Oversold bounce RSI (1\d|2[0-8])/i.test(t)) return "oversold";
  if (/Overbought RSI (7[2-9]|8\d)/i.test(t)) return "overbought";
  if (/Continuation/i.test(t)) return "continuation";
  return null;
}

export function confidenceBar(
  closed: { conf: number; pnl: number }[],
  base: number,
): { minConf: number; note: string } {
  const rows = closed.filter((c) => c.conf > 0);
  const recent = rows.slice(-12);
  const recentLoss = recent.filter((c) => c.pnl < 0).length;
  const wrBad = recent.length >= 8 && recentLoss / recent.length >= 0.5;
  const floor = wrBad ? 82 : Math.max(80, base);
  if (rows.length < 4) return { minConf: floor, note: `Bar ${floor}%+.` };
  const high = rows.filter((c) => c.conf >= base);
  const highLose = high.filter((c) => c.pnl < 0);
  if ((high.length >= 3 && highLose.length / high.length >= 0.5) || wrBad) {
    const minConf = Math.min(86, Math.max(floor, base + 4));
    return { minConf, note: `WR weak. Bar ${minConf}%.` };
  }
  return { minConf: floor, note: `Bar ${floor}%+.` };
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
    lines.push("Nothing on. Waiting for a 1h idea that tags the 15m mean, clears spread, and fits 2L+2S.");
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
