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
      const s = fmt(total / count, precision);
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

/** 1R in dollars: original stop distance × full size. Ignore the BE stop. */
function oneRUsd(row: {
  qty?: string | number | null;
  notional?: string | number | null;
  fill_px?: string | number | null;
  entry?: string | number | null;
  stop?: string | number | null;
  targets?: string | null;
  be_moved?: boolean | null;
}): number {
  const e = n(row.fill_px) || n(row.entry);
  const q = origQty(row);
  if (!(e > 0) || !(q > 0)) return 0;
  let dist = Math.abs(e - n(row.stop));
  const tp1 = parseNums(row.targets)[0];
  if ((row.be_moved || (e > 0 && dist / e < 0.004)) && tp1 != null) {
    dist = Math.abs(tp1 - e);
  }
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

function publicSettings(
  row: SettingsRow,
  stats: { closed: number; wins: number; winRate?: number; avgWinR?: number; avgLossR?: number; names?: string[] } = { closed: 0, wins: 0 },
  live?: { equity: number; available: number } | null,
  weexError?: string | null,
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
    riskPct: liveEq != null ? phase.marginPct : 2,
    accountUsd: equity,
    availableUsd: live?.available ?? 0,
    weexLive: Boolean(live),
    weexError: weexError ?? null,
    minRr: phase.minRr,
    maxOpen: phase.maxOpen,
    lastTickAt: row.last_tick_at,
    lastTickNote: row.last_tick_note,
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
    const key = `${r.weex_symbol ?? "?"}|${r.side ?? "?"}`;
    const prev = best.get(key);
    const ru = new Date(r.updated_at ?? r.filled_at ?? 0).getTime();
    const pu = prev ? new Date(prev.updated_at ?? prev.filled_at ?? 0).getTime() : 0;
    if (!prev || ru >= pu) best.set(key, r);
  }
  return [...best.values()];
}

