import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { adaptMethod, clampPeak, GOAL_USD, STAGE2_USD, multipleToGoal, phaseForRun, progressPct, stageTarget } from "@/lib/goal";

type SettingsRow = {
  user_id: string;
  venue: string;
  weex_mode: string;
  armed: boolean;
  api_key_enc: string | null;
  api_secret_enc: string | null;
  api_pass_enc: string | null;
  key_hint: string | null;
  risk_pct: string | number;
  account_usd: string | number;
  max_leverage: number;
  min_rr: string | number;
  max_open: number;
  last_tick_at: string | null;
  last_tick_note: string | null;
  goal_usd: string | number | null;
  peak_usd: string | number | null;
  loss_streak: number | null;
  win_streak: number | null;
  last_correction: string | null;
  keep_alive: boolean | null;
  last_cron_at: string | null;
  public_origin: string | null;
  continue_to_goal: boolean | null;
  stats_from: string | null;
  updated_at: string;
};

type SignalRow = {
  id: number;
  user_id: string;
  symbol: string;
  weex_symbol: string;
  side: string;
  style: string;
  entry_type: string;
  entry: string | number;
  stop: string | number;
  target: string | number;
  qty: string | number;
  leverage: number;
  risk_usd: string | number;
  notional: string | number;
  rr: string | number;
  thesis: string;
  invalidation: string | null;
  status: string;
  venue: string;
  client_oid: string | null;
  weex_resp: string | null;
  fill_px: string | number | null;
  closed_px: string | number | null;
  pnl: string | number | null;
  review: string | null;
  targets: string | null;
  scale: string | null;
  be_moved: boolean;
  tp1_hit?: boolean;
  plan: string | null;
  filled_at: string | null;
  score: string | number | null;
  confidence: string | number | null;
  close_reason: string | null;
  created_at: string;
  updated_at: string;
};

function n(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Full size from notional — qty is shrunk after TP1. */
function origQty(row: {
  qty?: string | number | null;
  notional?: string | number | null;
  fill_px?: string | number | null;
  entry?: string | number | null;
  risk_usd?: string | number | null;
  targets?: string | null;
}): number {
  const e = n(row.fill_px) || n(row.entry);
  const fromNotional = e > 0 ? n(row.notional) / e : 0;
  return Math.max(n(row.qty), fromNotional);
}

function takeQtys(
  total: number,
  nTakes: number,
  precision: number,
  fmt: (q: number, p: number) => string,
): string[] {
  const count = Math.max(1, nTakes);
  const slices: string[] = [];
  let used = 0;
  for (let i = 0; i < count; i += 1) {
    if (i === count - 1) {
      slices.push(fmt(Math.max(0, total - used), precision));
    } else {
      const part = count === 2 && i === 0 ? total * 0.7 : total / count;
      const s = fmt(part, precision);
      used += Number(s);
      slices.push(s);
    }
  }
  return slices;
}

function throughStop(side: string, last: number, stop: number): boolean {
  if (!(stop > 0) || !(last > 0)) return false;
  return side === "short" ? last >= stop * 0.997 : last <= stop * 1.003;
}

/** 1R in dollars: original stop × full size. BE stop is not 1R. */
function oneRUsd(row: {
  qty?: string | number | null;
  notional?: string | number | null;
  fill_px?: string | number | null;
  entry?: string | number | null;
  stop?: string | number | null;
  targets?: string | null;
  be_moved?: boolean | null;
  rr?: string | number | null;
  target?: string | number | null;
}): number {
  const e = n(row.fill_px) || n(row.entry);
  const q = origQty(row);
  if (!(e > 0) || !(q > 0)) return 0;
  const stop = n(row.stop);
  const beLike = Boolean(row.be_moved) || (stop > 0 && Math.abs(stop - e) / e < 0.004);
  let dist = !beLike && stop > 0 ? Math.abs(e - stop) : 0;
  const tp1 = parseNums(row.targets)[0];
  if (!(dist > 0) && tp1 != null) dist = Math.abs(tp1 - e);
  if (!(dist > 0) && n(row.rr) > 0.2 && n(row.target) > 0) dist = Math.abs(n(row.target) - e) / n(row.rr);
  return dist * q;
}

const OPEN = new Set(["proposed", "working", "filled"]);

async function ensureSettings(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
) {
  await sql`
    insert into auto_settings (user_id) values (${userId})
    on conflict (user_id) do nothing
  `;
}

function livePhase(
  row: SettingsRow,
  stats: { closed: number; wins: number } = { closed: 0, wins: 0 },
) {
  const equity = Math.max(0.01, n(row.account_usd) || 0);
  const peak = clampPeak(equity, n(row.peak_usd) || equity);
  const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  return adaptMethod({
    phase: phaseForRun(equity, Boolean(row.continue_to_goal)),
    lossStreak: row.loss_streak ?? 0,
    winStreak: row.win_streak ?? 0,
    lastMargin: n(row.risk_pct) || 2,
    drawdownPct: dd,
    closed: stats.closed,
    wins: stats.wins,
  });
}

function feeBePx(side: "long" | "short", entry: number, mark: number, weexBe: number): number {
  const raw = weexBe > 0 ? weexBe : side === "long" ? entry * 1.002 : entry * 0.998;
  if (side === "long") {
    const want = Math.max(raw, entry * 1.0004);
    if (mark > 0 && want >= mark * 0.999) return Math.min(want, mark * 0.9985);
    return want;
  }
  const want = Math.min(raw, entry * 0.9996);
  if (mark > 0 && want <= mark * 1.001) return Math.max(want, mark * 1.0015);
  return want;
}

function huntHeader(liveL: number, liveS: number, beN = 0, liveTotal?: number) {
  const at = liveL + liveS;
  const live = liveTotal ?? at + beN;
  if (live >= 3) {
    return `Not hunting — ${live} live (${at} at-risk, ${beN} BE). Cap 3.`;
  }
  if (at >= 2) {
    return `Not hunting — 2 at-risk (${liveL}L/${liveS}S). 3rd after one TP1/BE.`;
  }
  if (at === 1 && beN >= 1) {
    return `Hunting 3rd A++ (${liveL}L/${liveS}S at-risk, ${beN} BE). Cap 3.`;
  }
  if (beN >= 1 && at === 0) {
    return `Hunting (${beN} BE live, 0 at-risk). Room for 2 at 3%.`;
  }
  if (at === 1) {
    return `Hunting 2nd A++ (${liveL}L/${liveS}S at-risk). 2 at 3%. 3rd if one is TP1/BE.`;
  }
  return `Hunting 1 A++ per tick, long or short (${liveL}L/${liveS}S at-risk).`;
}

function composePass(
  note: string | null,
  liveL: number,
  liveS: number,
  liveLines: string[],
  beN = 0,
  liveTotal?: number,
) {
  const head = huntHeader(liveL, liveS, beN, liveTotal);
  const fromTick = (note ?? "")
    .split("\n")
    .map((ln) => ln.trim())
    .filter((ln) =>
      /^(Eying |Took |Skip |BTC |Book |One |A\+\+)/i.test(ln),
    )
    .filter((ln) => !/trend cooling|80%\+|21h-mean|No dip-buy vs a dump/i.test(ln));
  const uniq = [...new Set([...liveLines.filter(Boolean), ...fromTick])];
  return [head, ...uniq].filter(Boolean).join("\n");
}

function publicSettings(
  row: SettingsRow,
  stats: { closed: number; wins: number; winRate?: number; avgWinR?: number; avgLossR?: number; names?: string[] } = { closed: 0, wins: 0 },
  live?: { equity: number; available: number } | null,
  weexError?: string | null,
  book?: { liveL?: number; liveS?: number; liveLines?: string[]; beN?: number; liveTotal?: number },
) {
  const liveEq = live?.equity;
  const equity = liveEq != null ? liveEq : 0;
  let peak = liveEq != null ? Math.max(n(row.peak_usd) || liveEq, liveEq) : 0;
  if (liveEq != null) peak = clampPeak(liveEq, peak);
  const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  const phase = livePhase({ ...row, account_usd: Math.max(equity, liveEq != null ? equity : 0) }, stats);
  return {
    venue: "weex" as const,
    weexMode: "live" as const,
    margin: "CROSSED" as const,
    armed: Boolean(row.armed),
    hasKeys: Boolean(row.api_key_enc && row.api_secret_enc && row.api_pass_enc),
    keyHint: row.key_hint,
    riskPct: liveEq != null ? phase.marginPct : 3,
    accountUsd: equity,
    availableUsd: live?.available ?? 0,
    weexLive: Boolean(live),
    weexError: weexError ?? null,
    minRr: phase.minRr,
    maxOpen: phase.maxOpen,
    lastTickAt: row.last_tick_at,
    lastTickNote: composePass(
      row.last_tick_note,
      book?.liveL ?? 0,
      book?.liveS ?? 0,
      book?.liveLines ?? [],
      book?.beN ?? 0,
      book?.liveTotal,
    ),
    goalUsd: n(row.goal_usd) || GOAL_USD,
    peakUsd: peak,
    lossStreak: row.loss_streak ?? 0,
    drawdownPct: dd,
    progressPct: liveEq != null ? progressPct(equity, stageTarget(equity, Boolean(row.continue_to_goal))) : 0,
    multipleToGoal: liveEq != null && equity > 0 ? multipleToGoal(equity, stageTarget(equity, Boolean(row.continue_to_goal))) : 0,
    stageTarget: liveEq != null ? stageTarget(equity, Boolean(row.continue_to_goal)) : STAGE2_USD,
    continueToGoal: Boolean(row.continue_to_goal),
    phase: liveEq != null ? phase.name : "Waiting",
    phaseId: liveEq != null ? phase.id : "micro",
    style: phase.style,
    method: phase.method,
    correction:
      liveEq != null
        ? (row.last_correction ?? phase.note)
        : "Store WEEX keys. Until then this is not a book — the $1M bar stays at zero.",
    closed: stats.closed,
    wins: stats.wins,
    winRate: stats.winRate ?? 0,
    avgWinR: stats.avgWinR ?? 0,
    avgLossR: stats.avgLossR ?? 0,
    recordNames: stats.names ?? [],
    keepAlive: Boolean(row.keep_alive),
    lastCronAt: row.last_cron_at,
    publicOrigin: row.public_origin,
  };
}

async function credsFrom(row: SettingsRow) {
  if (!(row.api_key_enc && row.api_secret_enc && row.api_pass_enc)) return null;
  const { openSeal } = await import("@/lib/weex.server");
  return {
    apiKey: openSeal(row.api_key_enc),
    apiSecret: openSeal(row.api_secret_enc),
    passphrase: openSeal(row.api_pass_enc),
  };
}

async function pullWeexBook(row: SettingsRow) {
  const creds = await credsFrom(row);
  if (!creds) return { live: null as { equity: number; available: number } | null, error: null as string | null };
  const { getWeexEquity } = await import("@/lib/weex.server");
  const bal = await getWeexEquity(creds);
  if (!bal.ok) return { live: null, error: bal.error };
  return { live: bal.data, error: null };
}

function uniqueFills<T extends {
  weex_symbol?: string | null;
  side?: string | null;
  filled_at?: string | Date | null;
  updated_at?: string | Date | null;
  created_at?: string | Date | null;
  id?: number;
}>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const fill = new Date(r.filled_at ?? r.created_at ?? 0).getTime();
    const bucket = Number.isFinite(fill) ? Math.floor(fill / (2 * 3600_000)) : 0;
    const key = `${r.weex_symbol ?? "?"}|${r.side ?? "?"}|${bucket}`;
    const prev = best.get(key);
    const rp = Math.abs(n((r as { pnl?: string | number | null }).pnl));
    const pp = prev ? Math.abs(n((prev as { pnl?: string | number | null }).pnl)) : -1;
    if (!prev || rp >= pp) best.set(key, r);
  }
  return [...best.values()];
}

async function closedStats(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  statsFrom?: string | Date | null,
) {
  const rows = await sql<{
    id: number;
    pnl: string | number | null;
    entry: string | number | null;
    stop: string | number | null;
    qty: string | number | null;
    fill_px: string | number | null;
    risk_usd: string | number | null;
    notional: string | number | null;
    targets: string | null;
    target: string | number | null;
    be_moved: boolean | null;
    weex_symbol: string | null;
    side: string | null;
    filled_at: string | null;
    updated_at: string | null;
    created_at: string | null;
    close_reason: string | null;
    plan: string | null;
    rr: string | number | null;
    status: string | null;
  }>`
    select id, pnl, entry, stop, qty, fill_px, risk_usd, notional, targets, target, be_moved,
           weex_symbol, side, filled_at, updated_at, created_at, close_reason, plan, rr, status
    from auto_signals
    where user_id = ${userId}
      and status in ('stopped','targeted','skipped')
      and filled_at is not null
      and client_oid is not null
      and abs(coalesce(pnl, 0)) > 0.15
      and (
        close_reason is null
        or (
          close_reason not like 'Replaced by%'
          and close_reason not like 'Cancelled%'
          and close_reason not like 'Ghost%'
          and close_reason not like 'Limit never%'
          and close_reason not like 'Stale claim%'
          and close_reason not like 'Duplicate%'
          and close_reason not like 'off the book%'
        )
      )
  `;
  const closeAt = (r: { filled_at?: string | null; created_at?: string | null }) => {
    const f = new Date(r.filled_at ?? r.created_at ?? 0).getTime();
    return Number.isFinite(f) ? f : 0;
  };
  const uniq = uniqueFills(rows).sort((a, b) => closeAt(a) - closeAt(b));
  const STATS_RESET = "2026-08-30T19:05:00.000Z";
  const resetAt = new Date(STATS_RESET).getTime();
  let tFrom = statsFrom ? new Date(statsFrom).getTime() : 0;
  if (!(tFrom >= resetAt)) {
    tFrom = resetAt;
    await sql`update auto_settings set stats_from = ${STATS_RESET} where user_id = ${userId}`;
  }
  const rOf = (r: (typeof uniq)[number]) => {
    const unit = oneRUsd(r);
    if (!(unit > 0.05)) return null;
    return n(r.pnl) / unit;
  };
  const window = uniq.filter((r) => {
    if (closeAt(r) < tFrom - 2000) return false;
    const rr = rOf(r);
    if (rr != null && rr > 0 && rr < 0.4) return false;
    const reason = r.close_reason ?? "";
    if (/BE scratch|Closed in green/i.test(reason) && n(r.pnl) > 0 && (rr == null || rr < 0.4)) return false;
    return true;
  });
  const closed = window.length;
  const wins = window.filter((r) => n(r.pnl) > 0).length;
  const winR = window.map(rOf).filter((x): x is number => x != null && x > 0);
  const lossR = window.map(rOf).filter((x): x is number => x != null && x < 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    closed,
    wins,
    winRate: closed > 0 ? (wins / closed) * 100 : 0,
    avgWinR: avg(winR),
    avgLossR: avg(lossR),
    names: [...window]
      .reverse()
      .map((r) => {
        const p = n(r.pnl);
        const pair = (r.weex_symbol ?? "").replace("USDT", "");
        return `${pair} ${p >= 0 ? "+" : ""}${p.toFixed(2)}`;
      })
      .slice(0, 15),
  };
}

