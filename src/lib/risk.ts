import type { RawSetup } from "./ta";

export type SizedSetup = RawSetup & {
  riskPct: number;
  marginUsd: number;
  riskUsd: number;
  notional: number;
  qty: number;
  leverage: number;
  stopAccountPct: number;
};

/** Solo desk: 3% one-at-a-time (user 2026-09-15). Max lev always. */
export function clampRiskPct(raw: number): number {
  if (!Number.isFinite(raw)) return 3;
  return Math.min(12, Math.max(1, raw));
}

/** Snap to discretionary 1 / 2 / 3% of book. Cap 3%. */
export function discreteMarginCap(raw: number): 1 | 2 | 3 {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  if (raw < 1.5) return 1;
  if (raw < 2.5) return 2;
  return 3;
}

/** Map setup confidence against phase base into discrete 1|2|3% margin. */
export function marginForConviction(confidence: number, baseMarginPct = 3): 1 | 2 | 3 {
  const base = discreteMarginCap(baseMarginPct);
  const c = Number.isFinite(confidence) ? confidence : 0;
  // A++ (>=85) is 3%. Loss-streak phase can cap at 2%. Never 1% on a live A++.
  const want: 1 | 2 | 3 = c >= 85 ? 3 : 2;
  return (want <= base ? want : base) as 1 | 2 | 3;
}

/** Seat units burned by a margin %. 3→1, 6→2, 9→3, 12→4. */
export function seatUnits(marginPct: number): number {
  if (!Number.isFinite(marginPct) || marginPct <= 0) return 1;
  return Math.max(1, Math.round(marginPct / 3));
}

/** Always 3% one seat (user 2026-09-15). fat12/recover6 kept for type compat. */
export type SizeCycle = "fat12" | "recover6";

export function sizeCycleFromCloses(
  _rows: {
    status?: string | null;
    pnl?: number | null;
    close_reason?: string | null;
    weex_symbol?: string | null;
  }[],
): SizeCycle {
  void _rows;
  return "recover6";
}

/** 3% one-at-a-time: 91%+. */
export function cycleMinConf(cycle: SizeCycle): number {
  void cycle;
  return 91;
}

export function concentrateMargin(
  conf: number,
  freeUnits: number,
  cycle: SizeCycle = "recover6",
): number {
  void cycle;
  const c = Number.isFinite(conf) ? conf : 0;
  if (c < 91) return 0;
  if (freeUnits >= 1) return 3;
  return 0;
}



/** Rebuild 15% ended early 2026-09-09 per user — back to 1/2/3% max. Keep helpers for history. */
export const REBUILD_EQUITY_USD = 500;
export const REBUILD_MARGIN_PCT = 15;
/** Ended immediately (was 10pm ET Sep 9). */
export const REBUILD_UNTIL_MS = Date.parse("2026-09-09T19:00:00.000Z");

export function inRebuildMode(accountUsd: number): boolean {
  if (!(Date.now() < REBUILD_UNTIL_MS)) return false;
  return Number.isFinite(accountUsd) && accountUsd > 0 && accountUsd < REBUILD_EQUITY_USD;
}

/** Default 1/2/3. Prefer concentrateMargin when free seat units are known. */
export function deskMarginPct(confidence: number, accountUsd: number, baseMarginPct = 3): number {
  void accountUsd;
  return marginForConviction(confidence, baseMarginPct);
}

/** 3% of the book is margin (2% after 3 losses, 1% after 5). Notional = margin × coin max leverage on cross.
 * Leverage MUST remain coin max — size down margin / trade count on risk, never the lev. */

export function sizeSetup(
  setup: RawSetup,
  accountUsd: number,
  riskPct: number,
  coinMaxLev: number,
  sizeMult = 1,
): SizedSetup | null {
  const alloc = clampRiskPct(riskPct);
  if (setup.entry <= 0 || accountUsd < 1) return null;

  const leverage = Math.max(1, Math.round(coinMaxLev));
  // Punch floor: skip toys under 75x. Still always pair max lev when we take it.
  if (leverage < 75) return null;
  const marginUsd = accountUsd * (alloc / 100) * Math.min(1, Math.max(0.25, sizeMult));
  const notional = marginUsd * leverage;
  if (notional < 5) return null;

  const qty = notional / setup.entry;
  const stopDist = Math.abs(setup.entry - setup.stop);
  const stopPct = setup.entry > 0 && stopDist > 0 ? stopDist / setup.entry : 0;
  // Fat 12% seats: stop 1–2% of price + ≥1.1R (single take 1.1–2R).
  // 6% seats: allow stop up to 2% (was 1.8%) so A++ with slightly wide structure still sizes.
  if (alloc >= 10) {
    if (stopPct < 0.01 || stopPct > 0.02) return null;
    const rr = stopDist > 0 ? Math.abs(setup.target - setup.entry) / stopDist : 0;
    if (!(rr >= 1.1)) return null;
  } else if (stopPct > 0.02) {
    return null;
  }
  const stopAccountPct = stopDist > 0 ? (notional * (stopDist / setup.entry) / accountUsd) * 100 : 0;
  const stopCap = alloc >= 10 ? 80 : Math.max(12, alloc * 3);
  if (stopAccountPct > stopCap) return null;

  return {
    ...setup,
    riskPct: alloc,
    marginUsd,
    riskUsd: marginUsd,
    notional,
    qty,
    leverage,
    stopAccountPct,
  };
}
