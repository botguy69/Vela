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

/** Rebuild → $500: allow 15%. Normal desk 1–3. */
export function clampRiskPct(raw: number): number {
  if (!Number.isFinite(raw)) return 3;
  return Math.min(15, Math.max(1, raw));
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
  let want: 1 | 2 | 3 = 1;
  if (c >= 92) want = 3;
  else if (c >= 88) want = 2;
  else want = 1;
  return (want <= base ? want : base) as 1 | 2 | 3;
}

/** One-at-a-time 15% compound until equity hits rebuild target OR 10pm ET 2026-09-09. */
export const REBUILD_EQUITY_USD = 500;
export const REBUILD_MARGIN_PCT = 15;
/** 10:00pm America/Toronto Sep 9 2026 = 02:00 UTC Sep 10 (EDT). */
export const REBUILD_UNTIL_MS = Date.parse("2026-09-10T02:00:00.000Z");

export function inRebuildMode(accountUsd: number): boolean {
  if (!(Date.now() < REBUILD_UNTIL_MS)) return false;
  return Number.isFinite(accountUsd) && accountUsd > 0 && accountUsd < REBUILD_EQUITY_USD;
}

/** 15% single-seat while rebuilding; else conviction 1/2/3. */
export function deskMarginPct(confidence: number, accountUsd: number, baseMarginPct = 3): number {
  if (inRebuildMode(accountUsd)) return REBUILD_MARGIN_PCT;
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
  const marginUsd = accountUsd * (alloc / 100) * Math.min(1, Math.max(0.25, sizeMult));
  const notional = marginUsd * leverage;
  if (notional < 5) return null;

  const qty = notional / setup.entry;
  const stopDist = Math.abs(setup.entry - setup.stop);
  const stopAccountPct = stopDist > 0 ? (notional * (stopDist / setup.entry) / accountUsd) * 100 : 0;
  // Rebuild 15% + max lev can print a wide stopAccountPct on alts — allow up to 80% of wallet at stop (cross; unused backs it).
  const stopCap = alloc >= 10 ? 80 : 40;
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
