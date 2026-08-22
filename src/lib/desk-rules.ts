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

export function blocksBeta(
  open: { weex: string; side: Side }[],
  next: { weex: string; side: Side },
): boolean {
  const net = open.reduce((s, p) => s + signedBeta(p.weex, p.side), 0);
  const add = signedBeta(next.weex, next.side);
  // Hedge is allowed: long one name, short another.
  if (Math.abs(add) <= 0.3) return false;
  const sameWay = (net > 0 && add > 0) || (net < 0 && add < 0);
  if (!sameWay) return false;
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

export function chopTakeMs(style: Style): number {
  return style === "scalp" ? 16 * 3600_000 : 40 * 3600_000;
}

export function shouldCancelStaleLimit(createdAt: string | Date, style: Style): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > limitMaxAgeMs(style);
}

/** Red/dead → flatten. Small green → lock fee-BE. Runners and BE leftovers → hold. */
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
  const age = Date.now() - t;
  if (age < fillMaxAgeMs(opts.style)) return "hold";
  const risk = Math.abs(opts.entry - opts.stop);
  const favor = opts.side === "long" ? opts.last - opts.entry : opts.entry - opts.last;
  const r = risk > 0 ? favor / risk : 0;
  if (r <= 0) return "flatten";
  if (age >= chopTakeMs(opts.style)) return "flatten";
  return "lockBe";
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
}): number | null {
  const a = atr(opts.hourly, 14);
  if (a == null || a <= 0 || opts.hourly.length < 8) return null;
  const slice = opts.hourly.slice(-8);
  const be = breakevenPrice(opts.side, opts.entry);
  if (opts.side === "long") {
    const floor = Math.min(...slice.map((c) => c.low)) - 0.15 * a;
    const next = Math.max(opts.stop, floor, be);
    return next > opts.stop * 1.0002 ? next : null;
  }
  const ceil = Math.max(...slice.map((c) => c.high)) + 0.15 * a;
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
  const sides = new Map<string, PlanRecord>();
  for (const r of rows) {
    bucket(plans, r.plan || "vela", r.pnl);
    if (r.weex) bucket(symbols, r.weex, r.pnl);
    if (r.side) bucket(sides, r.side, r.pnl);
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
  const long = sides.get("long");
  const short = sides.get("short");
  if (long && short && long.closed >= 4 && short.closed >= 4) {
    if (long.pnl > short.pnl + 1) bits.push("favor longs");
    if (short.pnl > long.pnl + 1) bits.push("favor shorts");
  }
  return {
    plans: [...plans.values()],
    skipPlans,
    skipSymbols,
    note: bits.length ? `Learned: ${bits.join("; ")}.` : "Learning: not enough closes yet (needs 6–8 per setup).",
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

/** If high-confidence tickets keep stopping out, the bar moves up. Never claims 90%. */
export function confidenceBar(
  closed: { conf: number; pnl: number }[],
  base: number,
): { minConf: number; note: string } {
  const rows = closed.filter((c) => c.conf > 0);
  if (rows.length < 4) return { minConf: base, note: "" };
  const high = rows.filter((c) => c.conf >= base);
  const highLose = high.filter((c) => c.pnl < 0);
  if (high.length >= 3 && highLose.length / high.length >= 0.5) {
    const minConf = Math.min(82, base + 8);
    return {
      minConf,
      note: `High-conf SLs ${highLose.length}/${high.length}. Bar now ${minConf}%.`,
    };
  }
  const low = rows.filter((c) => c.conf < base);
  const lowWin = low.filter((c) => c.pnl > 0);
  if (low.length >= 4 && lowWin.length / low.length >= 0.6) {
    const minConf = Math.max(58, base - 4);
    return { minConf, note: `Lower-conf tickets paid. Bar ${minConf}%.` };
  }
  return { minConf: base, note: "" };
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
    lines.push("Nothing on. Waiting for a setup that clears 4h + 15m + spread + one-beta.");
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
