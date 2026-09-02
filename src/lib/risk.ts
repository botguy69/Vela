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

export function clampRiskPct(raw: number): number {
  if (!Number.isFinite(raw)) return 3;
  return Math.min(3, Math.max(1, raw));
}

/** 3% of the book is margin (1.8% after 3 losses). Notional = margin × coin max leverage on cross. */
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
  if (stopAccountPct > 40) return null;

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