async function closedStats(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  statsFrom?: string | Date | null,
) {
  const from = statsFrom ?? new Date(0).toISOString();
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
    be_moved: boolean | null;
    weex_symbol: string | null;
    side: string | null;
    filled_at: string | null;
    updated_at: string | null;
    created_at: string | null;
  }>`
    select id, pnl, entry, stop, qty, fill_px, risk_usd, notional, targets, be_moved,
           weex_symbol, side, filled_at, updated_at, created_at
    from auto_signals
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
  const uniq = uniqueFills(rows);
  const closed = uniq.length;
  const wins = uniq.filter((r) => n(r.pnl) > 0).length;
  const rs = uniq
    .map((r) => {
      const risk = oneRUsd(r);
      if (!(risk > 0.01)) return null;
      return n(r.pnl) / risk;
    })
    .filter((x): x is number => x != null);
  const winRs = rs.filter((x) => x > 0);
  const lossRs = rs.filter((x) => x < 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    closed,
    wins,
    winRate: closed > 0 ? (wins / closed) * 100 : 0,
    avgWinR: avg(winRs),
    avgLossR: avg(lossRs),
    names: uniq
      .map((r) => {
        const p = n(r.pnl);
        const pair = (r.weex_symbol ?? "").replace("USDT", "");
        return `${pair} ${p >= 0 ? "+" : ""}${p.toFixed(2)}`;
      })
      .slice(0, 20),
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

/** True only if TP1 actually printed (qty cut or price tagged the take) — not just a 1R BE lock. */
function tp1Printed(
  row: { side: string; targets?: string | null; tp1_hit?: boolean | null },
  last: number,
): boolean {
  if (row.tp1_hit) return true;
  const tp1 = parseNums(row.targets)[0];
  if (tp1 == null || !(last > 0)) return false;
  return row.side === "short" ? last <= tp1 * 1.001 : last >= tp1 * 0.999;
}

function closeLabel(beMoved: boolean, printed: boolean, pnl: number, hitStop: boolean): string {
  if (beMoved && !printed && Math.abs(pnl) < 0.4) return "BE scratch — not a win or loss";
  if (beMoved && printed) return pnl >= 0 ? "TP1 then BE" : "TP1 then leftover stopped";
  if (hitStop && pnl <= 0) return "Hit stop";
  if (pnl > 0.4) return beMoved && !printed ? "Closed in green" : "Closed on WEEX";
  if (pnl < -0.4) return "Closed on WEEX";
  if (beMoved && !printed) return "BE scratch — not a win or loss";
  return "Closed on WEEX";
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

function matchWeexClose(
  row: { weex_symbol: string; side: string; created_at: string; updated_at?: string | null },
  closes: { symbol: string; side?: "long" | "short"; pnl: number; closePx: number; ts: number }[],
) {
  const key = row.weex_symbol.replace(/_/g, "").toUpperCase();
  const side = row.side === "short" ? "short" : "long";
  const created = new Date(row.created_at).getTime();
  const updated = new Date(row.updated_at ?? row.created_at).getTime();
  const cands = closes.filter((c) => {
    if (c.symbol.replace(/_/g, "").toUpperCase() !== key) return false;
    if (c.side && c.side !== side) return false;
    if (!c.ts) return false;
    return c.ts >= created - 30 * 60_000 && c.ts <= updated + 6 * 3600_000;
  });
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const da = a.ts ? Math.abs(a.ts - updated) : 9e15;
    const db = b.ts ? Math.abs(b.ts - updated) : 9e15;
    return da - db;
  });
  return cands[0] ?? null;
}

async function restampWeexPnl(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  creds: { apiKey: string; apiSecret: string; passphrase: string },
  notes: string[],
) {
  const { listWeexClosedPnl } = await import("@/lib/weex.server");
  const closes = await listWeexClosedPnl(creds).catch(() => []);
  if (!closes.length) return;
  const rows = await sql<SignalRow>`
    select * from auto_signals
    where user_id = ${userId}
      and status in ('stopped','targeted','skipped')
      and updated_at > now() - interval '14 days'
  `;
  for (const row of rows) {
    if (!row.client_oid) continue;
    const hit = matchWeexClose(row, closes);
    if (!hit) continue;
    if (Math.abs(n(row.pnl) - hit.pnl) < 0.08) continue;
    const st = hit.pnl >= 0.05 ? "targeted" : hit.pnl <= -0.05 ? "stopped" : row.status;
    const px = hit.closePx > 0 ? hit.closePx : n(row.closed_px);
    await sql`
      update auto_signals
      set pnl = ${hit.pnl},
          closed_px = ${px || null},
          status = ${st},
          updated_at = now()
      where id = ${row.id} and user_id = ${userId}
    `;
    notes.push(
      `${row.weex_symbol} WEEX PnL ${hit.pnl >= 0 ? "+" : ""}${hit.pnl.toFixed(2)} (was ${n(row.pnl).toFixed(2)})`,
    );
  }
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
  const { placeWeexTake, moveWeexStop, cancelWeexProtective, cancelWeexStops, getWeexPositionQty, listWeexAlgos, listWeexPositions } = await import("@/lib/weex.server");
  const stacked = (await listWeexAlgos(creds, pos.weex_symbol)).length;
  const stopPx = stopOverride != null && stopOverride > 0 ? stopOverride : n(pos.stop);
  const want = 1 + Math.min(2, parseNums(pos.targets).length || 2);
  const resp = pos.weex_resp ?? "";
  const already = /tps:(ok|swept)/.test(resp);
  const extras = stacked > want;
  const sweptAt = Number(/tps:swept@(\d+)/.exec(resp)?.[1] || 0);
  if (already && stopOverride == null) {
    if (extras) {
      await cancelWeexProtective(creds, pos.weex_symbol);
      notes.push(`${pos.weex_symbol} extras on WEEX — cancelled what we could. Not adding.`);
      return;
    }
    if (stacked > 0) return;
    if (sweptAt && Date.now() - sweptAt < 6 * 60 * 60 * 1000) return;
  }
  const force = extras || stopOverride != null || !already || stacked === 0;
  const { coinByWeex } = await import("@/lib/universe");
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const [lock] = await sql<{ id: number }>`
    update auto_signals
    set weex_resp = ${`${resp.replace(/tps:(lock|ok|swept|partial)/g, "").trim()} tps:lock`.slice(0, 500)}, updated_at = now()
    where id = ${pos.id}
      and (${force ? true : false} or (
        coalesce(weex_resp, '') not like '%tps:lock%'
        and coalesce(weex_resp, '') not like '%tps:swept%'
        and coalesce(weex_resp, '') not like '%tps:ok%'
      ) or ${stacked} > ${want})
    returning id
  `;
  if (!lock) return;
  const spec = await specFor(coinByWeex(pos.weex_symbol));
  const liveQty = (await getWeexPositionQty(creds, pos.weex_symbol)) ?? origQty(pos);
  if (!(liveQty > 0)) return;
  const book = await listWeexPositions(creds).catch(() => null);
  const key = pos.weex_symbol.replace(/_/g, "").toUpperCase();
  const live = (book ?? []).find((p) => p.symbol.replace(/_/g, "").toUpperCase() === key);
  const mark = live?.mark ?? 0;
  const side = pos.side === "short" ? "SHORT" : "LONG";
  const sideLc = pos.side === "short" ? "short" : "long";
  const { taggedTake } = await import("@/lib/ta");
  const rawTps = parseNums(pos.targets).slice(0, 2);
  const tps: number[] = [];
  for (const p of rawTps) {
    const px = Number(formatWeexPx(p, spec.pricePrecision));
    if (!(px > 0)) continue;
    if (tps.some((t) => t === px)) continue;
    if (mark > 0 && taggedTake(sideLc, mark, px)) continue;
    tps.push(px);
  }

  if (stopOverride != null) {
    await cancelWeexStops(creds, pos.weex_symbol, { side: sideLc, mark });
    const qtyStr = formatWeexQty(liveQty, spec.quantityPrecision);
    if (stopPx > 0) {
      await moveWeexStop(creds, {
        symbol: pos.weex_symbol,
        positionSide: side,
        stop: formatWeexPx(stopPx, spec.pricePrecision),
        quantity: qtyStr,
        clientOid: `velasl${pos.id}${Date.now().toString(36)}`.slice(0, 36),
      });
    }
    await cancelWeexStops(creds, pos.weex_symbol, { side: sideLc, mark, keepPx: stopPx });
    notes.push(
      `${pos.weex_symbol} SL → WEEX BE ${stopPx.toFixed(4)} on leftover ${Number(qtyStr)}. Old SLs cancelled. TPs left.`,
    );
    const stampBe = `${resp.replace(/tps:(lock|ok|swept)@?\d*/g, "").trim()} tps:ok tps:swept@${Date.now()}`.slice(0, 500);
    await sql`update auto_signals set weex_resp = ${stampBe}, stop = ${stopPx}, updated_at = now() where id = ${pos.id}`;
    pos.weex_resp = stampBe;
    pos.stop = stopPx;
    return;
  }
  await cancelWeexProtective(creds, pos.weex_symbol);
  let still = await listWeexAlgos(creds, pos.weex_symbol);
  if (still.length) {
    await cancelWeexProtective(creds, pos.weex_symbol);
    still = await listWeexAlgos(creds, pos.weex_symbol);
  }
  const stamp = `${resp.replace(/tps:(lock|ok|swept)@?\d*/g, "").trim()} tps:ok tps:swept@${Date.now()}`.slice(0, 500);
  if (still.length > 0) {
    notes.push(
      `${pos.weex_symbol} ${still.length} TPSL still on WEEX after cancel — not stacking more. In WEEX: Cancel all TP/SL on this pair. Bot will not add until that pile is gone.`,
    );
    await sql`update auto_signals set weex_resp = ${stamp}, updated_at = now() where id = ${pos.id}`;
    pos.weex_resp = stamp;
    return;
  }
  const qtyStr = formatWeexQty(liveQty, spec.quantityPrecision);
  if (stopPx > 0) {
    await moveWeexStop(creds, {
      symbol: pos.weex_symbol,
      positionSide: side,
      stop: formatWeexPx(stopPx, spec.pricePrecision),
      quantity: qtyStr,
      clientOid: `velasl${pos.id}${Date.now().toString(36)}`.slice(0, 36),
    });
  }
  let ok = 0;
  const slices = takeQtys(liveQty, tps.length, spec.quantityPrecision, formatWeexQty);
  for (let i = 0; i < tps.length; i += 1) {
    const slice = slices[i]!;
    if (Number(slice) <= 0) continue;
    const sent = await placeWeexTake(creds, {
      symbol: pos.weex_symbol,
      positionSide: side,
      tp: formatWeexPx(tps[i]!, spec.pricePrecision),
      quantity: slice,
      clientOid: `velatp${pos.id}${i}${Date.now().toString(36)}`.slice(0, 36),
    });
    if (sent.ok) ok += 1;
    else notes.push(`${pos.weex_symbol} TP${i + 1} failed: ${sent.error.slice(0, 80)}`);
  }
  notes.push(`${pos.weex_symbol} 1 SL @ ${stopPx.toFixed(4)} + ${ok} TP`);
  await sql`
    update auto_signals
    set weex_resp = ${stamp}, updated_at = now()
    where id = ${pos.id}
  `;
  pos.weex_resp = stamp;
  pos.stop = stopPx;
}

async function resurrectLive(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
  livePos: { symbol: string; qty: number; side?: string; entry?: number }[] | null,
  notes: string[],
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
    const entry = n(pos.fill_px ?? pos.entry);
    const side = pos.side === "short" ? "short" : "long";
    const last = await getWeexLast(pos.weex_symbol).catch(() => entry);
    const stopPx = n(pos.stop);
    const hitSl = throughStop(side, last, stopPx);
    const px = hitSl ? stopPx : last;
    const printed = Boolean(pos.tp1_hit) || tp1Printed(pos, px);
    const { ticketPnl } = await import("@/lib/ta");
    const pnl = ticketPnl({
      side,
      entry,
      last: px,
      qty: origQty(pos),
      leftover: 0,
      targets: parseNums(pos.targets),
      beMoved: Boolean(pos.be_moved),
      tp1Hit: printed,
    });
    const why = closeLabel(Boolean(pos.be_moved), printed, pnl, hitSl);
    const scratch = why.startsWith("BE scratch");
    const winClose = why === "TP1 then BE" || why === "Closed in green" || (why === "Closed on WEEX" && pnl >= 0);
    const st = scratch
      ? "skipped"
      : why === "Hit stop" || why === "TP1 then leftover stopped" || (why === "Closed on WEEX" && pnl < 0)
        ? "stopped"
        : winClose
          ? "targeted"
          : "skipped";
    await sql`
      update auto_signals
      set status = ${st}, closed_px = ${px}, pnl = ${scratch ? 0 : pnl}, close_reason = ${why}, updated_at = now()
      where id = ${pos.id} and user_id = ${userId}
    `;
    if (creds) {
      const { cancelWeexProtective } = await import("@/lib/weex.server");
      await cancelWeexProtective(creds, pos.weex_symbol).catch(() => null);
    }
    notes.push(`${pos.weex_symbol} ${why}${scratch ? "" : ` ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}`);
    if (!scratch) booked.push(pnl);
    if (why === "Closed on WEEX" || why === "Closed in green") flattenedNow.push(pos.weex_symbol);
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
    const wantQty = (equity * 0.02 * spec.maxLeverage) / entry;
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
          ? `Trimmed ${pos.weex_symbol} to ~2% margin`
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
    if (creds) {
      const { listWeexPositions } = await import("@/lib/weex.server");
      livePos = await listWeexPositions(creds).catch(() => null);
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
    const stats = await closedStats(sql, context.userId, settings?.stats_from);
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
    const { ticketPnl } = await import("@/lib/ta");
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
        t.pnl = ticketPnl({
          side: t.side,
          entry,
          last,
          qty: pos?.qty || t.qty,
          leftover: left ?? null,
          targets: t.targets,
          beMoved: t.beMoved,
        });
      }
    }
    return {
      settings: publicSettings(settings!, stats, live, pulled.error),
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
    const note = /auto_signals_one_open|unique/i.test(msg)
      ? "Already one ticket on that pair — skipped duplicate."
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
    const { scanUniverse, shouldLockBreakeven, breakevenPrice, scoreToConf, ticketPnl, taggedTake } = await import("@/lib/ta");
    const { sizeSetup } = await import("@/lib/risk");
    const { coinByWeex, CORE_SET } = await import("@/lib/universe");
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
    const stats = await closedStats(sql, userId, settings.stats_from);
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
    const botched = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId}
        and be_moved = true
        and status in ('skipped','stopped','targeted')
        and close_reason in ('Closed on WEEX', 'Hit stop', 'TP1 then BE')
    `;
    for (const row of botched) {
      const entry = n(row.fill_px ?? row.entry);
      const last = n(row.closed_px) || entry;
      const side = row.side === "short" ? "short" : "long";
      const tp1 = parseNums(row.targets)[0];
      let printed = Boolean(row.tp1_hit);
      if (!printed && tp1 != null) {
        const hours = await getWeexKlines(row.weex_symbol, "1h", 80).catch(() => []);
        const since = new Date(row.filled_at ?? row.created_at).getTime();
        const until = new Date(row.updated_at ?? row.created_at).getTime();
        const after = hours.filter((c) => {
          const t = c.time > 1e12 ? c.time : c.time * 1000;
          return Number.isFinite(since) ? t >= since - 3600_000 && t <= until + 60_000 : true;
        });
        if (after.length) {
          const ext =
            side === "short"
              ? Math.min(...after.map((c) => c.low))
              : Math.max(...after.map((c) => c.high));
          printed = tp1Printed({ ...row, tp1_hit: false }, ext);
        } else if (row.close_reason === "TP1 then BE") {
          printed = true;
        }
      }
      const pnl = ticketPnl({
        side,
        entry,
        last,
        qty: origQty(row),
        leftover: 0,
        targets: parseNums(row.targets),
        beMoved: true,
        tp1Hit: printed,
      });
      const why = closeLabel(true, printed, pnl, false);
      const already = row.close_reason === why && Math.abs(n(row.pnl) - pnl) < 0.02;
      if (already) continue;
      const st = why.startsWith("BE scratch") ? "skipped" : why === "TP1 then leftover stopped" ? "stopped" : "targeted";
      await sql`
        update auto_signals
        set status = ${st},
            pnl = ${why.startsWith("BE scratch") ? 0 : pnl},
            close_reason = ${why},
            updated_at = now()
        where id = ${row.id} and user_id = ${userId}
      `;
      if (why.startsWith("BE scratch")) {
        notes.push(`${row.weex_symbol} reclassed: BE scratch (TP1 never printed)`);
      } else if (row.close_reason !== "TP1 then BE") {
        notes.push(`${row.weex_symbol} restated: ${why} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
      }
    }
    const fakeFlat = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId}
        and close_reason = 'Closed on WEEX'
        and filled_at > now() - interval '6 hours'
        and updated_at > now() - interval '12 hours'
    `;
    for (const row of fakeFlat) {
      const side = row.side === "short" ? "short" : "long";
      const last = n(row.closed_px) || n(row.stop);
      const r = oneRUsd(row);
      const pnl = n(row.pnl);
      const wasStop =
        throughStop(side, last, n(row.stop)) || (r > 0 && pnl < 0 && Math.abs(pnl) >= r * 0.7);
      if (!wasStop) continue;
      await sql`
        update auto_signals
        set status = 'stopped',
            close_reason = ${"Hit stop"},
            updated_at = now()
        where id = ${row.id} and user_id = ${userId}
      `;
      notes.push(`${row.weex_symbol} restated: hit SL, not a flatten`);
    }
    const manuals = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId}
        and close_reason = 'Closed on WEEX'
        and status in ('skipped','stopped','targeted')
    `;
    for (const row of manuals) {
      const entry = n(row.fill_px ?? row.entry);
      const last = n(row.closed_px) || n(row.stop) || entry;
      const side = row.side === "short" ? "short" : "long";
      const pnl = ticketPnl({
        side,
        entry,
        last,
        qty: origQty(row),
        leftover: 0,
        targets: parseNums(row.targets),
        beMoved: Boolean(row.be_moved),
        tp1Hit: Boolean(row.tp1_hit),
      });
      const st = pnl >= 0 ? "targeted" : "stopped";
      if (Math.abs(n(row.pnl) - pnl) < 0.05 && row.status === st) continue;
      const r = oneRUsd(row);
      await sql`
        update auto_signals
        set status = ${st},
            pnl = ${pnl},
            closed_px = ${last},
            updated_at = now()
        where id = ${row.id} and user_id = ${userId}
      `;
      notes.push(
        `${row.weex_symbol} manual close ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}${r > 0.01 ? ` (${(pnl / r).toFixed(2)}R)` : ""}`,
      );
    }
    const misbooked = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId}
        and status in ('skipped','stopped','targeted')
        and (
          close_reason like 'BE scratch%'
          or close_reason = 'TP1 then BE'
          or close_reason = 'Closed in green'
        )
    `;
    for (const row of misbooked) {
      const entry = n(row.fill_px ?? row.entry);
      let last = n(row.closed_px) || entry;
      const side = row.side === "short" ? "short" : "long";
      if (entry > 0 && Math.abs(last - entry) / entry < 0.004) {
        const minutes = await getWeexKlines(row.weex_symbol, "1m", 180).catch(() => []);
        const until = new Date(row.updated_at ?? row.created_at).getTime();
        const bars = minutes.filter((c) => {
          const t = c.time > 1e12 ? c.time : c.time * 1000;
          return t <= until + 120_000 && t >= until - 20 * 60_000;
        });
        const px = bars.length ? bars[bars.length - 1]!.close : 0;
        if (px > 0) last = px;
      }
      const printed = Boolean(row.tp1_hit) || tp1Printed({ ...row, tp1_hit: false }, last);
      const pnl = ticketPnl({
        side,
        entry,
        last,
        qty: origQty(row),
        leftover: 0,
        targets: parseNums(row.targets),
        beMoved: Boolean(row.be_moved),
        tp1Hit: printed || Boolean(row.tp1_hit),
      });
      const why = closeLabel(Boolean(row.be_moved), printed || Boolean(row.tp1_hit), pnl, false);
      const scratch = why.startsWith("BE scratch");
      const st = scratch ? "skipped" : pnl >= 0 ? "targeted" : "stopped";
      if (row.close_reason === why && row.status === st && Math.abs(n(row.pnl) - (scratch ? 0 : pnl)) < 0.08) {
        continue;
      }
      const r = oneRUsd(row);
      await sql`
        update auto_signals
        set status = ${st},
            pnl = ${scratch ? 0 : pnl},
            closed_px = ${last},
            close_reason = ${why},
            updated_at = now()
        where id = ${row.id} and user_id = ${userId}
      `;
      notes.push(
        `${row.weex_symbol} restated ${why} ${scratch ? "$0" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}${!scratch && r > 0.01 ? ` (${(pnl / r).toFixed(2)}R)` : ""}`,
      );
    }
    const fakeWins = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId}
        and close_reason = 'Hit stop'
        and filled_at > now() - interval '6 hours'
        and updated_at > now() - interval '12 hours'
    `;
    for (const row of fakeWins) {
      const side = row.side === "short" ? "short" : "long";
      const entry = n(row.fill_px ?? row.entry);
      const stopPx = n(row.stop);
      const q = origQty(row);
      const fair = side === "short" ? (entry - stopPx) * q : (stopPx - entry) * q;
      if (!(q > 0) || !(stopPx > 0)) continue;
      if (fair >= 0) continue;
      if (n(row.pnl) <= 0 && Math.abs(n(row.pnl) - fair) < 0.2) continue;
      await sql`
        update auto_signals
        set status = 'stopped',
            closed_px = ${stopPx},
            pnl = ${fair},
            close_reason = ${"Hit stop"},
            updated_at = now()
        where id = ${row.id} and user_id = ${userId}
      `;
      notes.push(`${row.weex_symbol} restated: SL ${fair.toFixed(2)} (was booked as a win)`);
    }
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
    let weexBook: { symbol: string; qty: number; side?: string }[] | null = null;
    let bookedFlat: number[] = [];
    let flattenedTick: string[] = [];
    {
      const creds = await credsFrom(settings);
      if (creds) {
        const { listWeexPositions } = await import("@/lib/weex.server");
        weexBook = await listWeexPositions(creds);
        await resurrectLive(sql, userId, weexBook, notes);
        const flat = await closeFlatOnWeex(sql, userId, weexBook, notes, creds);
        bookedFlat = flat.booked;
        flattenedTick = flat.flattened;
        await restampWeexPnl(sql, userId, creds, notes);
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
        const e = n(pos.entry);
        const crossed = side === "long" ? px <= e : px >= e;
        const credsFill = await credsFrom(settings);
        if (crossed && credsFill) {
          const { getWeexPositionQty } = await import("@/lib/weex.server");
          const q = await getWeexPositionQty(credsFill, pos.weex_symbol);
          if (q != null && q > 0) {
            await sql`
              update auto_signals
              set status = 'filled', fill_px = ${e}, qty = ${q}, filled_at = now(), updated_at = now()
              where id = ${pos.id} and user_id = ${userId}
            `;
            pos.status = "filled";
            pos.qty = q;
            pos.fill_px = e;
            notes.push(`Filled ${pos.weex_symbol} limit`);
            await ensureTakes(pos, notes, credsFill);
          }
        }
        continue;
      }

      const credsTp = await credsFrom(settings);
      if (pos.status === "filled" && credsTp) {
        await ensureTakes(pos, notes, credsTp);
        const { cancelWeexStops } = await import("@/lib/weex.server");
        await cancelWeexStops(credsTp, pos.weex_symbol, {
          side,
          mark: px,
          keepPx: n(pos.stop),
        });
      }

      const tps = parseNums(pos.targets);
      let mark = px;
      let reduced = false;
      if (pos.status === "filled" && !pos.be_moved) {
        const sinceMs = new Date(pos.filled_at ?? pos.created_at).getTime();
        const minutes = await getWeexKlines(pos.weex_symbol, "1m", 120).catch(() => []);
        const after = minutes.filter((c) => {
          const t = c.time > 1e12 ? c.time : c.time * 1000;
          return t >= sinceMs - 60_000;
        });
        if (after.length) {
          mark = side === "long"
            ? Math.max(px, ...after.map((c) => c.high))
            : Math.min(px, ...after.map((c) => c.low));
        }
        const credsForPos = await credsFrom(settings);
        if (credsForPos) {
          const { getWeexPositionQty } = await import("@/lib/weex.server");
          const left = await getWeexPositionQty(credsForPos, pos.weex_symbol);
          if (left != null && n(pos.qty) > 0 && left < n(pos.qty) * 0.72) reduced = true;
        }
      }
      if (
        shouldLockBreakeven({
          side,
          entry,
          stop,
          last: mark,
          targets: tps,
          already: Boolean(pos.be_moved),
          reduced,
        })
      ) {
        const creds = await credsFrom(settings);
        const rawBe = await weexFeeBe(creds, pos.weex_symbol, side, entry);
        const { safeBeStop } = await import("@/lib/ta");
        const be = safeBeStop(side, entry, mark || px, rawBe);
        const hitFirst = tps[0] != null && taggedTake(side, mark, tps[0]!);
        const printed = Boolean(reduced || hitFirst);
        if (be == null && creds) {
          const liveLeft = (await (await import("@/lib/weex.server")).getWeexPositionQty(creds, pos.weex_symbol)) ?? 0;
          if (liveLeft > 0) {
            const spec = await specFor(coinByWeex(pos.weex_symbol));
            const { flattenWeex, cancelWeexProtective } = await import("@/lib/weex.server");
            await cancelWeexProtective(creds, pos.weex_symbol).catch(() => null);
            await flattenWeex(creds, {
              symbol: pos.weex_symbol,
              side: side === "short" ? "BUY" : "SELL",
              positionSide: side === "short" ? "SHORT" : "LONG",
              quantity: formatWeexQty(liveLeft, spec.quantityPrecision),
              clientOid: `velabe${pos.id}${Date.now().toString(36)}`.slice(0, 36),
            });
            notes.push(`${pos.weex_symbol} TP1 banked — BE would fire through the market, flattened leftover.`);
          }
          await sql`
            update auto_signals
            set be_moved = true, tp1_hit = true, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
        } else if (be != null) {
          let moved = false;
          if (creds) {
            pos.stop = be;
            await ensureTakes(pos, notes, creds, be);
            moved = true;
          }
          if (moved || !creds) {
            await sql`
              update auto_signals
              set stop = ${be}, be_moved = true, tp1_hit = ${printed}, updated_at = now()
              where id = ${pos.id} and user_id = ${userId}
            `;
            if (moved) {
              notes.push(
                printed
                  ? `${pos.weex_symbol} TP1 printed · stop to fee BE ${be.toFixed(4)} (under the market)`
                  : `${pos.weex_symbol} size cut · stop to fee BE ${be.toFixed(4)}`,
              );
            }
          }
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
      if (pos.status === "filled" && credsNow && left != null && left > 0) {
        const orig = origQty(pos);
        const dust = orig > 0 && left <= orig * 0.18;
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
        const exit = throughStop(side, px, stop) ? stop : px;
        const printed = tp1Printed(pos, exit) || Boolean(pos.tp1_hit);
        const { ticketPnl } = await import("@/lib/ta");
        const pnl = ticketPnl({
          side,
          entry,
          last: exit,
          qty: origQty(pos),
          leftover: 0,
          targets: tps,
          beMoved: Boolean(pos.be_moved),
          tp1Hit: printed,
        });
        const why = closeLabel(Boolean(pos.be_moved), printed, pnl, throughStop(side, px, stop));
        const scratch = why.startsWith("BE scratch");
        const st = scratch ? "skipped" : why === "Hit stop" || why === "TP1 then leftover stopped" ? "stopped" : "targeted";
        await sql`
          update auto_signals
          set status = ${st}, closed_px = ${exit}, pnl = ${scratch ? 0 : pnl}, close_reason = ${why}, updated_at = now()
          where id = ${pos.id} and user_id = ${userId}
        `;
        if (!scratch) {
          streak = pnl >= 0 ? 0 : streak + 1;
          winStreak = pnl >= 0 ? winStreak + 1 : 0;
          closed += 1;
        }
        notes.push(`${pos.weex_symbol} ${why}${scratch ? "" : ` ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}`);
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
        if (act === "lockBe" && !pos.be_moved) {
          const creds = credsNow ?? (await credsFrom(settings));
          const be = await weexFeeBe(creds, pos.weex_symbol, side, entry);
          if (creds) {
            pos.stop = be;
            await ensureTakes(pos, notes, creds, be);
          }
          await sql`
            update auto_signals
            set stop = ${be}, be_moved = true, tp1_hit = false, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          notes.push(`${pos.weex_symbol} chop → fee BE ${be.toFixed(4)}. Slot free.`);
          continue;
        }
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
            ? `Sold at a loss to move on — no 0.3R in ${hours}`
            : `Sold to move on — no 0.3R in ${hours}`;
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
        const dust = left != null && left > 0 && orig > 0 && left <= orig * 0.18;
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
        const exit = hitStop ? stop : target;
        const printed = Boolean(pos.tp1_hit) || tp1Printed(pos, exit) || (!hitStop && hitTp);
        const { ticketPnl } = await import("@/lib/ta");
        const pnl = ticketPnl({
          side,
          entry,
          last: exit,
          qty: origQty(pos),
          leftover: 0,
          targets: tps,
          beMoved: Boolean(pos.be_moved),
          tp1Hit: printed,
        });
        const why = closeLabel(Boolean(pos.be_moved), printed, pnl, hitStop);
        const scratch = why.startsWith("BE scratch");
        const st = scratch
          ? "skipped"
          : why === "Hit stop" || why === "TP1 then leftover stopped"
            ? "stopped"
            : "targeted";
        await sql`
          update auto_signals
          set status = ${st},
              closed_px = ${exit}, pnl = ${scratch ? 0 : pnl}, close_reason = ${why}, updated_at = now()
          where id = ${pos.id} and user_id = ${userId}
        `;
        if (!scratch) {
          streak = pnl >= 0 ? 0 : streak + 1;
          winStreak = pnl >= 0 ? winStreak + 1 : 0;
          closed += 1;
        }
        notes.push(`${pos.weex_symbol} ${why}${scratch ? "" : ` ${pnl.toFixed(2)}`}`);
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
    const LIVE_CAP = 6;
    const SIDE_CAP = 2;
    const ledger = await ticketLedger(sql, userId, settings.stats_from);
    const closedConf = await sql<{ confidence: string | number | null; pnl: string | number | null }>`
      select confidence, pnl from auto_signals
      where user_id = ${userId} and status in ('stopped','targeted','skipped')
    `;
    const bar = rules.confidenceBar(
      closedConf.map((r) => ({ conf: n(r.confidence), pnl: n(r.pnl) })),
      corrected.minConf,
    );

    const liveN = (weexBook ?? []).filter((p) => p.qty > 0);
    const beNames = new Set(
      stillOpenRaw.filter((s) => s.be_moved).map((s) => s.weex_symbol.replace(/_/g, "").toUpperCase()),
    );
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
      (s) => s.status === "filled" && !s.be_moved && !flattened.has(s.weex_symbol),
    );
    const countAtRisk = (side: "long" | "short") => {
      const fromLive = liveN.filter(
        (p) =>
          (p.side === "short" ? "short" : "long") === side &&
          !beNames.has(p.symbol.replace(/_/g, "").toUpperCase()),
      ).length;
      const fromDb = dbFilled.filter((s) => (s.side === "short" ? "short" : "long") === side).length;
      const fromWorking = stillOpenRaw.filter(
        (s) =>
          (s.status === "working" || s.status === "proposed") &&
          (s.side === "short" ? "short" : "long") === side,
      ).length;
      const filled = weexBook == null ? fromDb : fromLive;
      return filled + fromWorking;
    };
    const riskL = countAtRisk("long");
    const riskS = countAtRisk("short");
    const needL = Math.max(0, SIDE_CAP - riskL);
    const needS = Math.max(0, SIDE_CAP - riskS);
    const huntStatus = !settings.armed
      ? "Disarmed. Not hunting."
      : needL === 0 && needS === 0
        ? "Not hunting — 2 longs and 2 shorts already at risk. Next after TP1/BE."
        : `Hunting up to 2L+2S (${riskL}L/${riskS}S live). Need ${[needL ? `${needL} long` : "", needS ? `${needS} short` : ""].filter(Boolean).join(" + ")}. A+ scalps only — will not fill empty slots.`;
    notes.push(
      `WEEX ${riskL}L/${riskS}S: ${
        liveN.length
          ? liveN
              .map((p) => `${p.symbol.replace(/_/g, "").toUpperCase()} ${(p.side === "short" ? "short" : "long")}${beNames.has(p.symbol.replace(/_/g, "").toUpperCase()) ? " BE" : ""}`)
              .join(", ")
          : "flat"
      }.`,
    );
    const whyLive = stillOpen
      .filter((s) => s.status === "filled" || s.status === "working")
      .map((s) => {
        const tail = (s.thesis ?? "").split("·").pop()?.trim() || "";
        return `${s.weex_symbol.replace("USDT", "")} ${s.side} ${Math.round(n(s.confidence))}% — ${tail.slice(0, 64)}`;
      });
    const credsGate2 = await credsFrom(settings);
    let parked: SignalRow | null = null;
    if (credsGate2) {
      const filledSym = new Set(
        liveN
          .filter((p) => !beNames.has(p.symbol.replace(/_/g, "").toUpperCase()))
          .map((p) => p.symbol.replace(/_/g, "").toUpperCase()),
      );
      for (const s of dbFilled) filledSym.add(s.weex_symbol.replace(/_/g, "").toUpperCase());
      const extras = stillOpenRaw.filter((s) => {
        if (s.status !== "working" && s.status !== "proposed") return false;
        const sym = s.weex_symbol.replace(/_/g, "").toUpperCase();
        if (filledSym.has(sym)) return true;
        const side = s.side === "short" ? "short" : "long";
        const filledSide = liveN.filter(
          (p) =>
            (p.side === "short" ? "short" : "long") === side &&
            !beNames.has(p.symbol.replace(/_/g, "").toUpperCase()),
        ).length;
        return filledSide >= SIDE_CAP;
      });
      const { cancelWeexOrder, cancelWeexProtective } = await import("@/lib/weex.server");
      for (const row of extras) {
        if (row.client_oid) {
          await cancelWeexOrder(credsGate2, { symbol: row.weex_symbol, clientOid: row.client_oid }).catch(() => null);
        }
        await cancelWeexProtective(credsGate2, row.weex_symbol).catch(() => null);
        await sql`
          update auto_signals
          set status = 'skipped',
              close_reason = ${"Cancelled — duplicate or side cap (2)"},
              pnl = 0,
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(`${row.weex_symbol} limit cancelled — duplicate or 2 already on that side`);
      }
      const leftoverWorking = stillOpenRaw.filter(
        (s) =>
          (s.status === "working" || s.status === "proposed") &&
          !extras.some((e) => e.id === s.id),
      );
      leftoverWorking.sort((a, b) => n(b.confidence) - n(a.confidence));
      for (const row of leftoverWorking.slice(1)) {
        if (row.client_oid) {
          await cancelWeexOrder(credsGate2, { symbol: row.weex_symbol, clientOid: row.client_oid }).catch(() => null);
        }
        await cancelWeexProtective(credsGate2, row.weex_symbol).catch(() => null);
        await sql`
          update auto_signals
          set status = 'skipped',
              close_reason = ${"Cancelled — one working limit at a time"},
              pnl = 0,
              updated_at = now()
          where id = ${row.id} and user_id = ${userId}
        `;
        notes.push(`${row.weex_symbol} extra limit cancelled — one parked ticket only`);
      }
      parked = leftoverWorking[0] ?? null;
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

    if (riskL >= SIDE_CAP && riskS >= SIDE_CAP) {
      const names = [
        ...liveN.map((p) => p.symbol.replace(/_/g, "").toUpperCase()),
        ...dbFilled.map((s) => s.weex_symbol),
      ];
      const beN = liveN.filter((p) => beNames.has(p.symbol.replace(/_/g, "").toUpperCase())).length;
      huntTape = [huntStatus, whyLive.length ? whyLive.join("\n") : ""].filter(Boolean).join("\n");
      notes.push(
        `${[...new Set(names)].join(" ")} · 2 long + 2 short at-risk. Next after TP1/BE. ${beN} leftover(s) · cap 6.`,
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
            scanUniverse(books, corrected.style, corrected.minRr, corrected.method),
            ledger,
          );
          const raw = corrected.id === "grow"
            ? rawAll.filter((s) => CORE_SET.has(s.weexSymbol))
            : rawAll;
          const busy = new Set(
            stillOpen.filter((s) => s.status === "filled").map((s) => s.weex_symbol),
          );
          const betaBook = (weexBook ?? [])
            .filter((p) => {
              const sym = p.symbol.replace(/_/g, "").toUpperCase();
              return (
                p.qty > 0 &&
                !flattened.has(p.symbol) &&
                !flattened.has(sym) &&
                !beNames.has(sym)
              );
            })
            .map((p) => ({
              weex: p.symbol.replace(/_/g, "").toUpperCase(),
              side: ((p as { side?: string }).side === "short" ? "short" : "long") as "long" | "short",
            }));

          let sized = null as ReturnType<typeof sizeSetup>;
          let spec = null as Awaited<ReturnType<typeof specFor>> | null;
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
          const compass = rules.marketBias(btc4, btcBook, btc15);
          const ordered = [...raw].sort((a, b) => {
            const aA = rules.eliteScalp(a.thesis ?? "", a.confidence ?? scoreToConf(a.score), bar.minConf) ? 1 : 0;
            const bA = rules.eliteScalp(b.thesis ?? "", b.confidence ?? scoreToConf(b.score), bar.minConf) ? 1 : 0;
            if (needS > 0 && needL === 0) {
              const as = a.side === "short" ? 1 : 0;
              const bs = b.side === "short" ? 1 : 0;
              if (as !== bs) return bs - as;
            }
            if (needL > 0 && needS === 0) {
              const al = a.side === "long" ? 1 : 0;
              const bl = b.side === "long" ? 1 : 0;
              if (al !== bl) return bl - al;
            }
            if (aA !== bA) return bA - aA;
            return (b.confidence ?? b.score) - (a.confidence ?? a.score);
          });
          let veto =
            needS > 0 && needL === 0
              ? "No A+ short this pass."
              : "No A+ this pass.";
          const whyNot: string[] = [];

          for (const pick of ordered) {
            const tag = `${pick.weexSymbol.replace("USDT", "")} ${pick.side} ${Math.round(pick.confidence ?? pick.score)}%`;
            const confNow = pick.confidence ?? scoreToConf(pick.score);
            const aPlus = rules.eliteScalp(pick.thesis ?? "", confNow, bar.minConf);
            if (compass.bias === "chop" && !aPlus) {
              whyNot.push(`${tag} chop — not an A+ scalp`);
              continue;
            }
            if (flattened.has(pick.weexSymbol) && !aPlus) {
              veto = `You flattened ${pick.weexSymbol}. Pause on that pair.`;
              whyNot.push(`${tag} flatten pause`);
              continue;
            }
            if (busy.has(pick.weexSymbol)) continue;
            if (pick.side === "long" && riskL >= SIDE_CAP) {
              whyNot.push(`${tag} long book full`);
              continue;
            }
            if (pick.side === "short" && riskS >= SIDE_CAP) {
              whyNot.push(`${tag} short book full`);
              continue;
            }
            const coin15 = await getWeexKlines(pick.weexSymbol, "15m", 48).catch(() => []);
            const trig = rules.ltfTrigger(pick.side, coin15);
            if (!trig.ok && !trig.wait) {
              veto = `${pick.weexSymbol} ${pick.side}: ${trig.reason}`;
              whyNot.push(`${tag} ${trig.reason}`);
              continue;
            }
            const diverges =
              aPlus ||
              rules.divergesFromBtc(pick.side, coin15, btc15) ||
              /double (top|bottom)|failed range/i.test(pick.thesis ?? "");
            if (compass.bias !== "chop") {
              if (pick.side !== compass.bias && !diverges) {
                veto = `${pick.weexSymbol} ${pick.side} vs BTC ${compass.bias} — not fading`;
                whyNot.push(`${tag} vs BTC ${compass.bias}`);
                continue;
              }
            } else if (!diverges) {
              veto = `${pick.weexSymbol} ${pick.side} — BTC chop, not A+`;
              whyNot.push(`${tag} BTC chop`);
              continue;
            }
            if (rules.blocksBeta(betaBook, { weex: pick.weexSymbol, side: pick.side }, { diverges })) {
              const same = betaBook.find((p) => p.side === pick.side);
              veto = same
                ? `Already ${riskL}L/${riskS}S at risk. ${pick.weexSymbol} ${pick.side} would be a 3rd same-side.`
                : "Same-side book is full.";
              whyNot.push(`${tag} 2 already on that side`);
              continue;
            }
            const fadeVsBook =
              (pick.side === "short" && compass.bias === "long") ||
              (pick.side === "long" && compass.bias === "short");
            if (fadeVsBook && !diverges) {
              veto = `${pick.weexSymbol} ${pick.side} skipped — BTC/book is the other way, coin 15m not fading`;
              whyNot.push(`${tag} not fading BTC`);
              continue;
            }
            if (!fadeVsBook && !aPlus) {
              const h4 = await getWeexFourHour(pick.weexSymbol).catch(() => []);
              if (!rules.htfAllows(pick.side, h4)) {
                veto = `HTF veto ${pick.weexSymbol} ${pick.side} — slot stays empty`;
                whyNot.push(`${tag} 4h veto`);
                continue;
              }
              if (!diverges && pick.weexSymbol !== "BTCUSDT" && !rules.btcLeads(pick.side, btc15)) {
                veto = `BTC 15m against ${pick.side} ${pick.weexSymbol} — not filling the slot`;
                whyNot.push(`${tag} BTC 15m against`);
                continue;
              }
              const daily = await getWeexKlines(pick.weexSymbol, "1d", 40).catch(() => []);
              if (daily.length >= 24 && !rules.htfAllows(pick.side, daily)) {
                veto = `Daily veto ${pick.weexSymbol} ${pick.side} — slot stays empty`;
                whyNot.push(`${tag} daily veto`);
                continue;
              }
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
            spec = await specFor(coinByWeex(pick.weexSymbol));
            const conf = pick.confidence ?? scoreToConf(pick.score);
            if (conf < bar.minConf) {
              veto = `${pick.weexSymbol} ${pick.side} conf ${conf}% below ${bar.minConf}% bar`;
              whyNot.push(`${tag} below ${bar.minConf}%`);
              continue;
            }
            if (parked && parked.weex_symbol === pick.weexSymbol && parked.side === pick.side) {
              whyNot.push(`${tag} already parked — leave the limit`);
              continue;
            }
            if (
              parked &&
              (parked.weex_symbol !== pick.weexSymbol || parked.side !== pick.side) &&
              conf < n(parked.confidence) + 2
            ) {
              veto = `Parked ${parked.weex_symbol} ${n(parked.confidence)}% limit. ${pick.weexSymbol} ${conf}% not enough to replace.`;
              whyNot.push(`${tag} parked limit better`);
              continue;
            }
            const timed0 = rules.withLtfEntry(pick, trig.pullback);
            const timed = trig.wait ? { ...timed0, entryType: "limit" as const } : timed0;
            sized = sizeSetup(timed, equity, corrected.marginPct, spec.maxLeverage);
            if (sized) break;
          }

          let tookLine =
            needS > 0 && needL === 0
              ? "No A+ short this pass (pin high, engulf, double top, climax, overbought, trend cooling). Slots stay empty."
              : veto;

          if (!sized || !spec) {
            notes.push(veto);
          } else if (parked && parked.weex_symbol === sized.weexSymbol && parked.side === sized.side) {
            notes.push(`Keep parked ${parked.weex_symbol} limit — not re-placing the same pair.`);
            tookLine = `Limit still working ${parked.weex_symbol} ${parked.side} — not a fill yet.`;
          } else {
            if (parked && credsGate2) {
              const { cancelWeexOrder, cancelWeexProtective } = await import("@/lib/weex.server");
              if (parked.client_oid) {
                await cancelWeexOrder(credsGate2, {
                  symbol: parked.weex_symbol,
                  clientOid: parked.client_oid,
                }).catch(() => null);
              }
              await cancelWeexProtective(credsGate2, parked.weex_symbol).catch(() => null);
              await sql`
                update auto_signals
                set status = 'skipped',
                    close_reason = ${`Replaced by ${sized.weexSymbol} ${sized.side} ${sized.confidence}% ${sized.entryType}`},
                    pnl = 0,
                    updated_at = now()
                where id = ${parked.id} and user_id = ${userId}
              `;
              notes.push(
                `Replaced ${parked.weex_symbol} ${n(parked.confidence)}% limit with ${sized.weexSymbol} ${sized.side} ${sized.confidence}% ${sized.entryType}`,
              );
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
              tookLine = `Skip ${sized.weexSymbol.replace("USDT", "")} — already a ticket.`;
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
              tookLine = `Skip ${sized.weexSymbol.replace("USDT", "")} — already a ticket.`;
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
              tookLine = `WEEX rejected ${sized.weexSymbol.replace("USDT", "")} ${sized.side} ${Math.round(sized.confidence)}% — ${(replies[0] ?? "empty").slice(0, 90)}`;
            } else {
              notes.push(
                `${corrected.name} ${sized.leverage}x ${sized.side} ${sized.weexSymbol} · ${sized.rr.toFixed(1)}R · conf ${sized.confidence}% · $${sized.marginUsd.toFixed(2)}`,
              );
              tookLine = rules.whyTookTrade({
                symbol: sized.weexSymbol,
                side: sized.side,
                conf: Math.round(sized.confidence),
                thesis: sized.thesis ?? "",
                bias: compass.bias,
              });
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
            if (status !== "error") opened += 1;
            }
            }
          }
          huntTape = [huntStatus, tookLine].filter(Boolean).join("\n");
        }
      }
    } else if (!settings.armed) {
      huntTape = huntStatus;
      notes.push("Disarmed. No new orders.");
    } else if (stillOpen.length >= LIVE_CAP) {
      huntTape = `${huntStatus}\nLive cap (6 names). Waiting on an exit.`;
      notes.push("Live cap (6 names). Waiting on an exit.");
    } else {
      huntTape = huntTape || huntStatus;
    }

    if (!huntTape) huntTape = huntStatus;

    const learned = [bar.note, ledger.note].filter(Boolean).join(" · ") || `${corrected.marginPct}% · ${corrected.minConf}%+ bar`;
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
    const stats = await closedStats(sql, context.userId, settings?.stats_from);
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