function inferClose(row: SignalRow): string | null {
  if (row.close_reason) return row.close_reason;
  if (row.status === "stopped") return "Hit stop";
  if (row.status === "targeted") return "Took profit";
  if (row.status === "skipped") {
    if (n(row.pnl) < 0) return "Sold at a loss to move on — went nowhere";
    if (n(row.pnl) > 0) return "Time stop — flattened";
    return "Limit never filled";
  }
  return null;
}

function parseNums(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  } catch {
    return [];
  }
}

function mapSignal(row: SignalRow) {
  return {
    id: row.id,
    symbol: row.symbol,
    weexSymbol: row.weex_symbol,
    side: row.side === "short" ? ("short" as const) : ("long" as const),
    style: row.style,
    entryType: row.entry_type,
    entry: n(row.entry),
    stop: n(row.stop),
    target: n(row.target),
    qty: n(row.qty),
    leverage: row.leverage,
    riskUsd: n(row.risk_usd),
    notional: n(row.notional),
    rr: n(row.rr),
    thesis: row.thesis,
    invalidation: row.invalidation,
    status: row.status,
    venue: row.venue,
    fillPx: row.fill_px == null ? null : n(row.fill_px),
    closedPx: row.closed_px == null ? null : n(row.closed_px),
    pnl: row.pnl == null ? null : n(row.pnl),
    review: row.review,
    targets: parseNums(row.targets),
    beMoved: Boolean(row.be_moved),
    tp1Hit: Boolean(row.tp1_hit),
    plan: row.plan,
    score: row.score == null ? null : n(row.score),
    confidence: row.confidence == null ? null : n(row.confidence),
    liveOnWeex: false,
    closeReason: inferClose(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ticketLedger(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  statsFrom?: string | Date | null,
) {
  const from = statsFrom ?? new Date(0).toISOString();
  const rows = await sql<{
    plan: string | null;
    side: string | null;
    weex_symbol: string | null;
    pnl: string | number | null;
    filled_at: string | null;
    updated_at: string | null;
    created_at: string | null;
    id: number;
  }>`
    select id, plan, side, weex_symbol, pnl, filled_at, updated_at, created_at from auto_signals
    where user_id = ${userId} and status in ('stopped','targeted')
      and filled_at is not null
      and client_oid is not null
      and abs(coalesce(pnl, 0)) > 0.15
      and (close_reason is null or (
        close_reason not like 'Duplicate%'
        and close_reason not like 'Cancelled%'
        and close_reason not like 'Stale claim%'
        and close_reason not like 'BE scratch%'
        and close_reason not like 'Limit%'
      ))
      and created_at >= ${from}
  `;
  const { buildLedger } = await import("@/lib/desk-rules");
  return buildLedger(
    uniqueFills(rows).map((r) => ({
      plan: r.plan,
      side: r.side,
      weex: r.weex_symbol,
      pnl: n(r.pnl),
    })),
  );
}

function whyFromWeex(
  hit: { pnl: number; closePx: number; ts?: number },
  row: {
    side: string;
    be_moved?: boolean | null;
    tp1_hit?: boolean | null;
    targets?: string | null;
    filled_at?: string | null;
    created_at?: string;
    fill_px?: string | number | null;
    entry?: string | number | null;
    stop?: string | number | null;
  },
  px: number,
): string {
  const tps = parseNums(row.targets);
  const tp1 = tps[0];
  const tp2 = tps[1];
  const sd = row.side === "short" ? "short" : "long";
  const entry = n(row.fill_px) || n(row.entry);
  const stopNow = n(row.stop);
  const beLike =
    Boolean(row.be_moved) || (entry > 0 && stopNow > 0 && Math.abs(stopNow - entry) / entry < 0.004);
  const origStop =
    !beLike && stopNow > 0
      ? stopNow
      : tp1 != null && entry > 0
        ? sd === "short"
          ? entry + Math.abs(entry - tp1)
          : entry - Math.abs(tp1 - entry)
        : 0;
  const near = (level: number, tol = 0.007) =>
    px > 0 && level > 0 && Math.abs(px - level) / level <= tol;
  const throughTp2 =
    tp2 != null && px > 0 && (sd === "short" ? px <= tp2 * 1.006 : px >= tp2 * 0.994);
  const throughTp1 =
    tp1 != null && px > 0 && (sd === "short" ? px <= tp1 * 1.004 : px >= tp1 * 0.996);
  const throughSl =
    origStop > 0 && px > 0 && (sd === "short" ? px >= origStop * 0.997 : px <= origStop * 1.003);
  if (throughTp2 || near(tp2 ?? 0)) return "Hit TP2";
  if (throughTp1) return hit.pnl >= 0 && beLike && (near(entry, 0.01) || near(stopNow, 0.008)) ? "TP1 then BE" : "Hit TP1";
  if (hit.pnl >= 0 && beLike && Boolean(row.tp1_hit) && (near(entry, 0.01) || near(stopNow, 0.008))) {
    return "TP1 then BE";
  }
  if (throughSl || (origStop > 0 && near(origStop, 0.008) && hit.pnl < 0)) return "Hit stop";
  const t0 = new Date(row.filled_at ?? row.created_at ?? 0).getTime();
  const heldH = t0 > 0 && hit.ts ? (hit.ts - t0) / 3600_000 : 0;
  if (heldH >= 5 && Math.abs(hit.pnl) < 0.5) return "Time stop — flattened";
  if (hit.pnl >= 0.15) return "Closed in green";
  if (hit.pnl <= -0.05) return "Flattened";
  return "Closed on WEEX";
}

function applyWeexHit(hit: { pnl: number; closePx: number; qty?: number; ts?: number }, row: SignalRow) {
  const px = hit.closePx > 0 ? hit.closePx : n(row.closed_px);
  const why = whyFromWeex(hit, row, px);
  const st = why.startsWith("Time stop")
    ? "skipped"
    : hit.pnl >= 0.05
      ? "targeted"
      : hit.pnl <= -0.05
        ? "stopped"
        : "skipped";
  return { pnl: hit.pnl, px, why, st };
}

function matchWeexClose(
  row: {
    weex_symbol: string;
    side: string;
    created_at: string;
    filled_at?: string | null;
    updated_at?: string | null;
    fill_px?: string | number | null;
    entry?: string | number | null;
    qty?: string | number | null;
    notional?: string | number | null;
  },
  closes: { symbol: string; side?: "long" | "short"; pnl: number; closePx: number; entry?: number; ts: number; qty?: number }[],
  used?: Set<string>,
) {
  const key = row.weex_symbol.replace(/_/g, "").toUpperCase();
  const side = row.side === "short" ? "short" : "long";
  const t0 = new Date(row.filled_at ?? row.created_at).getTime();
  const t1 = new Date(row.updated_at ?? row.filled_at ?? row.created_at).getTime();
  const tClose = t1 > t0 ? t1 : t0;
  const entry = n(row.fill_px) || n(row.entry);
  const cands = closes.filter((c) => {
    if (c.symbol.replace(/_/g, "").toUpperCase() !== key) return false;
    if (c.side && c.side !== side) return false;
    const id = `${c.symbol}|${c.side ?? "?"}|${c.entry ?? 0}|${c.ts}|${c.pnl}`;
    if (used?.has(id)) return false;
    if (c.ts && t0 > 0 && (c.ts < t0 - 30 * 60_000 || c.ts > tClose + 12 * 3600_000)) return false;
    const ed = entry > 0 && c.entry && c.entry > 0 ? Math.abs(c.entry - entry) / entry : 0;
    if (c.entry && c.entry > 0 && ed > 0.008) return false;
    return true;
  });
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const da = Math.abs((a.ts || 0) - tClose);
    const db = Math.abs((b.ts || 0) - tClose);
    if (Math.abs(da - db) > 60_000) return da - db;
    const ea = entry > 0 && (a.entry ?? 0) > 0 ? Math.abs((a.entry ?? 0) - entry) / entry : 1;
    const eb = entry > 0 && (b.entry ?? 0) > 0 ? Math.abs((b.entry ?? 0) - entry) / entry : 1;
    return ea - eb;
  });
  const top = cands[0]!;
  used?.add(`${top.symbol}|${top.side ?? "?"}|${top.entry ?? 0}|${top.ts}|${top.pnl}`);
  return top;
}

async function restampWeexPnl(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  creds: { apiKey: string; apiSecret: string; passphrase: string },
  notes: string[],
  closesIn?: { symbol: string; side?: "long" | "short"; pnl: number; closePx: number; entry?: number; ts: number; qty?: number }[],
) {
  const { listWeexClosedPnl } = await import("@/lib/weex.server");
  const closes = closesIn ?? (await listWeexClosedPnl(creds).catch(() => []));
  const rows = await sql<SignalRow>`
    select * from auto_signals
    where user_id = ${userId}
      and status in ('stopped','targeted','skipped')
      and filled_at > now() - interval '7 days'
  `;
  const used = new Set<string>();
  for (const row of rows) {
    if (/^Limit |^Duplicate|^Replaced by|^Cancelled/.test(String(row.close_reason ?? ""))) continue;
    const hit = matchWeexClose(row, closes, used);
    if (!hit) {
      const entry = n(row.fill_px) || n(row.entry);
      const ghost = closes.find((c) => {
        if (c.symbol.replace(/_/g, "").toUpperCase() !== row.weex_symbol.replace(/_/g, "").toUpperCase()) return false;
        if (c.side && c.side !== (row.side === "short" ? "short" : "long")) return false;
        const ed = entry > 0 && (c.entry ?? 0) > 0 ? Math.abs((c.entry ?? 0) - entry) / entry : 1;
        return ed <= 0.008;
      });
      if (ghost && Math.abs(n(row.pnl) - ghost.pnl) > 1) {
        await sql`
          update auto_signals
          set pnl = 0,
              close_reason = ${"Duplicate WEEX fill"},
              status = 'skipped',
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(`${row.weex_symbol} duplicate ticket — dropped from WR`);
      }
      continue;
    }
    const book = applyWeexHit(hit, row);
    if (
      Math.abs(book.pnl - n(row.pnl)) < 0.05 &&
      row.close_reason === book.why &&
      row.status === book.st
    )
      continue;
    await sql`
      update auto_signals
      set pnl = ${book.pnl},
          closed_px = ${book.px || null},
          fill_px = ${hit.entry && hit.entry > 0 ? hit.entry : n(row.fill_px)},
          status = ${book.st},
          close_reason = ${book.why},
          tp1_hit = ${book.pnl > 0.3 || Boolean(row.be_moved)},
          qty = ${Math.max(origQty(row), hit.qty ?? 0)},
          updated_at = now()
      where id = ${row.id} and user_id = ${userId}
    `;
    notes.push(`${row.weex_symbol} WEEX ${book.pnl >= 0 ? "+" : ""}${book.pnl.toFixed(2)} · ${book.why}`);
  }
  return closes;
}

async function collapseOpenDupes(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  settings: SettingsRow,
  notes: string[],
) {
  const open = await sql<SignalRow>`
    select * from auto_signals
    where user_id = ${userId} and status in ('proposed','working','filled')
    order by created_at asc
  `;
  const groups = new Map<string, SignalRow[]>();
  for (const r of open) {
    const k = `${r.weex_symbol}:${r.side}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  const creds = await credsFrom(settings);
  for (const [, rows] of groups) {
    if (rows.length < 2) continue;
    const keep = rows[0]!;
    for (const extra of rows.slice(1)) {
      await sql`
        update auto_signals
        set status = 'skipped',
            pnl = 0,
            close_reason = ${"Duplicate — merged into one ticket"},
            updated_at = now()
        where id = ${extra.id} and user_id = ${userId}
      `;
    }
    if (creds) {
      const { getWeexPositionQty } = await import("@/lib/weex.server");
      const liveQty = await getWeexPositionQty(creds, keep.weex_symbol);
      if (liveQty != null && liveQty > 0) {
        await sql`
          update auto_signals
          set qty = ${liveQty}, updated_at = now()
          where id = ${keep.id} and user_id = ${userId}
        `;
      }
    }
    notes.push(`Merged ${rows.length} ${keep.weex_symbol} into one ticket. Full WEEX size kept.`);
  }
}

async function weexFeeBe(
  creds: { apiKey: string; apiSecret: string; passphrase: string } | null,
  symbol: string,
  side: "long" | "short",
  entry: number,
): Promise<number> {
  const { breakevenPrice } = await import("@/lib/ta");
  const fallback = breakevenPrice(side, entry);
  if (!creds) return fallback;
  const { listWeexPositions } = await import("@/lib/weex.server");
  const book = await listWeexPositions(creds).catch(() => null);
  const key = symbol.replace(/_/g, "").toUpperCase();
  const hit = (book ?? []).find(
    (p) => p.symbol.replace(/_/g, "").toUpperCase() === key && p.side === side,
  );
  if (hit?.bePx && hit.bePx > 0) {
    if (side === "long" && hit.bePx > entry) return hit.bePx;
    if (side === "short" && hit.bePx < entry) return hit.bePx;
  }
  return fallback;
}

async function ensureTakes(
  pos: SignalRow,
  notes: string[],
  creds: { apiKey: string; apiSecret: string; passphrase: string },
  stopOverride?: number,
) {
  if (pos.status !== "filled") return;
  const { specFor, formatWeexQty, formatWeexPx } = await import("@/lib/weex-market.server");
  const { placeWeexTake, moveWeexStop, trimWeexTakes, cancelWeexProtective, listWeexPositions, listWeexAlgoRows } = await import("@/lib/weex.server");
  const stopPx = stopOverride != null && stopOverride > 0 ? stopOverride : n(pos.stop);
  const { coinByWeex } = await import("@/lib/universe");
  const spec = await specFor(coinByWeex(pos.weex_symbol));
  const book = await listWeexPositions(creds).catch(() => null);
  const key = pos.weex_symbol.replace(/_/g, "").toUpperCase();
  const sideLc = pos.side === "short" ? "short" : "long";
  const live = (book ?? []).find(
    (p) =>
      p.symbol.replace(/_/g, "").toUpperCase() === key &&
      (p.side === "short" ? "short" : "long") === sideLc,
  );
  const liveQty = live && live.qty > 0 ? live.qty : n(pos.qty);
  if (!(liveQty > 0)) return;
  const mark = live?.mark && live.mark > 0 ? live.mark : 0;
  const side = pos.side === "short" ? "SHORT" : "LONG";
  const { taggedTake } = await import("@/lib/ta");
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const [st] = await sql<{ stats_from: string | null }>`
    select stats_from from auto_settings where user_id = ${pos.user_id} limit 1
  `;
  const closed = st ? await closedStats(sql, pos.user_id, st.stats_from) : { wins: 0 };
  const runners = closed.wins >= 8;
  const afterTp1 = Boolean(pos.tp1_hit) || Boolean(pos.be_moved);
  const rawTps = parseNums(pos.targets).slice(0, runners ? 2 : 1);
  const tps: number[] = [];
  for (let i = 0; i < rawTps.length; i += 1) {
    if (afterTp1 && i === 0) continue;
    const px = Number(formatWeexPx(rawTps[i]!, spec.pricePrecision));
    if (!(px > 0)) continue;
    if (tps.some((t) => t === px)) continue;
    if (mark > 0 && taggedTake(sideLc, mark, px)) continue;
    tps.push(px);
  }
  const wantTakes = runners && !afterTp1 ? 2 : 1;
  if (!afterTp1 && tps.length < wantTakes && stopPx > 0) {
    const entryPx = n(pos.fill_px) || n(pos.entry) || mark;
    const risk = Math.abs(entryPx - stopPx);
    if (risk > 0 && entryPx > 0 && risk / entryPx >= 0.004) {
      const t1 = sideLc === "short" ? entryPx - risk : entryPx + risk;
      const t2 = sideLc === "short" ? entryPx - 2 * risk : entryPx + 2 * risk;
      for (const raw of (runners ? [t1, t2] : [t1])) {
        const px = Number(formatWeexPx(raw, spec.pricePrecision));
        if (px > 0 && !tps.includes(px) && !(mark > 0 && taggedTake(sideLc, mark, px))) tps.push(px);
      }
    }
  }
  const trimmed = await trimWeexTakes(creds, pos.weex_symbol, {
    side: sideLc,
    sl: stopPx,
    tps,
    mark,
  });
  if (trimmed.killed) {
    notes.push(`${pos.weex_symbol} cancelled ${trimmed.killed} extra TP/SL. Kept ${trimmed.kept} (1 SL + ${runners ? "2 TP" : "1 TP"} max).`);
  }
  const qtyStr = formatWeexQty(liveQty, spec.quantityPrecision);
  const oid = (tag: string) => `vela${tag}${pos.id}`.slice(0, 36);
  const needTp = afterTp1 ? Math.min(1, Math.max(0, tps.length)) : Math.min(wantTakes, Math.max(1, tps.length));
  const maxProtect = 1 + needTp;
  const armedOk = /tps:set/.test(pos.weex_resp ?? "");
  if (armedOk && trimmed.listed === 0 && stopOverride == null) {
    return;
  }
  if (trimmed.haveSl && trimmed.haveTp >= needTp && trimmed.listed <= maxProtect && stopOverride == null) {
    return;
  }
  if (stopOverride != null && stopPx > 0) {
    const { cancelWeexStops } = await import("@/lib/weex.server");
    await cancelWeexStops(creds, pos.weex_symbol, { side: sideLc, mark, keepPx: 0 });
    const slSent = await moveWeexStop(creds, {
      symbol: pos.weex_symbol,
      positionSide: side,
      stop: formatWeexPx(stopPx, spec.pricePrecision),
      quantity: qtyStr,
      clientOid: oid("be"),
    });
    if (!slSent.ok) notes.push(`${pos.weex_symbol} BE SL failed: ${slSent.error.slice(0, 80)}`);
    else notes.push(`${pos.weex_symbol} SL → WEEX BE ${stopPx.toFixed(4)}`);
    await sql`update auto_signals set weex_resp = ${`${(pos.weex_resp ?? "").replace(/tps:(lock|ok|swept|v3wipe|set|be|miss)@?\d*/g, "").trim()} tps:be`}, stop = ${stopPx}, updated_at = now() where id = ${pos.id}`;
    pos.stop = stopPx;
    return;
  }
  const extras = trimmed.listed > maxProtect || trimmed.wiped;
  if (extras) {
    const { cancelWeexOpenLimits } = await import("@/lib/weex.server");
    await cancelWeexProtective(creds, pos.weex_symbol);
    await cancelWeexOpenLimits(creds, pos.weex_symbol, pos.client_oid);
  }
  const placeSl = extras || trimmed.listed === 0 || !trimmed.haveSl;
  const placeTp = extras || trimmed.listed === 0 || trimmed.haveTp < needTp;
  if (placeSl && stopPx > 0) {
    const slSent = await moveWeexStop(creds, {
      symbol: pos.weex_symbol,
      positionSide: side,
      stop: formatWeexPx(stopPx, spec.pricePrecision),
      quantity: qtyStr,
      clientOid: oid("sl"),
    });
    if (!slSent.ok) notes.push(`${pos.weex_symbol} SL failed: ${slSent.error.slice(0, 80)}`);
  }
  let ok = 0;
  if (placeTp) {
    const slices = takeQtys(liveQty, tps.length, spec.quantityPrecision, formatWeexQty);
    const start = extras || trimmed.listed === 0 ? 0 : trimmed.haveTp;
    for (let i = start; i < tps.length; i += 1) {
      const slice = slices[i]!;
      if (Number(slice) <= 0) continue;
      if (!runners && liveQty > 0 && Number(slice) < liveQty * 0.85) continue;
      const sent = await placeWeexTake(creds, {
        symbol: pos.weex_symbol,
        positionSide: side,
        tp: formatWeexPx(tps[i]!, spec.pricePrecision),
        quantity: slice,
        clientOid: oid(`tp${i}`),
      });
      if (sent.ok) ok += 1;
      else notes.push(`${pos.weex_symbol} TP${i + 1} failed: ${sent.error.slice(0, 80)}`);
    }
  }
  const confirm = await listWeexAlgoRows(creds, pos.weex_symbol).catch(() => []);
  const seen = confirm.length;
  const tag = seen > 0 ? "tps:set" : "tps:miss";
  notes.push(`${pos.weex_symbol} 1 SL @ ${stopPx.toFixed(4)} + ${ok || trimmed.haveTp} TP${seen ? ` (${seen} on book)` : " (not listed yet)"}`);
  const stamp = `${(pos.weex_resp ?? "").replace(/tps:(lock|ok|swept|v3wipe|set|be|miss)@?\d*/g, "").trim()} ${tag}`.slice(0, 500);
  await sql`update auto_signals set weex_resp = ${stamp}, stop = ${stopPx}, updated_at = now() where id = ${pos.id}`;
  pos.weex_resp = stamp;
  pos.stop = stopPx;
}

async function resurrectLive(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  livePos: { symbol: string; qty: number; side?: string; entry?: number }[] | null,
  notes: string[],
  creds: { apiKey: string; apiSecret: string; passphrase: string } | null,
) {
  if (!livePos?.length) return;
  for (const p of livePos) {
    if (!(p.qty > 0)) continue;
    const key = p.symbol.replace(/_/g, "").toUpperCase();
    const side = p.side === "short" ? "short" : "long";
    const open = await sql<{ id: number }>`
      select id from auto_signals
      where user_id = ${userId}
        and weex_symbol = ${key}
        and side = ${side}
        and status in ('filled','working')
      limit 1
    `;
    if (open[0]) continue;
    const [row] = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId}
        and weex_symbol = ${key}
        and side = ${side}
      order by updated_at desc
      limit 1
    `;
    if (!row) {
      notes.push(`${key} live on WEEX with no ticket`);
      continue;
    }
    if (row.status === "stopped" || row.status === "targeted" || row.status === "skipped") {
      const when = new Date(row.filled_at ?? row.created_at).getTime();
      if (Number.isFinite(when) && Date.now() - when > 30 * 60_000) continue;
    }
    await sql`
      update auto_signals
      set status = 'filled',
          close_reason = null,
          closed_px = null,
          qty = ${p.qty},
          fill_px = coalesce(fill_px, ${p.entry ?? null}),
          updated_at = now()
      where id = ${row.id} and user_id = ${userId}
    `;
    notes.push(`Reattached ${key} ${side} — still live on WEEX, was marked ${row.status}`);
    if (creds) {
      const liveRow = { ...row, status: "filled" as const, qty: p.qty };
      await ensureTakes(liveRow, notes, creds);
    }
  }
}

async function closeFlatOnWeex(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  livePos: { symbol: string; qty: number }[] | null,
  notes: string[],
  creds: { apiKey: string; apiSecret: string; passphrase: string } | null,
): Promise<{ booked: number[]; flattened: string[] }> {
  const booked: number[] = [];
  const flattenedNow: string[] = [];
  const filled = await sql<SignalRow>`
    select * from auto_signals
    where user_id = ${userId} and status = 'filled'
  `;
  const { getWeexLast } = await import("@/lib/weex-market.server");
  const { getWeexPositionQty } = await import("@/lib/weex.server");
  for (const pos of filled) {
    const key = pos.weex_symbol.replace(/_/g, "").toUpperCase();
    const onList = (livePos ?? []).find((p) => {
      const s = p.symbol.replace(/_/g, "").toUpperCase();
      return (s === key || p.symbol === pos.weex_symbol) && p.qty > 0;
    });
    if (onList) continue;
    if (!creds) continue;
    const q = await getWeexPositionQty(creds, pos.weex_symbol);
    if (q == null || q > 0) continue;
    const { listWeexClosedPnl } = await import("@/lib/weex.server");
    let hit = matchWeexClose(pos, await listWeexClosedPnl(creds, pos.weex_symbol).catch(() => []));
    if (!hit) hit = matchWeexClose(pos, await listWeexClosedPnl(creds).catch(() => []));
    const last = await getWeexLast(pos.weex_symbol).catch(() => n(pos.fill_px ?? pos.entry));
    const entry = n(pos.fill_px) || n(pos.entry);
    const qty = origQty(pos);
    const guess =
      entry > 0 && last > 0 && qty > 0
        ? pos.side === "short"
          ? (entry - last) * qty
          : (last - entry) * qty
        : 0;
    const book = hit
      ? applyWeexHit(hit, pos)
      : {
          pnl: guess,
          px: last,
          why:
            guess <= -0.05 ? "Flattened" : guess >= 0.15 ? "Closed in green" : "Closed on WEEX",
          st: (guess >= 0.05 ? "targeted" : guess <= -0.05 ? "stopped" : "skipped") as
            | "targeted"
            | "stopped"
            | "skipped",
        };
    await sql`
      update auto_signals
      set status = ${book.st}, closed_px = ${book.px || last}, pnl = ${book.pnl}, close_reason = ${book.why}, updated_at = now()
      where id = ${pos.id} and user_id = ${userId}
    `;
    if (creds) {
      const { cancelWeexProtective } = await import("@/lib/weex.server");
      await cancelWeexProtective(creds, pos.weex_symbol).catch(() => null);
    }
    notes.push(`${pos.weex_symbol} ${book.why}${book.pnl ? ` ${book.pnl >= 0 ? "+" : ""}${book.pnl.toFixed(2)}` : ""}`);
    if (Math.abs(book.pnl) >= 0.05) booked.push(book.pnl);
    flattenedNow.push(pos.weex_symbol);
  }

  const recent = await sql<{ weex_symbol: string }>`
    select distinct weex_symbol from auto_signals
    where user_id = ${userId}
      and close_reason = 'Closed on WEEX'
      and updated_at > now() - interval '2 hours'
  `;
  const cooled = new Set(recent.map((r) => r.weex_symbol));
  if (cooled.size && creds) {
    const leftover = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId}
        and status in ('proposed','working')
        and weex_symbol = any(${Array.from(cooled)})
    `;
    const { cancelWeexOrder, cancelWeexProtective } = await import("@/lib/weex.server");
    for (const row of leftover) {
      if (row.client_oid) await cancelWeexOrder(creds, { symbol: row.weex_symbol, clientOid: row.client_oid }).catch(() => null);
      await cancelWeexProtective(creds, row.weex_symbol).catch(() => null);
      await sql`
        update auto_signals
        set status = 'skipped',
            close_reason = ${"Limit cancelled after flatten"},
            pnl = 0,
            updated_at = now()
        where id = ${row.id} and user_id = ${userId}
      `;
      notes.push(`${row.weex_symbol} leftover limit cancelled`);
    }
  }

  if (creds) {
    const open = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId} and status = 'filled' and weex_symbol is not null
    `;
    const { cancelWeexProtective, getWeexPositionQty } = await import("@/lib/weex.server");
    for (const pos of open) {
      const k = pos.weex_symbol.replace(/_/g, "").toUpperCase();
      const on = (livePos ?? []).some(
        (p) => p.qty > 0 && p.symbol.replace(/_/g, "").toUpperCase() === k,
      );
      if (on) continue;
      const q = await getWeexPositionQty(creds, pos.weex_symbol);
      if (q == null || q > 0) continue;
      await cancelWeexProtective(creds, pos.weex_symbol).catch(() => null);
    }
  }

  if (creds) {
    const hanging = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId} and status in ('proposed','working')
    `;
    const { getWeexPositionQty, hasWeexWorkingOrder } = await import("@/lib/weex.server");
    for (const row of hanging) {
      const q = await getWeexPositionQty(creds, row.weex_symbol);
      if (q != null && q > 0) continue;
      const open = await hasWeexWorkingOrder(creds, row.weex_symbol, row.client_oid);
      if (open === true) continue;
      if (open === false || q === 0) {
        await sql`
          update auto_signals
          set status = 'skipped',
              close_reason = ${"Limit gone on WEEX"},
              pnl = 0,
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(`${row.weex_symbol} limit gone on WEEX`);
      }
    }
  }
  return { booked, flattened: flattenedNow };
}

async function trimToTwoPct(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  settings: SettingsRow,
  livePos: { symbol: string; qty: number }[] | null,
  notes: string[],
  creds: { apiKey: string; apiSecret: string; passphrase: string },
  equity: number,
) {
  const filled = await sql<SignalRow>`
    select * from auto_signals
    where user_id = ${userId} and status = 'filled'
  `;
  if (!filled.length) return;
  const { specFor, formatWeexQty, formatWeexPx } = await import("@/lib/weex-market.server");
  const { flattenWeex, cancelWeexProtective, moveWeexStop, placeWeexTake } = await import("@/lib/weex.server");
  const { coinByWeex } = await import("@/lib/universe");
  for (const pos of filled) {
    const spec = await specFor(coinByWeex(pos.weex_symbol));
    const entry = n(pos.fill_px ?? pos.entry);
    if (!(entry > 0) || !(equity > 0)) continue;
    const wantQty = (equity * 0.03 * spec.maxLeverage) / entry;
    const key = pos.weex_symbol.replace(/_/g, "").toUpperCase();
    const live =
      livePos?.find((p) => p.symbol.replace(/_/g, "").toUpperCase() === key || p.symbol === pos.weex_symbol)
        ?.qty ?? n(pos.qty);
    if (live > wantQty * 1.12) {
      const dump = live - wantQty;
      const sent = await flattenWeex(creds, {
        symbol: pos.weex_symbol,
        side: pos.side === "short" ? "BUY" : "SELL",
        positionSide: pos.side === "short" ? "SHORT" : "LONG",
        quantity: formatWeexQty(dump, spec.quantityPrecision),
        clientOid: `velatrim${pos.id}${Date.now().toString(36)}`.slice(0, 36),
      });
      notes.push(
        sent.ok
          ? `Trimmed ${pos.weex_symbol} to ~3% margin`
          : `Trim ${pos.weex_symbol} failed: ${sent.error.slice(0, 80)}`,
      );
      if (sent.ok) {
        await sql`update auto_signals set qty = ${wantQty}, updated_at = now() where id = ${pos.id}`;
        pos.qty = wantQty;
        await ensureTakes(pos, notes, creds);
      }
    } else {
      continue;
    }
  }
}

export const getAutoDesk = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await ensureSettings(sql, context.userId);
    const { ensureAutoLoop } = await import("@/lib/auto-loop.server");
    ensureAutoLoop();
    const [settings] = await sql<SettingsRow>`
      select * from auto_settings where user_id = ${context.userId}
    `;
    const pulled = settings ? await pullWeexBook(settings) : { live: null, error: null };
    const live = pulled.live;
    let livePos: Awaited<ReturnType<typeof import("@/lib/weex.server").listWeexPositions>> | null = null;
    const creds = settings ? await credsFrom(settings) : null;
    let weexCloses: Awaited<ReturnType<typeof restampWeexPnl>> | [] = [];
    if (creds) {
      const { listWeexPositions } = await import("@/lib/weex.server");
      livePos = await listWeexPositions(creds).catch(() => null);
      weexCloses = await restampWeexPnl(sql, context.userId, creds, []);
    }
    if (settings && live) {
      const peak = Math.max(n(settings.peak_usd) || live.equity, live.equity);
      await sql`
        update auto_settings
        set account_usd = ${live.equity}, peak_usd = ${peak}, updated_at = now()
        where user_id = ${context.userId}
      `;
      settings.account_usd = live.equity;
      settings.peak_usd = peak;
    }
    let stats = await closedStats(sql, context.userId, settings?.stats_from);
    const byId = new Map<number, SignalRow>();
    const openRows = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${context.userId} and status in ('proposed','working','filled')
      order by created_at desc
    `;
    for (const r of openRows) byId.set(r.id, r);
    for (const p of livePos ?? []) {
      const key = p.symbol.replace(/_/g, "").toUpperCase();
      const side = p.side === "short" ? "short" : "long";
      const hit = await sql<SignalRow>`
        select * from auto_signals
        where user_id = ${context.userId}
          and weex_symbol = ${key}
          and side = ${side}
        order by updated_at desc
        limit 1
      `;
      const row = hit[0] ?? (
        await sql<SignalRow>`
          select * from auto_signals
          where user_id = ${context.userId}
            and weex_symbol = ${key}
          order by updated_at desc
          limit 1
        `
      )[0];
      if (row) byId.set(row.id, row);
    }
    const closedRows = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${context.userId}
        and status in ('stopped','targeted','skipped')
        and filled_at is not null
        and client_oid is not null
        and (
          close_reason is null
          or (
            close_reason not like 'Replaced by%'
            and close_reason not like 'Cancelled —%'
            and close_reason not like 'Duplicate%'
            and close_reason not like 'Stale claim%'
          )
        )
      order by coalesce(filled_at, created_at) desc
      limit 25
    `;
    for (const r of closedRows) if (!byId.has(r.id)) byId.set(r.id, r);
    const signals = [...byId.values()].sort((a, b) => {
      const liveA = a.status === "filled" || a.status === "working" ? 1 : 0;
      const liveB = b.status === "filled" || b.status === "working" ? 1 : 0;
      if (liveA !== liveB) return liveB - liveA;
      const ta = new Date(a.filled_at ?? a.created_at).getTime();
      const tb = new Date(b.filled_at ?? b.created_at).getTime();
      return tb - ta;
    });
    const mapped = signals
      .filter((r) => !(r.close_reason ?? "").startsWith("Duplicate"))
      .map(mapSignal);
    const { getWeexLast } = await import("@/lib/weex-market.server");
    const lastBy = new Map<string, number>();
    const leftBy = new Map<string, number>();
    const posBy = new Map<string, { qty: number; entry: number; pnl: number | null; mark: number; side: "long" | "short" }>();
    const seenLive = new Set<string>();
    if (settings) {
      const bookOk = livePos != null;
      for (const p of livePos ?? []) {
        const key = p.symbol.replace(/_/g, "").toUpperCase();
        const side = p.side === "short" ? "short" : "long";
        leftBy.set(p.symbol, p.qty);
        leftBy.set(key, p.qty);
        posBy.set(`${key}|${side}`, { ...p, side });
      }
      for (const t of mapped) {
        const key = t.weexSymbol.replace(/_/g, "").toUpperCase();
        const pos = posBy.get(`${key}|${t.side}`);
        const left = pos?.qty ?? 0;
        if (left > 0) {
          const stamp = `${key}|${t.side}`;
          if (!seenLive.has(stamp)) {
            t.liveOnWeex = true;
            if (t.status !== "working" && t.status !== "filled") t.status = "filled";
            seenLive.add(stamp);
          } else {
            t.liveOnWeex = false;
          }
        } else if (bookOk) {
          t.liveOnWeex = false;
        } else {
          t.liveOnWeex = t.status === "filled";
        }
      }
    }
    for (const t of mapped) {
      const key = t.weexSymbol.replace(/_/g, "").toUpperCase();
      const pos = posBy.get(`${key}|${t.side}`);
      const left = pos?.qty ?? leftBy.get(t.weexSymbol) ?? leftBy.get(key);
      if (t.status === "working" && !t.liveOnWeex) {
        t.pnl = null;
        continue;
      }
      if (t.status !== "filled" && t.status !== "working") continue;
      if (pos && pos.pnl != null && Number.isFinite(pos.pnl)) {
        t.pnl = pos.pnl;
        continue;
      }
      const mark = pos?.mark && pos.mark > 0 ? pos.mark : 0;
      if (!mark && !lastBy.has(t.weexSymbol)) {
        try {
          lastBy.set(t.weexSymbol, await getWeexLast(t.weexSymbol));
        } catch {
          lastBy.set(t.weexSymbol, 0);
        }
      }
      const last = mark || lastBy.get(t.weexSymbol) || 0;
      const entry = (pos?.entry && pos.entry > 0 ? pos.entry : 0) || t.fillPx || t.entry;
      if (last > 0 && entry > 0) {
        const qty = pos?.qty || t.qty;
        t.pnl = t.side === "short" ? (entry - last) * qty : (last - entry) * qty;
      }
    }
    const atRiskTick = (t: (typeof mapped)[number]) =>
      t.liveOnWeex && !(t.beMoved && t.tp1Hit);
    const liveL = mapped.filter((t) => atRiskTick(t) && t.side === "long").length;
    const liveS = mapped.filter((t) => atRiskTick(t) && t.side === "short").length;
    const beN = mapped.filter((t) => t.liveOnWeex && (t.beMoved && t.tp1Hit)).length;
    const liveTotal = mapped.filter((t) => t.liveOnWeex).length;
    const { whyTookTrade } = await import("@/lib/desk-rules");
    const liveLines = mapped
      .filter((t) => t.liveOnWeex || t.status === "working")
      .map((t) =>
        whyTookTrade({
          symbol: t.weexSymbol,
          side: t.side,
          conf: Math.round(t.confidence ?? 0),
          thesis: t.thesis ?? "",
          bias: "chop",
          live: t.status === "filled" || t.liveOnWeex,
          working: t.status === "working",
        }),
      );
    return {
      settings: publicSettings(settings!, stats, live, pulled.error, {
        liveL,
        liveS,
        liveLines,
        beN,
        liveTotal,
      }),
      signals: mapped,
      universe: (await import("@/lib/universe")).TOP25.map((c) => ({
        id: c.id,
        weex: c.weex,
        name: c.name,
        maxLeverage: c.fallbackMax,
      })),
    };
  });

export const saveAutoSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { accountUsd?: number }) => input)
  .handler(async ({ context, data }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await ensureSettings(sql, context.userId);
    const [cur] = await sql<SettingsRow>`select * from auto_settings where user_id = ${context.userId}`;
    const accountUsd = Math.max(5, data.accountUsd ?? n(cur?.account_usd) ?? 5);
    const peak = Math.max(n(cur?.peak_usd) || accountUsd, accountUsd);
    await sql`
      update auto_settings
      set venue = 'weex',
          weex_mode = 'live',
          account_usd = ${accountUsd},
          peak_usd = ${peak},
          goal_usd = ${GOAL_USD},
          updated_at = now()
      where user_id = ${context.userId}
    `;
    return { ok: true as const };
  });

export const saveWeexKeys = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { apiKey: string; apiSecret: string; passphrase: string }) => ({
    apiKey: input.apiKey.trim(),
    apiSecret: input.apiSecret.trim(),
    passphrase: input.passphrase.trim(),
  }))
  .handler(async ({ context, data }) => {
    if (!data.apiKey || !data.apiSecret || !data.passphrase) {
      throw new Error("Key, secret, and passphrase are all required.");
    }
    const { getSql } = await import("@/lib/db");
    const { seal, verifyKeys } = await import("@/lib/weex.server");
    const sql = await getSql();
    await ensureSettings(sql, context.userId);
    const check = await verifyKeys({
      apiKey: data.apiKey,
      apiSecret: data.apiSecret,
      passphrase: data.passphrase,
    });
    if (!check.ok) {
      throw new Error(check.error || "WEEX rejected those keys.");
    }
    const hint = `${data.apiKey.slice(0, 3)}…${data.apiKey.slice(-4)}`;
    const { getWeexEquity } = await import("@/lib/weex.server");
    const bal = await getWeexEquity({
      apiKey: data.apiKey,
      apiSecret: data.apiSecret,
      passphrase: data.passphrase,
    });
    const eq = bal.ok ? bal.data.equity : null;
    await sql`
      update auto_settings
      set api_key_enc = ${seal(data.apiKey)},
          api_secret_enc = ${seal(data.apiSecret)},
          api_pass_enc = ${seal(data.passphrase)},
          key_hint = ${hint},
          venue = 'weex',
          weex_mode = 'live',
          account_usd = ${eq ?? n((await sql<SettingsRow>`select account_usd from auto_settings where user_id = ${context.userId}`)[0]?.account_usd)},
          peak_usd = ${eq ?? 0},
          updated_at = now()
      where user_id = ${context.userId}
    `;
    return {
      ok: true as const,
      hint,
      weexNote: bal.ok
        ? `Keys accepted. Live WEEX equity ${bal.data.equity.toFixed(2)} USDT.`
        : `Stored. Could not read balance yet: ${bal.error.slice(0, 80)}`,
    };
  });

export const clearWeexKeys = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await sql`
      update auto_settings
      set api_key_enc = null, api_secret_enc = null, api_pass_enc = null, key_hint = null,
          armed = false, venue = 'weex', weex_mode = 'live', updated_at = now()
      where user_id = ${context.userId}
    `;
    return { ok: true as const };
  });

export const setArmed = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { armed: boolean }) => input)
  .handler(async ({ context, data }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await ensureSettings(sql, context.userId);
    if (data.armed) {
      const [cur] = await sql<SettingsRow>`select * from auto_settings where user_id = ${context.userId}`;
      if (!(cur?.api_key_enc && cur.api_secret_enc && cur.api_pass_enc)) {
        throw new Error("Store WEEX keys on this page before arming. Do not paste them in chat.");
      }
    }
    await sql`
      update auto_settings
      set armed = ${data.armed}, venue = 'weex', weex_mode = 'live', updated_at = now()
      where user_id = ${context.userId}
    `;
    if (data.armed) {
      const { ensureAutoLoop } = await import("@/lib/auto-loop.server");
      ensureAutoLoop();
    }
    return { armed: data.armed };
  });

export const setContinueToGoal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { on: boolean }) => input)
  .handler(async ({ context, data }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await ensureSettings(sql, context.userId);
    await sql`
      update auto_settings
      set continue_to_goal = ${data.on}, updated_at = now()
      where user_id = ${context.userId}
    `;
    return { on: data.on };
  });

export const setKeepAlive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { on: boolean; origin?: string }) => input)
  .handler(async ({ context, data }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await ensureSettings(sql, context.userId);
    if (data.on) {
      const [cur] = await sql<SettingsRow>`select * from auto_settings where user_id = ${context.userId}`;
      if (!(cur?.api_key_enc && cur.api_secret_enc && cur.api_pass_enc)) {
        throw new Error("Store WEEX keys before turning on 24/7.");
      }
    }
    const origin = data.origin?.trim() || null;
    await sql`
      update auto_settings
      set keep_alive = ${data.on},
          public_origin = coalesce(${origin}, public_origin),
          updated_at = now()
      where user_id = ${context.userId}
    `;
    if (data.on) {
      const { ensureAutoLoop } = await import("@/lib/auto-loop.server");
      ensureAutoLoop();
    }
    return { keepAlive: data.on };
  });

export async function stampCronHit() {
  const { getSql } = await import("@/lib/db");
  const { ensureAutoLoop } = await import("@/lib/auto-loop.server");
  ensureAutoLoop();
  const sql = await getSql();
  try {
    await sql`
      update auto_settings
      set last_cron_at = now()
      where keep_alive = true or armed = true
    `;
  } catch {
    /* columns may not exist on a stale preview DB */
  }
}

export const markCronHit = createServerFn({ method: "POST" }).handler(async () => {
  await stampCronHit();
  return { ok: true as const };
});

export async function executeAutoTick(userId: string): Promise<{ opened: number; closed: number; note: string }> {
  try {
    return await executeAutoTickBody(userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/auto_signals_one_open|unique/i.test(msg)) {
      try {
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        const [row] = await sql<{ last_tick_note: string | null }>`
          select last_tick_note from auto_settings where user_id = ${userId} limit 1
        `;
        const cleaned = String(row?.last_tick_note ?? "")
          .split("\n")
          .filter((ln) => !/white.?list|blocked this server|allow any IP/i.test(ln))
          .join("\n")
          .trim();
        if (cleaned !== (row?.last_tick_note ?? "")) {
          await sql`
            update auto_settings
            set last_tick_note = ${cleaned || "Hunting. Duplicate ticket skipped."},
                last_tick_at = now(),
                updated_at = now()
            where user_id = ${userId}
          `;
        }
      } catch {
        /* ignore */
      }
      return { opened: 0, closed: 0, note: "Skip duplicate ticket." };
    }
    const note = /is not a function|stats_from|not-null/i.test(msg)
      ? "Tick recovered. Hunting A+ only."
      : msg.slice(0, 180);
    try {
      const { getSql } = await import("@/lib/db");
      const sql = await getSql();
      await sql`
        update auto_settings
        set last_tick_at = now(), last_tick_note = ${note}, updated_at = now()
        where user_id = ${userId}
      `;
    } catch {
      /* ignore */
    }
    return { opened: 0, closed: 0, note };
  }
}

async function executeAutoTickBody(userId: string): Promise<{ opened: number; closed: number; note: string }> {
    const { getSql } = await import("@/lib/db");
    const {
      getWeexLast,
      loadTop25Hours,
      specFor,
      formatWeexPx,
      formatWeexQty,
      getBookTicker,
      getFundingRate,
      getWeexFourHour,
      getWeexKlines,
    } = await import("@/lib/weex-market.server");
    const { scanUniverse, shouldLockBreakeven, breakevenPrice, scoreToConf, taggedTake } = await import("@/lib/ta");
    const { sizeSetup } = await import("@/lib/risk");
    const { coinByWeex, CORE_SET, SKIP_WEEX, TOP25_WEEX } = await import("@/lib/universe");
    const rules = await import("@/lib/desk-rules");
    const sql = await getSql();
    await ensureSettings(sql, userId);
    try {
      await sql`
        update auto_settings
        set last_tick_at = now(), updated_at = now()
        where user_id = ${userId}
      `;
    } catch {
      /* ignore */
    }
    const [settings] = await sql<SettingsRow>`select * from auto_settings where user_id = ${userId}`;
    if (!settings) throw new Error("No auto desk");
    const pulled = await pullWeexBook(settings);
    const live = pulled.live;
    if (live) {
      settings.account_usd = live.equity;
      settings.peak_usd = Math.max(n(settings.peak_usd) || live.equity, live.equity);
    } else if (pulled.error) {
      /* shown in last tick note if we skip size */
    }
    let stats = await closedStats(sql, userId, settings.stats_from);
    const pub = publicSettings(settings, stats, live, pulled.error);
    const phase = livePhase(settings, stats);

    if (phase.id === "done") {
      await sql`
        update auto_settings
        set armed = false, last_tick_note = ${phase.note}, last_correction = ${phase.note}, updated_at = now()
        where user_id = ${userId}
      `;
      return { opened: 0, closed: 0, note: phase.note };
    }

    const notes: string[] = [];
    await collapseOpenDupes(sql, userId, settings, notes);
    await sql`
      update auto_signals
      set status = 'skipped',
          close_reason = ${"Ghost — never on WEEX"},
          pnl = 0,
          updated_at = now()
      where user_id = ${userId}
        and status in ('stopped','targeted','skipped')
        and (client_oid is null or filled_at is null)
        and coalesce(close_reason, '') not like 'Ghost%'
    `;
    await sql`
      update auto_signals
      set status = 'error',
          close_reason = ${"Stale claim — never sent"},
          updated_at = now()
      where user_id = ${userId}
        and status = 'proposed'
        and created_at < now() - interval '3 minutes'
    `;
    let weexBook: { symbol: string; qty: number; side?: string; pnl?: number | null }[] | null = null;
    let bookedFlat: number[] = [];
    let flattenedTick: string[] = [];
    let weexCloses: {
      symbol: string;
      side?: "long" | "short";
      pnl: number;
      closePx: number;
      entry?: number;
      ts: number;
      qty?: number;
    }[] = [];
    {
      const creds = await credsFrom(settings);
      if (creds) {
        const { listWeexPositions, listWeexClosedPnl } = await import("@/lib/weex.server");
        weexBook = await listWeexPositions(creds);
        weexCloses = await listWeexClosedPnl(creds).catch(() => []);
        await resurrectLive(sql, userId, weexBook, notes, creds);
        const flat = await closeFlatOnWeex(sql, userId, weexBook, notes, creds);
        bookedFlat = flat.booked;
        flattenedTick = flat.flattened;
        await restampWeexPnl(sql, userId, creds, notes, weexCloses);
        stats = await closedStats(sql, userId, settings.stats_from);
      }
    }

    const open = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId} and status in ('proposed','working','filled')
    `;

    let closed = 0;
    let opened = 0;
    let huntTape = "";
    let equity = pub.accountUsd;
    let streak = pub.lossStreak;
    let winStreak = n((settings as SettingsRow).win_streak) || 0;
    let peak = clampPeak(equity, pub.peakUsd);
    for (const pnl of bookedFlat) {
      closed += 1;
      streak = pnl >= 0 ? 0 : streak + 1;
      winStreak = pnl >= 0 ? winStreak + 1 : 0;
    }
    {
      const creds = await credsFrom(settings);
      if (creds) await trimToTwoPct(sql, userId, settings, weexBook, notes, creds, equity);
    }

    for (const pos of open) {
      const px = await getWeexLast(pos.weex_symbol);
      const side = pos.side === "short" ? "short" : "long";
      const keyPos = pos.weex_symbol.replace(/_/g, "").toUpperCase();
      const weexLive = (weexBook ?? []).find(
        (p) =>
          p.symbol.replace(/_/g, "").toUpperCase() === keyPos &&
          (p.side === "short" ? "short" : "long") === side &&
          p.qty > 0,
      );
      if (pos.status === "filled" && !weexLive) {
        const other = (weexBook ?? []).find(
          (p) => p.symbol.replace(/_/g, "").toUpperCase() === keyPos && p.qty > 0,
        );
        if (other) {
          await sql`
            update auto_signals
            set status = 'skipped', close_reason = ${"Ghost opposite side"}, pnl = 0, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          notes.push(`${pos.weex_symbol} ${side} ghost — WEEX is ${(other.side === "short" ? "short" : "long")}, skipped`);
          continue;
        }
      }
      const stop = n(pos.stop);
      const target = n(pos.target);
      const entry = n(pos.fill_px ?? pos.entry);
      const style = pos.style === "swing" ? "swing" : "scalp";
      const hitStop = side === "long" ? px <= stop : px >= stop;
      const hitTp = side === "long" ? px >= target : px <= target;

      if (pos.status === "working") {
        if (rules.shouldCancelStaleLimit(pos.created_at, style)) {
          const creds = await credsFrom(settings);
          if (creds && pos.client_oid) {
            const { cancelWeexOrder } = await import("@/lib/weex.server");
            await cancelWeexOrder(creds, { symbol: pos.weex_symbol, clientOid: pos.client_oid });
          }
          await sql`
            update auto_signals
            set status = 'skipped', closed_px = ${px}, pnl = 0, close_reason = ${"Limit never filled"}, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          notes.push(`${pos.weex_symbol} limit expired`);
          closed += 1;
          continue;
        }
        const credsFill = await credsFrom(settings);
        if (credsFill) {
          const { listWeexPositions } = await import("@/lib/weex.server");
          const bookNow = await listWeexPositions(credsFill);
          const liveFill = (bookNow ?? []).find(
            (p) =>
              p.symbol.replace(/_/g, "").toUpperCase() === pos.weex_symbol.replace(/_/g, "").toUpperCase() &&
              (p.side === "short" ? "short" : "long") === side &&
              p.qty > 0,
          );
          if (liveFill) {
            const e = n(pos.entry);
            const fillPx = liveFill.entry && liveFill.entry > 0 ? liveFill.entry : e;
            await sql`
              update auto_signals
              set status = 'filled', fill_px = ${fillPx}, qty = ${liveFill.qty}, filled_at = now(), updated_at = now()
              where id = ${pos.id} and user_id = ${userId}
            `;
            pos.status = "filled";
            pos.qty = liveFill.qty;
            pos.fill_px = fillPx;
            notes.push(`Filled ${pos.weex_symbol} limit`);
            await ensureTakes(pos, notes, credsFill);
          }
        }
        continue;
      }

      const credsTp = await credsFrom(settings);
      if (pos.status === "filled" && credsTp) await ensureTakes(pos, notes, credsTp);

      const tps = parseNums(pos.targets);
      const stopLooksBe = side === "long" ? stop >= entry * 0.9995 : stop <= entry * 1.0005;
      const beLocked = Boolean(pos.be_moved) && stopLooksBe;
      let mark = px;
      let reduced = false;
      if (pos.status === "filled" && !beLocked) {
        const credsForPos = await credsFrom(settings);
        if (credsForPos) {
          const { getWeexPositionQty } = await import("@/lib/weex.server");
          const left = await getWeexPositionQty(credsForPos, pos.weex_symbol);
          const orig = origQty(pos);
          if (left != null && orig > 0 && left < orig * 0.62) reduced = true;
        }
      }
      if (
        shouldLockBreakeven({
          side,
          entry,
          stop,
          last: mark,
          targets: tps,
          already: beLocked,
          reduced,
        })
      ) {
        const creds = await credsFrom(settings);
        const rawBe = await weexFeeBe(creds, pos.weex_symbol, side, entry);
        const be = feeBePx(side, entry, mark || px, rawBe);
        if (be > 0 && creds) {
          pos.stop = be;
          await ensureTakes(pos, notes, creds, be);
          await sql`
            update auto_signals
            set stop = ${be}, be_moved = true, tp1_hit = true, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          notes.push(`${pos.weex_symbol} TP1 filled · SL → WEEX BE ${be.toFixed(4)}`);
        }
      } else if (pos.be_moved) {
        if (reduced && !pos.tp1_hit) {
          await sql`update auto_signals set tp1_hit = true, updated_at = now() where id = ${pos.id} and user_id = ${userId}`;
        }
        const credsSweep = await credsFrom(settings);
        if (credsSweep) {
          const { cancelWeexStops } = await import("@/lib/weex.server");
          await cancelWeexStops(credsSweep, pos.weex_symbol, {
            side,
            mark: mark || px,
            keepPx: n(pos.stop),
          });
        }
        const hourly = await getWeexKlines(pos.weex_symbol, "1h", 40).catch(() => []);
        const fifteenTrail = await getWeexKlines(pos.weex_symbol, "15m", 48).catch(() => []);
        const next = rules.trailStop({ side, entry, stop, hourly, fifteen: fifteenTrail });
        if (next != null) {
          const creds = await credsFrom(settings);
          if (creds) {
            pos.stop = next;
            await ensureTakes(pos, notes, creds, next);
          }
          await sql`
            update auto_signals set stop = ${next}, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          notes.push(`${pos.weex_symbol} trail SL ${next.toFixed(4)}`);
        }
      }

      const since = pos.filled_at ?? pos.created_at;
      const credsNow = await credsFrom(settings);
      let left: number | null = null;
      if (credsNow) {
        const { getWeexPositionQty } = await import("@/lib/weex.server");
        left = await getWeexPositionQty(credsNow, pos.weex_symbol);
      }
      if (pos.status === "filled" && credsNow && left != null && left > 0 && !beLocked) {
        const unit = oneRUsd(pos);
        const lastPx = mark || px;
        const openPnl = side === "short" ? (entry - lastPx) * left : (lastPx - entry) * left;
        const pastStop =
          stop > 0 && (side === "short" ? lastPx >= stop * 0.997 : lastPx <= stop * 1.003);
        if ((unit > 0.05 && openPnl <= -1.25 * unit) || pastStop) {
          const spec = await specFor(coinByWeex(pos.weex_symbol));
          const { flattenWeex, cancelWeexProtective } = await import("@/lib/weex.server");
          await cancelWeexProtective(credsNow, pos.weex_symbol).catch(() => null);
          const sent = await flattenWeex(credsNow, {
            symbol: pos.weex_symbol,
            side: side === "short" ? "BUY" : "SELL",
            positionSide: side === "short" ? "SHORT" : "LONG",
            quantity: formatWeexQty(left, spec.quantityPrecision),
            clientOid: `velarisk${pos.id}${Date.now().toString(36)}`.slice(0, 36),
          });
          if (sent.ok) {
            notes.push(
              `${pos.weex_symbol} flattened — ${pastStop ? "stop missed on WEEX" : "past 1.25R"}`,
            );
            left = 0;
          }
        }
      }
      if (pos.status === "filled" && credsNow && left != null && left > 0) {
        const orig = origQty(pos);
        const dust = orig > 0 && left <= orig * 0.05;
        if (dust && !hitTp) {
          const spec = await specFor(coinByWeex(pos.weex_symbol));
          const { flattenWeex, cancelWeexProtective } = await import("@/lib/weex.server");
          await cancelWeexProtective(credsNow, pos.weex_symbol).catch(() => null);
          const sent = await flattenWeex(credsNow, {
            symbol: pos.weex_symbol,
            side: side === "short" ? "BUY" : "SELL",
            positionSide: side === "short" ? "SHORT" : "LONG",
            quantity: formatWeexQty(left, spec.quantityPrecision),
            clientOid: `veladust${pos.id}${Date.now().toString(36)}`.slice(0, 36),
          });
          if (sent.ok) {
            notes.push(`${pos.weex_symbol} flattened dust ${left} (SL/TP leftover)`);
            left = 0;
          }
        }
      }
      if (pos.status === "filled" && left === 0) {
        const hit = matchWeexClose(pos, weexCloses);
        const book = hit
          ? applyWeexHit(hit, pos)
          : { pnl: 0, px, why: "Closed on WEEX", st: "skipped" as const };
        await sql`
          update auto_signals
          set status = ${book.st}, closed_px = ${book.px || px}, pnl = ${book.pnl}, close_reason = ${book.why}, updated_at = now()
          where id = ${pos.id} and user_id = ${userId}
        `;
        if (Math.abs(book.pnl) >= 0.05) {
          streak = book.pnl >= 0 ? 0 : streak + 1;
          winStreak = book.pnl >= 0 ? winStreak + 1 : 0;
          closed += 1;
        }
        notes.push(`${pos.weex_symbol} ${book.why}${book.pnl ? ` ${book.pnl >= 0 ? "+" : ""}${book.pnl.toFixed(2)}` : ""}`);
        continue;
      }
      if (
        !hitStop &&
        !hitTp
      ) {
        const act = rules.chopAction({
          since,
          style,
          side,
          entry,
          last: px,
          stop,
          beMoved: Boolean(pos.be_moved),
        });
        if (act === "flatten") {
        if (credsNow && (left == null || left > 0)) {
          const spec = await specFor(coinByWeex(pos.weex_symbol));
          const { flattenWeex, cancelWeexProtective } = await import("@/lib/weex.server");
          await cancelWeexProtective(credsNow, pos.weex_symbol).catch(() => null);
          const qty = left != null && left > 0 ? left : n(pos.qty);
          const sent = await flattenWeex(credsNow, {
            symbol: pos.weex_symbol,
            side: side === "short" ? "BUY" : "SELL",
            positionSide: side === "short" ? "SHORT" : "LONG",
            quantity: formatWeexQty(qty, spec.quantityPrecision),
            clientOid: `velatm${pos.id}${Date.now().toString(36)}`.slice(0, 36),
          });
          if (!sent.ok) {
            notes.push(`${pos.weex_symbol} time-stop flatten failed: ${sent.error.slice(0, 80)}`);
            continue;
          }
          const { getWeexPositionQty } = await import("@/lib/weex.server");
          const still = await getWeexPositionQty(credsNow, pos.weex_symbol);
          if (still != null && still > 0) {
            notes.push(`${pos.weex_symbol} flatten said ok but WEEX still holds ${still} — not marking closed`);
            continue;
          }
        }
        if (!credsNow) {
          notes.push(`${pos.weex_symbol} time-stop skipped — no keys`);
          continue;
        }
        const pnl = side === "long" ? (px - entry) * n(pos.qty) : (entry - px) * n(pos.qty);
        const hours = style === "scalp" ? "5h" : "12h";
        const why =
          pnl < 0
            ? `Sold at a loss to move on — still red after ${hours}`
            : `Sold to move on — nowhere after ${hours}`;
        await sql`
          update auto_signals
          set status = 'skipped', closed_px = ${px}, pnl = ${pnl}, close_reason = ${why}, updated_at = now()
          where id = ${pos.id} and user_id = ${userId}
        `;
        streak = pnl >= 0 ? 0 : streak + 1;
        winStreak = pnl >= 0 ? winStreak + 1 : 0;
        closed += 1;
        notes.push(`${pos.weex_symbol} ${why}`);
        continue;
        }
      }

      if (hitStop || hitTp) {
        const orig = origQty(pos);
        const dust = left != null && left > 0 && orig > 0 && left <= orig * 0.05;
        if (credsNow && left != null && left > 0 && (hitStop || hitTp || dust)) {
          const spec = await specFor(coinByWeex(pos.weex_symbol));
          const { flattenWeex, cancelWeexProtective } = await import("@/lib/weex.server");
          await cancelWeexProtective(credsNow, pos.weex_symbol).catch(() => null);
          const sent = await flattenWeex(credsNow, {
            symbol: pos.weex_symbol,
            side: side === "short" ? "BUY" : "SELL",
            positionSide: side === "short" ? "SHORT" : "LONG",
            quantity: formatWeexQty(left, spec.quantityPrecision),
            clientOid: `veladust${pos.id}${Date.now().toString(36)}`.slice(0, 36),
          });
          if (!sent.ok) {
            notes.push(`${pos.weex_symbol} leftover ${left} still live after ${hitStop ? "SL" : "TP"} — flatten failed: ${sent.error.slice(0, 80)}`);
            continue;
          }
          const still = await (await import("@/lib/weex.server")).getWeexPositionQty(credsNow, pos.weex_symbol);
          if (still != null && still > 0) {
            notes.push(`${pos.weex_symbol} still holds ${still} after flatten — keeping live`);
            continue;
          }
          notes.push(`${pos.weex_symbol} flattened leftover ${left} after ${hitStop ? "SL" : "final TP"}`);
          left = 0;
        }
        if (left != null && left > 0) {
          notes.push(
            `${pos.weex_symbol} last tagged ${hitStop ? "SL" : "TP"} but WEEX still holds ${left}`,
          );
          continue;
        }
        const hit = matchWeexClose(pos, weexCloses);
        const book = hit
          ? applyWeexHit(hit, pos)
          : {
              pnl: 0,
              px: hitStop ? stop : target,
              why: hitStop ? "Hit stop" : "Closed on WEEX",
              st: (hitStop ? "stopped" : "skipped") as "stopped" | "skipped",
            };
        await sql`
          update auto_signals
          set status = ${book.st},
              closed_px = ${book.px || (hitStop ? stop : target)}, pnl = ${book.pnl}, close_reason = ${book.why}, updated_at = now()
          where id = ${pos.id} and user_id = ${userId}
        `;
        if (Math.abs(book.pnl) >= 0.05) {
          streak = book.pnl >= 0 ? 0 : streak + 1;
          winStreak = book.pnl >= 0 ? winStreak + 1 : 0;
          closed += 1;
        }
        notes.push(`${pos.weex_symbol} ${book.why}${book.pnl ? ` ${book.pnl.toFixed(2)}` : ""}`);
      }
    }

    const credsLive = await credsFrom(settings);
    if (credsLive) {
      const { listWeexPositions } = await import("@/lib/weex.server");
      const livePos = await listWeexPositions(credsLive);
      for (const lp of livePos ?? []) {
        const [row] = await sql<SignalRow>`
          select * from auto_signals
          where user_id = ${userId} and weex_symbol = ${lp.symbol}
          order by created_at desc
          limit 1
        `;
        if (!row) continue;
        if (row.status === "filled" || row.status === "working" || row.status === "proposed") {
          if (lp.qty > 0 && n(row.qty) > 0 && lp.qty < n(row.qty) * 0.98) {
            /* leftover after TP1 — keep original qty so PnL still credits the take */
          }
          continue;
        }
        const fill = n(row.fill_px) || lp.entry || n(row.entry);
        await sql`
          update auto_signals
          set status = 'filled',
              qty = ${lp.qty},
              fill_px = ${fill},
              closed_px = null,
              pnl = null,
              filled_at = ${row.filled_at ?? new Date().toISOString()},
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(`Reopened ${lp.symbol} — still live on WEEX`);
        const [liveRow] = await sql<SignalRow>`select * from auto_signals where id = ${row.id} limit 1`;
        if (liveRow) await ensureTakes(liveRow, notes, credsLive);
      }

      const ghosts = await sql<SignalRow>`
        select * from auto_signals
        where user_id = ${userId}
          and close_reason = 'Closed on WEEX'
          and updated_at > now() - interval '6 hours'
      `;
      const { getWeexPositionQty } = await import("@/lib/weex.server");
      for (const row of ghosts) {
        if (row.status === "filled" || row.status === "working") continue;
        const q = await getWeexPositionQty(credsLive, row.weex_symbol);
        if (q == null || q <= 0) continue;
        const fill = n(row.fill_px) || n(row.entry);
        await sql`
          update auto_signals
          set status = 'filled',
              qty = ${q},
              fill_px = ${fill},
              closed_px = null,
              pnl = null,
              close_reason = null,
              filled_at = ${row.filled_at ?? new Date().toISOString()},
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(`Reopened ${row.weex_symbol} — still live on WEEX`);
      }
    }

    const refreshed = await pullWeexBook(settings);
    if (refreshed.live) {
      equity = refreshed.live.equity;
      peak = clampPeak(equity, Math.max(peak, equity));
    } else {
      equity = Math.max(0.01, equity);
      peak = clampPeak(equity, Math.max(peak, equity));
      if (refreshed.error) notes.push(refreshed.error);
    }
    const afterStats = { closed: stats.closed + closed, wins: stats.wins };
    const corrected = adaptMethod({
      phase: phaseForRun(equity, Boolean(settings.continue_to_goal)),
      lossStreak: streak,
      winStreak,
      lastMargin: n(settings.risk_pct) || 2,
      drawdownPct: peak > 0 ? ((clampPeak(equity, peak) - equity) / clampPeak(equity, peak)) * 100 : 0,
      closed: afterStats.closed,
      wins: stats.wins,
    });

    const flattened = new Set(flattenedTick);
    for (const row of await sql<{ weex_symbol: string }>`
      select distinct weex_symbol from auto_signals
      where user_id = ${userId}
        and close_reason in ('Closed on WEEX', 'Closed in green')
        and filled_at is not null
        and abs(coalesce(pnl, 0)) > 0.4
        and updated_at > now() - interval '2 hours'
    `) {
      flattened.add(row.weex_symbol);
    }

    const stillOpenRaw = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId} and status in ('proposed','working','filled')
    `;
    const onWeex = (sym: string) => {
      const key = sym.replace(/_/g, "").toUpperCase();
      return (weexBook ?? []).some(
        (p) =>
          p.qty > 0 &&
          (p.symbol === sym || p.symbol.replace(/_/g, "").toUpperCase() === key),
      );
    };
    const stillOpen = stillOpenRaw.filter((s) => {
      if (flattened.has(s.weex_symbol)) return false;
      if (s.status === "working" || s.status === "proposed") return true;
      return onWeex(s.weex_symbol);
    });
    const atRisk = stillOpen.filter(
      (s) => s.status === "working" || (s.status === "filled" && !s.be_moved),
    );
    const LIVE_CAP = 3;
    const AT_RISK = 2;
    const ledger = await ticketLedger(sql, userId, settings.stats_from);
    const bar = { minConf: 85, note: "A++ per coin · 85%+ structure or continuation. 4h + 15m." };

    const liveN = (weexBook ?? []).filter((p) => p.qty > 0);
    const beFree = new Set<string>();
    for (const p of liveN) {
      const k = p.symbol.replace(/_/g, "").toUpperCase();
      const row = stillOpen.find(
        (s) =>
          s.status === "filled" &&
          s.weex_symbol.replace(/_/g, "").toUpperCase() === k &&
          Boolean(s.be_moved) &&
          Boolean(s.tp1_hit),
      );
      if (row) beFree.add(k);
    }
    let hiddenLive = 0;
    if (liveN.length === 0 && flattened.size) {
      const credsGate = await credsFrom(settings);
      if (credsGate) {
        const { getWeexPositionQty } = await import("@/lib/weex.server");
        for (const sym of flattened) {
          const q = await getWeexPositionQty(credsGate, sym);
          if (q != null && q > 0) hiddenLive += 1;
        }
      }
    }
    const dbFilled = stillOpenRaw.filter(
      (s) => s.status === "filled" && !(s.be_moved && s.tp1_hit) && !flattened.has(s.weex_symbol),
    );
    const countAtRisk = (side: "long" | "short") => {
      const syms = new Set<string>();
      for (const p of liveN) {
        if ((p.side === "short" ? "short" : "long") !== side) continue;
        const k = p.symbol.replace(/_/g, "").toUpperCase();
        if (beFree.has(k)) continue;
        syms.add(k);
      }
      return syms.size;
    };
    let riskL = countAtRisk("long");
    let riskS = countAtRisk("short");
    const atRiskN = riskL + riskS;
    const beNLive = liveN.filter((p) => beFree.has(p.symbol.replace(/_/g, "").toUpperCase())).length;
    const blocked = liveN.length >= LIVE_CAP || (liveN.length > 0 && atRiskN >= AT_RISK);
    const roomN = blocked ? 0 : 1;
    const huntStatus = !settings.armed
      ? "Disarmed. Not hunting."
      : huntHeader(riskL, riskS, beNLive, liveN.length);
    notes.push(
      `WEEX ${riskL}L/${riskS}S: ${
        liveN.length
          ? liveN
              .map((p) => `${p.symbol.replace(/_/g, "").toUpperCase()} ${(p.side === "short" ? "short" : "long")}${beFree.has(p.symbol.replace(/_/g, "").toUpperCase()) ? " BE" : ""}`)
              .join(", ")
          : "flat"
      }.`,
    );
    const whyLive = stillOpen
      .filter((s) => s.status === "filled" || s.status === "working")
      .map((s) =>
        rules.whyTookTrade({
          symbol: s.weex_symbol,
          side: s.side === "short" ? "short" : "long",
          conf: Math.round(n(s.confidence)),
          thesis: s.thesis ?? "",
          bias: "chop",
          live: true,
          working: s.status === "working",
        }),
      );
    const credsGate2 = await credsFrom(settings);
    let parked: SignalRow | null = null;
    if (credsGate2) {
      const filledSym = new Set(
        liveN
          .filter((p) => !beFree.has(p.symbol.replace(/_/g, "").toUpperCase()))
          .map((p) => p.symbol.replace(/_/g, "").toUpperCase()),
      );
      for (const s of dbFilled) filledSym.add(s.weex_symbol.replace(/_/g, "").toUpperCase());
      const extras = stillOpenRaw.filter((s) => {
        if (s.status !== "working" && s.status !== "proposed") return false;
        const sym = s.weex_symbol.replace(/_/g, "").toUpperCase();
        if (SKIP_WEEX.has(sym) || !TOP25_WEEX.includes(sym)) return true;
        if (filledSym.has(sym)) return true;
        return false;
      });
      const { cancelWeexOrder, cancelWeexProtective, flattenWeex } = await import("@/lib/weex.server");
      for (const row of extras) {
        const sym = row.weex_symbol.replace(/_/g, "").toUpperCase();
        const ban = SKIP_WEEX.has(sym) || !TOP25_WEEX.includes(sym);
        const why = ban ? "Cancelled — off the book (no history)" : "Cancelled — duplicate or at-risk full";
        if (row.client_oid) {
          await cancelWeexOrder(credsGate2, { symbol: row.weex_symbol, clientOid: row.client_oid }).catch(() => null);
        }
        await cancelWeexProtective(credsGate2, row.weex_symbol).catch(() => null);
        await sql`
          update auto_signals
          set status = 'skipped',
              close_reason = ${why},
              pnl = 0,
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(ban ? `${row.weex_symbol} cancelled — off the book` : `${row.weex_symbol} limit cancelled — duplicate or 2 at-risk`);
      }
      for (const row of stillOpenRaw) {
        const sym = row.weex_symbol.replace(/_/g, "").toUpperCase();
        if (!SKIP_WEEX.has(sym) || row.status !== "filled") continue;
        const pos = liveN.find((p) => p.symbol.replace(/_/g, "").toUpperCase() === sym);
        const qty = pos?.qty || n(row.qty);
        if (qty > 0) {
          const specs = await (await import("@/lib/weex-market.server")).getWeexSpecs();
          const spec = specs.get(sym);
          await flattenWeex(credsGate2, {
            symbol: row.weex_symbol,
            side: row.side === "short" ? "BUY" : "SELL",
            positionSide: row.side === "short" ? "SHORT" : "LONG",
            quantity: formatWeexQty(qty, spec?.quantityPrecision ?? 3),
            clientOid: `velaban${Date.now().toString(36)}`.slice(0, 36),
          }).catch(() => null);
        }
        await cancelWeexProtective(credsGate2, row.weex_symbol).catch(() => null);
        await sql`
          update auto_signals
          set status = 'skipped',
              close_reason = ${"Flattened — off the book (no history)"},
              pnl = ${n(row.pnl)},
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(`${row.weex_symbol} flattened — off the book`);
      }
      const leftoverWorking = stillOpenRaw.filter(
        (s) =>
          (s.status === "working" || s.status === "proposed") &&
          !extras.some((e) => e.id === s.id),
      );
      leftoverWorking.sort((a, b) => n(b.confidence) - n(a.confidence));
      const keyOf = (sym: string) => sym.replace(/_/g, "").toUpperCase();
      let slotN = liveN.filter((p) => !beFree.has(keyOf(p.symbol))).length;
      parked = null;
      for (const row of leftoverWorking) {
        if (slotN >= AT_RISK) {
          if (row.client_oid) {
            await cancelWeexOrder(credsGate2, { symbol: row.weex_symbol, clientOid: row.client_oid }).catch(() => null);
          }
          await cancelWeexProtective(credsGate2, row.weex_symbol).catch(() => null);
          await sql`
            update auto_signals
            set status = 'skipped',
                close_reason = ${"Cancelled — 2 at-risk already"},
                pnl = 0,
                updated_at = now()
            where id = ${row.id} and user_id = ${userId}
          `;
          notes.push(`${row.weex_symbol} limit cancelled — 2 at-risk already`);
          continue;
        }
        slotN += 1;
        if (!parked) parked = row;
      }
      if (parked) {
        const stale = await sql<{ client_oid: string | null; weex_symbol: string }>`
          select client_oid, weex_symbol from auto_signals
          where user_id = ${userId}
            and weex_symbol = ${parked.weex_symbol}
            and status = 'skipped'
            and client_oid is not null
            and client_oid <> ${parked.client_oid ?? ""}
            and close_reason like ${"Replaced by%"}
            and updated_at > now() - interval '3 days'
        `;
        for (const row of stale) {
          if (!row.client_oid) continue;
          await cancelWeexOrder(credsGate2, { symbol: row.weex_symbol, clientOid: row.client_oid }).catch(() => null);
        }
      }
    }

    if (blocked) {
      const names = [
        ...liveN.map((p) => p.symbol.replace(/_/g, "").toUpperCase()),
        ...dbFilled.map((s) => s.weex_symbol),
      ];
      huntTape = [huntStatus, ...whyLive].filter(Boolean).join("\n");
      notes.push(
        `${[...new Set(names)].join(" ")} · ${atRiskN} at-risk, ${beNLive} BE · cap 3.`,
      );
    } else if (settings.armed && liveN.length < LIVE_CAP) {
      if (!(settings.api_key_enc && settings.api_secret_enc && settings.api_pass_enc)) {
        notes.push("Armed with no keys. Store keys on this page.");
      } else if (!live) {
        notes.push(pulled.error ?? "WEEX equity not readable. No new orders.");
      } else {
        const books = await loadTop25Hours();
        const btcBook = books.BTCUSDT ?? [];
        const regime = rules.regimeState(btcBook);
        if (regime.hot) {
          huntTape = `${huntStatus}\nStood down — BTC shock wick (ATR ${regime.ratio.toFixed(1)}×). Slots stay empty.`;
          notes.push(`Regime: BTC shock wick (ATR ${regime.ratio.toFixed(1)}×). Standing down.`);
        } else {
          const rawAll = rules.applyLedger(
            scanUniverse(books, corrected.style, corrected.minRr, "vela"),
            ledger,
          );
          const raw = corrected.id === "grow"
            ? rawAll.filter((s) => CORE_SET.has(s.weexSymbol))
            : rawAll;
          const busy = new Set(
            stillOpen.filter((s) => s.status === "filled").map((s) => s.weex_symbol),
          );

          const batch: {
            sized: NonNullable<ReturnType<typeof sizeSetup>>;
            spec: Awaited<ReturnType<typeof specFor>>;
          }[] = [];
          let room = roomN;
          const [burst] = await sql<{ n: number }>`
            select count(*)::int as n from auto_signals
            where user_id = ${userId}
              and created_at > now() - interval '4 minutes'
              and status = 'filled'
          `;
          if ((burst?.n ?? 0) >= 1 && liveN.length > 0 && beNLive < 1) room = 0;
          let openLimits = stillOpenRaw.filter(
            (s) => s.status === "working" || s.status === "proposed",
          ).length;
          const btcLast = btcBook[btcBook.length - 1]?.close;
          const btcCloses = btcBook.map((c) => c.close);
          let btcRsi = 0;
          if (btcCloses.length > 15) {
            let gain = 0;
            let loss = 0;
            for (let i = btcCloses.length - 14; i < btcCloses.length; i += 1) {
              const d = btcCloses[i]! - btcCloses[i - 1]!;
              if (d >= 0) gain += d;
              else loss -= d;
            }
            btcRsi = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
          }
          const btc15 = await getWeexKlines("BTCUSDT", "15m", 48).catch(() => []);
          const btc4 = await getWeexFourHour("BTCUSDT").catch(() => []);
          const tape = rules.marketBias(btc4, btcBook, btc15);
          const compass = {
            bias: "chop" as const,
            note: `Per coin. 4h + 15m. BTC ${tape.bias} is info only — not a compass.`,
          };
          const ordered = [...raw].sort((a, b) => {
            const aA = rules.eliteScalp(a.thesis ?? "", a.confidence ?? scoreToConf(a.score), bar.minConf, compass.bias) ? 1 : 0;
            const bA = rules.eliteScalp(b.thesis ?? "", b.confidence ?? scoreToConf(b.score), bar.minConf, compass.bias) ? 1 : 0;
            if (aA !== bA) return bA - aA;
            const q = rules.setupQuality(b.thesis ?? "") - rules.setupQuality(a.thesis ?? "");
            if (q) return q;
            return (b.confidence ?? b.score) - (a.confidence ?? a.score);
          });
          const held = new Set([
            ...busy,
            ...stillOpen.map((s) => s.weex_symbol),
          ]);
          const recentLoss = await sql<{ weex_symbol: string }>`
            select distinct weex_symbol from auto_signals
            where user_id = ${userId}
              and status in ('stopped','skipped')
              and coalesce(pnl, 0) < 0
              and updated_at > now() - interval '6 hours'
          `;
          const dark = new Set(recentLoss.map((r) => r.weex_symbol));
          const whyNot: string[] = [];
          const pool: typeof ordered = [];
          const seen = new Set<string>();
          for (const s of ordered) {
            if (pool.length >= 4) break;
            const conf = s.confidence ?? scoreToConf(s.score);
            if (!rules.eliteScalp(s.thesis ?? "", conf, bar.minConf, compass.bias)) continue;
            if (held.has(s.weexSymbol) || dark.has(s.weexSymbol)) continue;
            if (SKIP_WEEX.has(s.weexSymbol) || !TOP25_WEEX.includes(s.weexSymbol)) continue;
            if (compass.bias !== "chop" && s.side !== compass.bias) continue;
            const key = `${s.weexSymbol}:${s.side}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const tag = `${s.weexSymbol.replace("USDT", "")} ${s.side} ${Math.round(conf)}%`;
            const h4 = await getWeexFourHour(s.weexSymbol).catch(() => []);
            if (!rules.htfAllows(s.side, h4)) {
              whyNot.push(`${tag} 4h reject`);
              continue;
            }
            if (rules.setupQuality(s.thesis ?? "") === 0) {
              const hour = books[s.weexSymbol] ?? [];
              if (!rules.rsiDivergence(hour, s.side)) {
                whyNot.push(`${tag} RSI-knife, no divergence`);
                continue;
              }
            }
            pool.push(s);
          }
          const primes = pool.filter((s) => rules.setupQuality(s.thesis ?? "") >= 2);
          const eyeing = (primes.length ? primes : pool.slice(0, 1)).slice(0, 2).map((s) => {
            const kind = rules.aPlusKind(s.thesis ?? "") ?? "";
            return `${s.weexSymbol.replace("USDT", "")} ${s.side} ${Math.round(s.confidence ?? s.score)}%${kind ? ` ${kind}` : ""}`;
          });
          const withTape = raw.filter((s) => compass.bias === "chop" || s.side === compass.bias);
          const eyeLine = eyeing.length
            ? `Eying  ${eyeing.join(" · ")}`
            : `Eying no A++ through 4h. Scanned ${withTape.length}. Seat ${atRiskN}/${AT_RISK} open.`;
          const aPlusLine = "One best A++. 4h must agree. RSI-knife needs divergence.";
          let veto = whyNot[0] ?? "No A++ this pass. Slots stay empty.";

          for (const pick of pool) {
            const tag = `${pick.weexSymbol.replace("USDT", "")} ${pick.side} ${Math.round(pick.confidence ?? pick.score)}%`;
            const confNow = pick.confidence ?? scoreToConf(pick.score);
            const aPlus = rules.eliteScalp(pick.thesis ?? "", confNow, bar.minConf, compass.bias);
            if (!aPlus) {
              whyNot.push(`${tag} not an A++ scalp — slot stays empty`);
              continue;
            }
            if (SKIP_WEEX.has(pick.weexSymbol) || !TOP25_WEEX.includes(pick.weexSymbol)) continue;
            if (flattened.has(pick.weexSymbol)) {
              whyNot.push(`${tag} just flattened — pause this pair`);
              continue;
            }
            if (busy.has(pick.weexSymbol)) continue;
            if (stillOpen.some((s) => s.weex_symbol === pick.weexSymbol)) continue;
            if (
              (weexBook ?? []).some(
                (p) =>
                  p.qty > 0 &&
                  p.symbol.replace(/_/g, "").toUpperCase() === pick.weexSymbol.replace(/_/g, "").toUpperCase() &&
                  (p.side === "short" ? "short" : "long") === pick.side,
              )
            ) {
              whyNot.push(`${tag} already live on WEEX`);
              continue;
            }
            if (room <= 0) {
              whyNot.push(`${tag} book full`);
              continue;
            }
            if (batch.some((b) => b.sized.weexSymbol === pick.weexSymbol)) continue;
            const coin15 = await getWeexKlines(pick.weexSymbol, "15m", 48).catch(() => []);
            const h4 = await getWeexFourHour(pick.weexSymbol).catch(() => []);
            const withBtc = compass.bias === "chop" || pick.side === compass.bias;
            if (!withBtc) {
              veto = `${pick.weexSymbol} ${pick.side} vs BTC ${compass.bias} — with-tape only`;
              whyNot.push(`${tag} vs BTC ${compass.bias} — no dip-buy / fade`);
              continue;
            }
            if (!rules.htfAllows(pick.side, h4)) {
              veto = `${pick.weexSymbol} ${pick.side} 4h reject`;
              whyNot.push(`${tag} 4h reject`);
              continue;
            }
            if (rules.setupQuality(pick.thesis ?? "") === 0) {
              const hour = books[pick.weexSymbol] ?? [];
              if (!rules.rsiDivergence(hour, pick.side)) {
                whyNot.push(`${tag} RSI-knife, no divergence`);
                continue;
              }
            }
            const trig = rules.ltfTrigger(pick.side, coin15);
            if (compass.bias === "chop") {
              if (!trig.ok && !trig.wait) {
                veto = `${pick.weexSymbol} ${pick.side}: ${trig.reason}`;
                whyNot.push(`${tag} ${trig.reason}`);
                continue;
              }
            } else if (!rules.ltfAllows(pick.side, coin15)) {
              veto = `${pick.weexSymbol} ${pick.side} 15m fighting BTC ${compass.bias}`;
              whyNot.push(`${tag} 15m fighting`);
              continue;
            }
            const book = await getBookTicker(pick.weexSymbol);
            if (book && rules.spreadTooWide(pick.weexSymbol, book.bid, book.ask)) {
              veto = `Wide book ${pick.weexSymbol}`;
              whyNot.push(`${tag} wide book`);
              continue;
            }
            const fund = await getFundingRate(pick.weexSymbol);
            if (fund != null && rules.fundingBlocks(pick.side, fund)) {
              veto = `Crowded funding ${pick.weexSymbol}`;
              whyNot.push(`${tag} crowded funding`);
              continue;
            }
            const spec = await specFor(coinByWeex(pick.weexSymbol));
            const conf = pick.confidence ?? scoreToConf(pick.score);
            if (conf < bar.minConf) {
              veto = `${pick.weexSymbol} ${pick.side} conf ${conf}% below ${bar.minConf}% bar`;
              whyNot.push(`${tag} below ${bar.minConf}%`);
              continue;
            }
            const [already] = await sql<{ id: number }>`
              select id from auto_signals
              where user_id = ${userId}
                and weex_symbol = ${pick.weexSymbol}
                and side = ${pick.side}
                and status in ('proposed','working','filled')
              limit 1
            `;
            if (already) continue;
            const [pairLoss] = await sql<{ id: number }>`
              select id from auto_signals
              where user_id = ${userId}
                and weex_symbol = ${pick.weexSymbol}
                and status in ('stopped','skipped')
                and coalesce(pnl, 0) < 0
                and updated_at > now() - interval '6 hours'
              limit 1
            `;
            if (pairLoss) {
              whyNot.push(`${tag} same pair lost in 6h — skip`);
              continue;
            }
            if (parked && parked.weex_symbol === pick.weexSymbol && parked.side === pick.side) {
              whyNot.push(`${tag} already parked — leave the limit`);
              continue;
            }
            const timed0 =
              compass.bias === "chop" ? rules.withLtfEntry(pick, trig.pullback) : pick;
            const timed =
              compass.bias === "chop" && trig.wait
                ? { ...timed0, entryType: "limit" as const }
                : timed0;
            const sz = sizeSetup(timed, equity, corrected.marginPct, spec.maxLeverage);
            if (!sz) continue;
            if (sz.entryType === "limit" && openLimits >= 1) {
              whyNot.push(`${tag} one unfilled limit already — need a market A+ for another slot`);
              continue;
            }
            batch.push({ sized: sz, spec });
            if (sz.entryType === "limit") openLimits += 1;
            room -= 1;
            break;
          }

          let tookLine = veto;
          if (!batch.length && (burst?.n ?? 0) >= 1) {
            tookLine = "One A++ per tick — just placed. Empty slots stay empty.";
          }

          if (!batch.length) {
            notes.push(veto);
          } else {
            const tookLines: string[] = [];
            for (const item of batch) {
              const sized = item.sized;
              const spec = item.spec;
              if (parked && parked.weex_symbol === sized.weexSymbol && parked.side === sized.side) {
                notes.push(`Keep parked ${parked.weex_symbol} limit — not re-placing the same pair.`);
                tookLines.push(`Limit still working ${parked.weex_symbol} ${parked.side} — not a fill yet.`);
                continue;
              }
            const [taken] = await sql<{ id: number }>`
              select id from auto_signals
              where user_id = ${userId}
                and weex_symbol = ${sized.weexSymbol}
                and side = ${sized.side}
                and status in ('proposed','working','filled')
              limit 1
            `;
            if (taken) {
              notes.push(`Skip ${sized.weexSymbol} — already one ticket`);
              tookLines.push(`Skip ${sized.weexSymbol.replace("USDT", "")} — already a ticket.`);
            } else {
            const { placeWeexOrder, setCrossMaxLeverage } = await import("@/lib/weex.server");
            const creds = (await credsFrom(settings))!;
            let ticketId: number | null = null;
            try {
              const [claim] = await sql<{ id: number }>`
                insert into auto_signals (
                  user_id, symbol, weex_symbol, side, style, entry_type, entry, stop, target,
                  qty, leverage, risk_usd, notional, rr, thesis, invalidation, status, venue,
                  client_oid, targets, scale, plan, score, confidence
                ) values (
                  ${userId}, ${sized.symbol}, ${sized.weexSymbol}, ${sized.side}, ${sized.style},
                  ${sized.entryType}, ${sized.entry}, ${sized.stop}, ${sized.target}, ${sized.qty},
                  ${Math.round(sized.leverage)}, ${sized.riskUsd}, ${sized.notional}, ${sized.rr},
                  ${sized.thesis}, ${sized.invalidation}, ${"proposed"}, 'weex',
                  ${`vela${Date.now().toString(36)}`.slice(0, 36)},
                  ${JSON.stringify(sized.targets.length ? sized.targets : [sized.target])},
                  ${JSON.stringify(sized.scale)}, ${sized.plan}, ${sized.score}, ${sized.confidence}
                ) returning id
              `;
              ticketId = claim?.id ?? null;
            } catch {
              notes.push(`Skip ${sized.weexSymbol} — already one ticket`);
              tookLines.push(`Skip ${sized.weexSymbol.replace("USDT", "")} — already a ticket.`);
            }
            if (!ticketId) {
              /* unique lost the race */
            } else {
            await setCrossMaxLeverage(creds, sized.weexSymbol, sized.leverage);

            const fullQty = formatWeexQty(sized.qty, spec.quantityPrecision);
            const oid = `vela${Date.now().toString(36)}`.slice(0, 36);
            const sent = await placeWeexOrder(creds, false, {
              symbol: sized.weexSymbol,
              side: sized.side === "long" ? "BUY" : "SELL",
              positionSide: sized.side === "long" ? "LONG" : "SHORT",
              type: sized.entryType === "market" ? "MARKET" : "LIMIT",
              quantity: fullQty,
              price: formatWeexPx(sized.entry, spec.pricePrecision),
              clientOid: oid,
            });
            const replies = [sent.ok ? JSON.stringify(sent.data).slice(0, 180) : sent.error.slice(0, 180)];

            const weexResp = replies.join(" | ").slice(0, 500);
            const status = sent.ok ? (sized.entryType === "market" ? "filled" : "working") : "error";
            const fillPx = status === "filled" ? sized.entry : null;
            if (!sent.ok) {
              notes.push(`WEEX reject ${sized.weexSymbol}: ${replies[0]?.slice(0, 80) ?? "empty"}`);
              tookLines.push(`WEEX rejected ${sized.weexSymbol.replace("USDT", "")} ${sized.side} ${Math.round(sized.confidence)}% — ${(replies[0] ?? "empty").slice(0, 90)}`);
            } else {
              notes.push(
                `${corrected.name} ${sized.leverage}x ${sized.side} ${sized.weexSymbol} · ${sized.rr.toFixed(1)}R · conf ${sized.confidence}% · $${sized.marginUsd.toFixed(2)}`,
              );
              tookLines.push(rules.whyTookTrade({
                symbol: sized.weexSymbol,
                side: sized.side,
                conf: Math.round(sized.confidence),
                thesis: sized.thesis ?? "",
                bias: compass.bias,
              }));
            }

            const filledAt = status === "filled" ? new Date().toISOString() : null;
            await sql`
              update auto_signals
              set status = ${status},
                  client_oid = ${oid},
                  weex_resp = ${weexResp},
                  fill_px = ${fillPx},
                  filled_at = ${filledAt},
                  updated_at = now()
              where id = ${ticketId} and user_id = ${userId}
            `;
            if (status === "filled") {
              const [row] = await sql<SignalRow>`select * from auto_signals where id = ${ticketId} limit 1`;
              if (row) await ensureTakes(row, notes, creds);
            }
            if (status !== "error") {
              opened += 1;
              if (sized.side === "long") riskL += 1;
              else riskS += 1;
            }
            }
            }
            }
            if (tookLines.length) tookLine = tookLines.join("\n");
          }
          const at2 = riskL + riskS;
          const be2 = liveN.filter((p) => beFree.has(p.symbol.replace(/_/g, "").toUpperCase())).length;
          const huntNow = huntHeader(riskL, riskS, be2, liveN.length + opened);
          huntTape = [huntNow, compass.note, ...whyLive, tookLine, whyNot.length ? `Skip  ${whyNot.slice(0, 3).join(" · ")}` : "", eyeLine, aPlusLine].filter(Boolean).join("\n");
        }
      }
    } else if (!settings.armed) {
      huntTape = huntStatus;
      notes.push("Disarmed. No new orders.");
    } else if (stillOpen.length >= LIVE_CAP) {
      huntTape = `${huntStatus}\nLive cap (3 names). Waiting on an exit.`;
      notes.push("Live cap (3 names). Waiting on an exit.");
    } else {
      huntTape = huntTape || huntStatus;
    }

    const learned =
      stats.wins >= 8
        ? "A++ only · with BTC · 85%+ or continuation · 70/30 runner back after 8 wins."
        : `A++ only · with BTC · 85%+ or continuation · full size at 1 TP (${stats.wins}/8 wins to restore runner).`;
    const manage = notes
      .filter((n) => /TP1 printed|Took |swept to 1 SL|working limit filled/i.test(n))
      .filter((n) => !/restated|WEEX PnL|Closed in green|Closed on WEEX/i.test(n))
      .slice(0, 4);
    const note = [huntTape, ...manage].filter(Boolean).join("\n") || notes.filter(Boolean).slice(0, 5).join(" · ");
    await sql`
      update auto_settings
      set last_tick_at = now(),
          last_tick_note = ${note},
          last_correction = ${learned},
          account_usd = ${equity},
          peak_usd = ${peak},
          loss_streak = ${streak},
          win_streak = ${winStreak},
          risk_pct = ${corrected.marginPct},
          min_rr = ${corrected.minRr},
          max_open = ${corrected.maxOpen},
          goal_usd = ${GOAL_USD},
          updated_at = now()
      where user_id = ${userId}
    `;

    return { opened, closed, note };
}

