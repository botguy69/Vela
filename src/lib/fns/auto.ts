import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { adaptMethod, GOAL_USD, STAGE2_USD, multipleToGoal, phaseForRun, progressPct, stageTarget } from "@/lib/goal";

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
  const peak = Math.max(n(row.peak_usd) || equity, equity);
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
  stats: { closed: number; wins: number; winRate?: number; avgWinR?: number; avgLossR?: number } = { closed: 0, wins: 0 },
  live?: { equity: number; available: number } | null,
  weexError?: string | null,
) {
  const liveEq = live?.equity;
  const equity = liveEq != null ? liveEq : 0;
  const peak = liveEq != null ? Math.max(n(row.peak_usd) || liveEq, liveEq) : 0;
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

async function closedStats(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
) {
  const rows = await sql<{
    pnl: string | number | null;
    entry: string | number | null;
    stop: string | number | null;
    qty: string | number | null;
    fill_px: string | number | null;
  }>`
    select pnl, entry, stop, qty, fill_px from auto_signals
    where user_id = ${userId} and status in ('stopped','targeted','skipped')
  `;
  const closed = rows.length;
  const wins = rows.filter((r) => n(r.pnl) > 0).length;
  const rs = rows
    .map((r) => {
      const entry = n(r.fill_px) || n(r.entry);
      const risk = Math.abs(entry - n(r.stop)) * n(r.qty);
      if (!(risk > 0)) return null;
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
    plan: row.plan,
    score: row.score == null ? null : n(row.score),
    confidence: row.confidence == null ? null : n(row.confidence),
    liveOnWeex: false,
    closeReason: inferClose(row),
    createdAt: row.created_at,
  };
}

async function ticketLedger(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
) {
  const rows = await sql<{
    plan: string | null;
    side: string | null;
    weex_symbol: string | null;
    pnl: string | number | null;
  }>`
    select plan, side, weex_symbol, pnl from auto_signals
    where user_id = ${userId} and status in ('stopped','targeted','skipped')
  `;
  const { buildLedger } = await import("@/lib/desk-rules");
  return buildLedger(
    rows.map((r) => ({
      plan: r.plan,
      side: r.side,
      weex: r.weex_symbol,
      pnl: n(r.pnl),
    })),
  );
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
    const stats = await closedStats(sql, context.userId);
    const signals = await sql<SignalRow>`
      select * from auto_signals where user_id = ${context.userId}
      order by created_at desc limit 40
    `;
    const mapped = signals.map(mapSignal);
    const { getWeexLast } = await import("@/lib/weex-market.server");
    const { ticketPnl } = await import("@/lib/ta");
    const lastBy = new Map<string, number>();
    const leftBy = new Map<string, number>();
    if (settings) {
      const creds = await credsFrom(settings);
      if (creds) {
        const { listWeexPositions } = await import("@/lib/weex.server");
        const livePos = await listWeexPositions(creds).catch(() => []);
        for (const p of livePos) {
          leftBy.set(p.symbol, p.qty);
          leftBy.set(p.symbol.replace(/_/g, "").toUpperCase(), p.qty);
        }
      }
    }
    for (const t of mapped) {
      const key = t.weexSymbol.replace(/_/g, "").toUpperCase();
      const left = leftBy.get(t.weexSymbol) ?? leftBy.get(key);
      if (left != null && left > 0) {
        t.liveOnWeex = true;
        if (t.status !== "working" && t.status !== "filled" && t.status !== "proposed") {
          t.status = "filled";
        }
      } else {
        t.liveOnWeex = false;
      }
      if (t.status !== "filled" && t.status !== "working") continue;
      if (!lastBy.has(t.weexSymbol)) {
        try {
          lastBy.set(t.weexSymbol, await getWeexLast(t.weexSymbol));
        } catch {
          lastBy.set(t.weexSymbol, 0);
        }
      }
      const last = lastBy.get(t.weexSymbol) ?? 0;
      const entry = t.fillPx ?? t.entry;
      if (last > 0 && entry > 0) {
        t.pnl = ticketPnl({
          side: t.side,
          entry,
          last,
          qty: t.qty,
          leftover: left ?? null,
          targets: t.targets,
          beMoved: t.beMoved,
        });
      }
    }
    return {
      settings: publicSettings(settings!, stats, live, pulled.error),
      signals: mapped,
      universe: await (await import("@/lib/weex-market.server")).universeCard(),
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
    const { scanUniverse, shouldLockBreakeven, breakevenPrice, scoreToConf } = await import("@/lib/ta");
    const { sizeSetup } = await import("@/lib/risk");
    const { coinByWeex, CORE_SET } = await import("@/lib/universe");
    const rules = await import("@/lib/desk-rules");
    const sql = await getSql();
    await ensureSettings(sql, userId);
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
    const stats = await closedStats(sql, userId);
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

    const open = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId} and status in ('proposed','working','filled')
    `;

    const notes: string[] = [];
    let closed = 0;
    let opened = 0;
    let equity = pub.accountUsd;
    let streak = pub.lossStreak;
    let winStreak = n((settings as SettingsRow).win_streak) || 0;
    let peak = pub.peakUsd;

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
        if (crossed) {
          await sql`
            update auto_signals
            set status = 'filled', fill_px = ${e}, filled_at = now(), updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          notes.push(`Filled ${pos.weex_symbol} limit`);
        }
        continue;
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
        const be = breakevenPrice(side, entry);
        const spec = await specFor(coinByWeex(pos.weex_symbol));
        const creds = await credsFrom(settings);
        let moved = false;
        if (creds) {
          const { moveWeexStop } = await import("@/lib/weex.server");
          const sent = await moveWeexStop(creds, {
            symbol: pos.weex_symbol,
            positionSide: side === "short" ? "SHORT" : "LONG",
            stop: formatWeexPx(be, spec.pricePrecision),
            clientOid: `velabe${pos.id}${Date.now().toString(36)}`.slice(0, 36),
          });
          moved = sent.ok;
          if (!sent.ok) notes.push(`${pos.weex_symbol} BE on WEEX failed: ${sent.error.slice(0, 80)}`);
        }
        if (moved || !creds) {
          await sql`
            update auto_signals
            set stop = ${be}, be_moved = true, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          if (moved) notes.push(`${pos.weex_symbol} stop to WEEX BE (fees covered)`);
        }
      } else if (pos.be_moved) {
        const hourly = await getWeexKlines(pos.weex_symbol, "1h", 40).catch(() => []);
        const next = rules.trailStop({ side, entry, stop, hourly });
        if (next != null) {
          const spec = await specFor(coinByWeex(pos.weex_symbol));
          const creds = await credsFrom(settings);
          if (creds) {
            const { moveWeexStop } = await import("@/lib/weex.server");
            await moveWeexStop(creds, {
              symbol: pos.weex_symbol,
              positionSide: side === "short" ? "SHORT" : "LONG",
              stop: formatWeexPx(next, spec.pricePrecision),
              clientOid: `velatr${pos.id}${Date.now().toString(36)}`.slice(0, 36),
            });
          }
          await sql`
            update auto_signals set stop = ${next}, updated_at = now()
            where id = ${pos.id} and user_id = ${userId}
          `;
          notes.push(`${pos.weex_symbol} trail ${next.toFixed(4)}`);
        }
      }

      const since = pos.filled_at ?? pos.created_at;
      const credsNow = await credsFrom(settings);
      let left: number | null = null;
      if (credsNow) {
        const { getWeexPositionQty } = await import("@/lib/weex.server");
        left = await getWeexPositionQty(credsNow, pos.weex_symbol);
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
          const spec = await specFor(coinByWeex(pos.weex_symbol));
          const be = breakevenPrice(side, entry);
          const creds = credsNow ?? (await credsFrom(settings));
          let moved = false;
          if (creds) {
            const { moveWeexStop } = await import("@/lib/weex.server");
            const sent = await moveWeexStop(creds, {
              symbol: pos.weex_symbol,
              positionSide: side === "short" ? "SHORT" : "LONG",
              stop: formatWeexPx(be, spec.pricePrecision),
              clientOid: `velabe${pos.id}${Date.now().toString(36)}`.slice(0, 36),
            });
            moved = sent.ok;
            if (!sent.ok) notes.push(`${pos.weex_symbol} chop BE failed: ${sent.error.slice(0, 80)}`);
          }
          if (moved || !creds) {
            await sql`
              update auto_signals
              set stop = ${be}, be_moved = true, updated_at = now()
              where id = ${pos.id} and user_id = ${userId}
            `;
            if (moved) notes.push(`${pos.weex_symbol} chop → WEEX BE (fees covered). Slot free.`);
          }
          continue;
        }
        if (act === "flatten") {
        if (credsNow && (left == null || left > 0)) {
          const spec = await specFor(coinByWeex(pos.weex_symbol));
          const { flattenWeex } = await import("@/lib/weex.server");
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
        }
        const pnl = side === "long" ? (px - entry) * n(pos.qty) : (entry - px) * n(pos.qty);
        const why =
          pnl < 0
            ? "Sold at a loss to move on — went nowhere"
            : "Took the chop — 16h, no TP1";
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
        if (left != null && left > 0) {
          notes.push(
            `${pos.weex_symbol} last tagged ${hitStop ? "SL" : "TP"} but WEEX still holds ${left}`,
          );
          continue;
        }
        const exit = hitStop ? stop : target;
        const pnl = side === "long" ? (exit - entry) * n(pos.qty) : (entry - exit) * n(pos.qty);
        const why = hitStop ? "Hit stop" : "Took profit";
        await sql`
          update auto_signals
          set status = ${hitStop ? "stopped" : "targeted"},
              closed_px = ${exit}, pnl = ${pnl}, close_reason = ${why}, updated_at = now()
          where id = ${pos.id} and user_id = ${userId}
        `;
        streak = pnl >= 0 ? 0 : streak + 1;
        winStreak = pnl >= 0 ? winStreak + 1 : 0;
        closed += 1;
        notes.push(`${pos.weex_symbol} ${why} ${pnl.toFixed(2)}`);
      }
    }

    const credsLive = await credsFrom(settings);
    if (credsLive) {
      const { listWeexPositions } = await import("@/lib/weex.server");
      const livePos = await listWeexPositions(credsLive);
      for (const lp of livePos) {
        const [row] = await sql<SignalRow>`
          select * from auto_signals
          where user_id = ${userId} and weex_symbol = ${lp.symbol}
          order by created_at desc
          limit 1
        `;
        if (!row) continue;
        if (row.status === "filled" || row.status === "working" || row.status === "proposed") {
          if (lp.qty > 0 && n(row.qty) > 0 && lp.qty < n(row.qty) * 0.98) {
            await sql`update auto_signals set qty = ${lp.qty}, updated_at = now() where id = ${row.id}`;
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
    }

    const refreshed = await pullWeexBook(settings);
    if (refreshed.live) {
      equity = refreshed.live.equity;
      peak = Math.max(peak, equity);
    } else {
      equity = Math.max(0.01, equity);
      peak = Math.max(peak, equity);
      if (refreshed.error) notes.push(refreshed.error);
    }
    const afterStats = { closed: stats.closed + closed, wins: stats.wins };
    const corrected = adaptMethod({
      phase: phaseForRun(equity, Boolean(settings.continue_to_goal)),
      lossStreak: streak,
      winStreak,
      lastMargin: n(settings.risk_pct) || 2,
      drawdownPct: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
      closed: afterStats.closed,
      wins: stats.wins,
    });

    const stillOpen = await sql<SignalRow>`
      select * from auto_signals
      where user_id = ${userId} and status in ('proposed','working','filled')
    `;
    const atRisk = stillOpen.filter((s) => s.status !== "filled" || !s.be_moved);
    const LIVE_CAP = 6;
    const ledger = await ticketLedger(sql, userId);
    const closedConf = await sql<{ confidence: string | number | null; pnl: string | number | null }>`
      select confidence, pnl from auto_signals
      where user_id = ${userId} and status in ('stopped','targeted','skipped')
    `;
    const bar = rules.confidenceBar(
      closedConf.map((r) => ({ conf: n(r.confidence), pnl: n(r.pnl) })),
      corrected.minConf,
    );

    if (settings.armed && atRisk.length < corrected.maxOpen && stillOpen.length < LIVE_CAP) {
      if (!(settings.api_key_enc && settings.api_secret_enc && settings.api_pass_enc)) {
        notes.push("Armed with no keys. Store keys on this page.");
      } else if (!live) {
        notes.push(pulled.error ?? "WEEX equity not readable. No new orders.");
      } else {
        const books = await loadTop25Hours();
        const btcBook = books.BTCUSDT ?? [];
        const regime = rules.regimeState(btcBook);
        if (regime.hot) {
          notes.push(`Regime: BTC shock wick (ATR ${regime.ratio.toFixed(1)}×). Standing down.`);
        } else {
          const rawAll = rules.applyLedger(
            scanUniverse(books, corrected.style, corrected.minRr, corrected.method),
            ledger,
          );
          const raw = corrected.id === "grow"
            ? rawAll.filter((s) => CORE_SET.has(s.weexSymbol))
            : rawAll;
          const busy = new Set(stillOpen.map((s) => s.weex_symbol));
          const betaBook = atRisk.map((s) => ({
            weex: s.weex_symbol,
            side: (s.side === "short" ? "short" : "long") as "long" | "short",
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
          let veto = raw.length
            ? `Setups seen (${raw.length}), none passed HTF/spread/funding/size. BTC RSI ${btcRsi.toFixed(0)} ATR ${regime.ratio.toFixed(1)}×.`
            : `No setup. BTC RSI ${btcRsi.toFixed(0)} last ${btcLast?.toFixed(0) ?? "?"} ATR ${regime.ratio.toFixed(1)}×.`;

          for (const pick of raw) {
            if (busy.has(pick.weexSymbol)) continue;
            if (rules.blocksBeta(betaBook, { weex: pick.weexSymbol, side: pick.side })) {
              const held = stillOpen[0];
              veto = held
                ? `Already ${held.side} ${held.weex_symbol}. Not adding another ${pick.side} on the same beta.`
                : "Same-way beta is full.";
              continue;
            }
            const h4 = await getWeexFourHour(pick.weexSymbol).catch(() => []);
            if (!rules.htfAllows(pick.side, h4)) {
              veto = `HTF veto ${pick.weexSymbol}`;
              continue;
            }
            const m15 = await getWeexKlines(pick.weexSymbol, "15m", 48).catch(() => []);
            if (!rules.ltfAllows(pick.side, m15)) {
              veto = `15m against ${pick.weexSymbol}`;
              continue;
            }
            if (pick.weexSymbol !== "BTCUSDT" && !rules.btcLeads(pick.side, btc15)) {
              veto = `BTC 15m against ${pick.side} ${pick.weexSymbol}`;
              continue;
            }
            const daily = await getWeexKlines(pick.weexSymbol, "1d", 40).catch(() => []);
            if (daily.length >= 24 && !rules.htfAllows(pick.side, daily)) {
              veto = `Daily veto ${pick.weexSymbol}`;
              continue;
            }
            const book = await getBookTicker(pick.weexSymbol);
            if (book && rules.spreadTooWide(pick.weexSymbol, book.bid, book.ask)) {
              veto = `Wide book ${pick.weexSymbol}`;
              continue;
            }
            const fund = await getFundingRate(pick.weexSymbol);
            if (fund != null && rules.fundingBlocks(pick.side, fund)) {
              veto = `Crowded funding ${pick.weexSymbol}`;
              continue;
            }
            spec = await specFor(coinByWeex(pick.weexSymbol));
            const conf = pick.confidence ?? scoreToConf(pick.score);
            if (conf < bar.minConf) {
              veto = `${pick.weexSymbol} conf ${conf}% below ${bar.minConf}% bar`;
              continue;
            }
            sized = sizeSetup(pick, equity, corrected.marginPct, spec.maxLeverage);
            if (sized) break;
          }

          if (!sized || !spec) {
            notes.push(veto);
          } else {
            const { placeWeexOrder, setCrossMaxLeverage } = await import("@/lib/weex.server");
            const creds = (await credsFrom(settings))!;
            await setCrossMaxLeverage(creds, sized.weexSymbol, sized.leverage);

            const tps = sized.targets.length ? sized.targets : [sized.target];
            const weights = sized.scale.length === tps.length ? sized.scale : tps.map(() => 1 / tps.length);
            const slices: { qty: string; tp: string; oid: string }[] = [];
            for (let i = 0; i < tps.length; i += 1) {
              const q = formatWeexQty(sized.qty * (weights[i] ?? 0), spec.quantityPrecision);
              if (Number(q) <= 0) continue;
              slices.push({
                qty: q,
                tp: formatWeexPx(tps[i]!, spec.pricePrecision),
                oid: `vela${Date.now().toString(36)}${i}${Math.floor(Math.random() * 99)}`.slice(0, 36),
              });
            }
            if (slices.length === 0) {
              const q = formatWeexQty(sized.qty, spec.quantityPrecision);
              if (Number(q) > 0) {
                slices.push({
                  qty: q,
                  tp: formatWeexPx(sized.target, spec.pricePrecision),
                  oid: `vela${Date.now().toString(36)}`.slice(0, 36),
                });
              }
            }

            const replies: string[] = [];
            let okAny = false;
            for (const slice of slices) {
              const sent = await placeWeexOrder(creds, false, {
                symbol: sized.weexSymbol,
                side: sized.side === "long" ? "BUY" : "SELL",
                positionSide: sized.side === "long" ? "LONG" : "SHORT",
                type: sized.entryType === "market" ? "MARKET" : "LIMIT",
                quantity: slice.qty,
                price: formatWeexPx(sized.entry, spec.pricePrecision),
                clientOid: slice.oid,
                tp: slice.tp,
                sl: formatWeexPx(sized.stop, spec.pricePrecision),
              });
              replies.push(sent.ok ? JSON.stringify(sent.data).slice(0, 180) : sent.error.slice(0, 180));
              if (sent.ok) okAny = true;
            }

            const weexResp = replies.join(" | ").slice(0, 500);
            const status = okAny ? (sized.entryType === "market" ? "filled" : "working") : "error";
            const fillPx = status === "filled" ? sized.entry : null;
            const clientOid = slices[0]?.oid ?? `vela${Date.now().toString(36)}`.slice(0, 36);
            if (!okAny) notes.push(`WEEX reject ${sized.weexSymbol}: ${replies[0]?.slice(0, 80) ?? "empty"}`);
            else {
              notes.push(
                `${corrected.name} ${sized.leverage}x ${sized.side} ${sized.weexSymbol} · ${sized.rr.toFixed(1)}R · conf ${sized.confidence}% · $${sized.marginUsd.toFixed(2)}`,
              );
            }

            const filledAt = status === "filled" ? new Date().toISOString() : null;
            await sql`
              insert into auto_signals (
                user_id, symbol, weex_symbol, side, style, entry_type, entry, stop, target,
                qty, leverage, risk_usd, notional, rr, thesis, invalidation, status, venue,
                client_oid, weex_resp, fill_px, targets, scale, plan, filled_at, score, confidence
              ) values (
                ${userId}, ${sized.symbol}, ${sized.weexSymbol}, ${sized.side}, ${sized.style},
                ${sized.entryType}, ${sized.entry}, ${sized.stop}, ${sized.target}, ${sized.qty},
                ${Math.round(sized.leverage)}, ${sized.riskUsd}, ${sized.notional}, ${sized.rr},
                ${sized.thesis}, ${sized.invalidation}, ${status}, 'weex', ${clientOid}, ${weexResp}, ${fillPx},
                ${JSON.stringify(tps)}, ${JSON.stringify(weights)}, ${sized.plan}, ${filledAt},
                ${sized.score}, ${sized.confidence}
              )
            `;
            if (status !== "error") opened += 1;
          }
        }
      }
    } else if (!settings.armed) {
      notes.push("Disarmed. No new orders.");
    } else if (stillOpen.length >= LIVE_CAP) {
      notes.push("Live cap (6 names). Waiting on an exit.");
    } else {
      notes.push(
        `${atRisk.length} at-risk / ${stillOpen.length} live. BE lock frees a slot for the next long or short.`,
      );
    }

    const learned = [corrected.note, bar.note, ledger.note].filter(Boolean).join(" · ");
    const note = [learned, ...notes].filter(Boolean).slice(0, 6).join(" · ");
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
    const stats = await closedStats(sql, context.userId);
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