export const runAutoTick = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { ensureAutoLoop } = await import("@/lib/auto-loop.server");
    ensureAutoLoop();
    return executeAutoTick(context.userId);
  });

export const flattenSignal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: number }) => input)
  .handler(async ({ context, data }) => {
    const { getSql } = await import("@/lib/db");
    const { getWeexLast, specFor, formatWeexQty } = await import("@/lib/weex-market.server");
    const { coinByWeex } = await import("@/lib/universe");
    const sql = await getSql();
    const [row] = await sql<SignalRow>`
      select * from auto_signals where id = ${data.id} and user_id = ${context.userId}
    `;
    if (!row) throw new Error("Ticket not found");
    if (!OPEN.has(row.status)) throw new Error("Already flat");
    const [settings] = await sql<SettingsRow>`select * from auto_settings where user_id = ${context.userId}`;
    if (settings?.api_key_enc && settings.api_secret_enc && settings.api_pass_enc) {
      const { openSeal, flattenWeex } = await import("@/lib/weex.server");
      const spec = await specFor(coinByWeex(row.weex_symbol));
      const creds = {
        apiKey: openSeal(settings.api_key_enc),
        apiSecret: openSeal(settings.api_secret_enc),
        passphrase: openSeal(settings.api_pass_enc),
      };
      await flattenWeex(creds, {
        symbol: row.weex_symbol,
        side: row.side === "short" ? "BUY" : "SELL",
        positionSide: row.side === "short" ? "SHORT" : "LONG",
        quantity: formatWeexQty(n(row.qty), spec.quantityPrecision),
        clientOid: `velaclose${Date.now().toString(36)}`.slice(0, 36),
      });
    }
    const px = await getWeexLast(row.weex_symbol);
    const entry = n(row.fill_px ?? row.entry);
    const pnl = row.side === "short" ? (entry - px) * n(row.qty) : (px - entry) * n(row.qty);
    const why = pnl < 0 ? "Flattened by you at a loss" : "Flattened by you";
    await sql`
      update auto_signals
      set status = 'skipped', closed_px = ${px}, pnl = ${pnl}, close_reason = ${why}, updated_at = now()
      where id = ${row.id} and user_id = ${context.userId}
    `;
    const next = Math.max(5, n(settings?.account_usd) + pnl);
    const peak = Math.max(n(settings?.peak_usd) || next, next);
    const streak = pnl >= 0 ? 0 : (settings?.loss_streak ?? 0) + 1;
    const winStreak = pnl >= 0 ? (settings?.win_streak ?? 0) + 1 : 0;
    await sql`
      update auto_settings
      set account_usd = ${next}, peak_usd = ${peak}, loss_streak = ${streak}, win_streak = ${winStreak}
      where user_id = ${context.userId}
    `;
    return { pnl };
  });

export const reviewBook = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("@/lib/db");
    const { getWeexLast } = await import("@/lib/weex-market.server");
    const { writeDeskNote } = await import("@/lib/desk-rules");
    const sql = await getSql();
    const [settings] = await sql<SettingsRow>`select * from auto_settings where user_id = ${context.userId}`;
    if (!settings) return { ok: false as const, error: "No desk yet." };
    let stats = await closedStats(sql, context.userId, settings?.stats_from);
    const pulled = await pullWeexBook(settings).catch(() => ({ live: null as { equity: number; available: number } | null, error: null as string | null }));
    const pub = publicSettings(settings, stats, pulled.live, pulled.error);
    const open = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${context.userId} and status in ('working','filled')
      order by created_at desc
    `;
    const tickets = await Promise.all(
      open.map(async (p) => ({
        symbol: p.weex_symbol,
        side: p.side,
        leverage: p.leverage,
        entry: n(p.fill_px ?? p.entry),
        stop: n(p.stop),
        target: n(p.target),
        last: await getWeexLast(p.weex_symbol).catch(() => n(p.fill_px ?? p.entry)),
        beMoved: Boolean(p.be_moved),
        status: p.status,
        targets: parseNums(p.targets),
      })),
    );
    const text = writeDeskNote({
      phase: pub.phase,
      equity: pub.accountUsd,
      marginPct: pub.riskPct,
      correction: pub.correction ?? "",
      tickets,
    });
    for (const row of open) {
      await sql`update auto_signals set review = ${text}, updated_at = now() where id = ${row.id}`;
    }
    return { ok: true as const, text };
  });
