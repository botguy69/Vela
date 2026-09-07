import { taggedTake, type Side } from "./ta";

export function n(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function parseNums(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  } catch {
    return [];
  }
}

/** Full size from notional — qty is shrunk after TP1. */
export function origQty(row: {
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

export function takeQtys(
  total: number,
  nTakes: number,
  precision: number,
  fmt: (q: number, p: number) => string,
): string[] {
  const count = Math.max(1, nTakes);
  const min = Number(fmt(10 ** -Math.max(0, precision), precision));
  if (count < 2 || !(total > min * 2)) return [fmt(total, precision)];
  let first = Number(fmt(total * 0.8, precision));
  if (!(first > 0) || first >= total - min * 0.5) first = Number(fmt(total - min, precision));
  if (!(first > 0) || first >= total) first = Number(fmt(total / 2, precision));
  const rest = Number(fmt(Math.max(0, total - first), precision));
  if (!(rest > 0)) return [fmt(total, precision)];
  return [fmt(first, precision), fmt(rest, precision)];
}

/** 1R in dollars: original stop × full size. BE stop is not 1R. */
export function oneRUsd(row: {
  qty?: string | number | null;
  notional?: string | number | null;
  fill_px?: string | number | null;
  entry?: string | number | null;
  stop?: string | number | null;
  targets?: string | null;
  be_moved?: boolean | null;
  rr?: string | number | null;
  target?: string | number | null;
  risk_usd?: string | number | null;
}): number {
  const e = n(row.fill_px) || n(row.entry);
  const q = origQty(row);
  const stop = n(row.stop);
  const beLike = Boolean(row.be_moved) || (e > 0 && stop > 0 && Math.abs(stop - e) / e < 0.004);
  let dist = !beLike && e > 0 && stop > 0 ? Math.abs(e - stop) : 0;
  const tp1 = parseNums(row.targets)[0];
  if (!(dist > 0) && tp1 != null && e > 0) dist = Math.abs(tp1 - e);
  if (!(dist > 0) && n(row.rr) > 0.2 && n(row.target) > 0 && e > 0) dist = Math.abs(n(row.target) - e) / n(row.rr);
  const fromStop = e > 0 && q > 0 && dist > 0 ? dist * q : 0;
  if (fromStop >= 0.2) return fromStop;
  const risk = n(row.risk_usd);
  if (risk >= 0.2) return risk;
  return fromStop;
}

export function feeBePx(side: "long" | "short", entry: number, _mark: number, weexBe: number): number {
  if (weexBe > 0) {
    if (side === "long" && weexBe >= entry) return weexBe;
    if (side === "short" && weexBe <= entry) return weexBe;
  }
  return side === "long" ? entry * 1.002 : entry * 0.998;
}

export type AlgoRow = {
  type: string;
  trigger: number;
  posSide?: string;
};

export type TakePlan = {
  afterTp1: boolean;
  throughTp1: boolean;
  tps: number[];
  wantTp: number;
  slOk: boolean;
  tpOk: boolean;
  extras: boolean;
  collapsed: boolean;
  runnerLive: boolean;
  recentSet: boolean;
  noop: boolean;
  wipe: boolean;
  placeSl: boolean;
  placeTp: boolean;
  slices: string[];
  beMove: boolean;
};

function near(a: number, b: number): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) / b < 0.01;
}

export function classifyAlgoRows(
  listed: AlgoRow[],
  side: Side,
  mark: number,
): { slRows: AlgoRow[]; tpRows: AlgoRow[] } {
  const liveSide = side === "short" ? "SHORT" : "LONG";
  const slRows = listed.filter((r) => {
    if (r.posSide && r.posSide !== liveSide) return false;
    if (/TAKE|PROFIT|^TP$/i.test(r.type) && !/STOP|LOSS/i.test(r.type)) return false;
    if (/STOP|LOSS|^SL$/i.test(r.type)) return true;
    return mark > 0 && r.trigger > 0 && (side === "long" ? r.trigger < mark * 0.999 : r.trigger > mark * 1.001);
  });
  const tpRows = listed.filter((r) => {
    if (r.posSide && r.posSide !== liveSide) return false;
    if (/STOP|LOSS|^SL$/i.test(r.type) && !/TAKE|PROFIT/i.test(r.type)) return false;
    if (/TAKE|PROFIT|^TP$/i.test(r.type)) return true;
    return mark > 0 && r.trigger > 0 && (side === "long" ? r.trigger > mark * 1.001 : r.trigger < mark * 0.999);
  });
  return { slRows, tpRows };
}

export function shouldRestateAfterWipe(leftover: number): boolean {
  return leftover <= 3;
}

export function planTakes(input: {
  side: Side;
  entry: number;
  stop: number;
  mark: number;
  liveQty: number;
  origQty: number;
  planned: number[];
  tp1Hit: boolean;
  beMoved: boolean;
  listed: AlgoRow[];
  weexResp?: string;
  now?: number;
  pricePrecision: number;
  quantityPrecision: number;
  formatPx: (px: number, p: number) => string;
  formatQty: (q: number, p: number) => string;
  stopOverride?: number;
}): TakePlan {
  const {
    side,
    entry: entryPx,
    mark,
    liveQty,
    planned,
    tp1Hit,
    beMoved,
    listed,
    pricePrecision,
    quantityPrecision,
    formatPx,
    formatQty,
  } = input;
  const stopPx = input.stopOverride != null && input.stopOverride > 0 ? input.stopOverride : input.stop;
  const empty: TakePlan = {
    afterTp1: false,
    throughTp1: false,
    tps: [],
    wantTp: 2,
    slOk: false,
    tpOk: false,
    extras: false,
    collapsed: false,
    runnerLive: false,
    recentSet: false,
    noop: true,
    wipe: false,
    placeSl: false,
    placeTp: false,
    slices: [],
    beMove: false,
  };
  if (!(liveQty > 0)) return empty;

  const beStop = entryPx > 0 && stopPx > 0 && Math.abs(stopPx - entryPx) / entryPx < 0.004;
  const riskFromStop = !beStop && stopPx > 0 && entryPx > 0 ? Math.abs(entryPx - stopPx) : 0;
  const riskFromTp = planned[0] && entryPx > 0 ? Math.abs(planned[0] - entryPx) : 0;
  const risk = riskFromStop >= entryPx * 0.003 ? riskFromStop : riskFromTp;
  const r1 =
    risk >= entryPx * 0.002
      ? risk
      : planned[0] && entryPx > 0
        ? Math.abs(planned[0] - entryPx)
        : entryPx * 0.008;
  const t1Guess = entryPx > 0 && r1 > 0 ? (side === "short" ? entryPx - r1 : entryPx + r1) : planned[0] ?? 0;
  const throughTp1 = mark > 0 && t1Guess > 0 && taggedTake(side, mark, t1Guess);
  const afterTp1 =
    Boolean(tp1Hit) || Boolean(beMoved) || throughTp1 || (input.origQty > 0 && liveQty < input.origQty * 0.85);

  const tick = 10 ** -Math.max(0, pricePrecision);
  const tps: number[] = [];
  const pushTp = (raw: number, force = false) => {
    let px = Number(formatPx(raw, pricePrecision));
    if (!(px > 0)) return;
    if (tps.includes(px)) {
      px = Number(formatPx(side === "short" ? px - 2 * tick : px + 2 * tick, pricePrecision));
    }
    if (!(px > 0) || tps.includes(px)) return;
    if (!force && mark > 0 && taggedTake(side, mark, px)) return;
    tps.push(px);
  };
  if (entryPx > 0 && r1 > 0) {
    const t1 = side === "short" ? entryPx - r1 : entryPx + r1;
    const twoR = side === "short" ? entryPx - 2 * r1 : entryPx + 2 * r1;
    const plannedFar = planned.find((p) => Math.abs(p - t1) / Math.max(t1, 1) > 0.004);
    let t2 = plannedFar && plannedFar > 0 ? plannedFar : twoR;
    if (side === "short" ? t2 >= t1 : t2 <= t1) t2 = twoR;
    if (afterTp1) {
      if (!(mark > 0 && taggedTake(side, mark, t2))) pushTp(t2, true);
    } else {
      pushTp(t1, true);
      pushTp(t2, true);
    }
  }

  const { slRows, tpRows } = classifyAlgoRows(listed, side, mark);
  const slOk = slRows.length === 1 && (stopPx <= 0 || slRows.some((r) => near(r.trigger, stopPx)));
  const wantTp = afterTp1 ? 1 : 2;
  const runnerPx = afterTp1 ? tps[0] ?? planned[1] ?? 0 : 0;
  const runnerLive =
    afterTp1 &&
    tpRows.some(
      (r) =>
        mark > 0 &&
        (side === "long" ? r.trigger > mark : r.trigger < mark) &&
        (runnerPx <= 0 || near(r.trigger, runnerPx) || (planned[1] != null && near(r.trigger, planned[1]))),
    );
  const distinctTp = tpRows.filter(
    (r, i) => !tpRows.slice(0, i).some((o) => near(o.trigger, r.trigger)),
  ).length;
  const collapsed = !afterTp1 && tpRows.length >= 1 && distinctTp < 2;
  const tpOk = afterTp1 ? Boolean(runnerLive) : tpRows.length >= 2 && !collapsed;
  const extras =
    listed.length > 3 || slRows.length > 1 || tpRows.length > (afterTp1 ? 1 : 2) || collapsed;
  const setAt = Number(/tps:set@(\d+)/.exec(input.weexResp ?? "")?.[1] ?? 0);
  const recentSet = setAt > 0 && (input.now ?? Date.now()) - setAt < 5 * 60_000;
  const quiet =
    recentSet &&
    slRows.length === 1 &&
    tpRows.length >= (afterTp1 ? 1 : 2) &&
    !collapsed;
  const noop = quiet || (slOk && tpOk && !extras);
  const wipe = !afterTp1 && !quiet && (extras || listed.length > 3);
  const beMove = input.stopOverride != null && input.stopOverride > 0 && !slOk;
  const placeSl = !quiet && stopPx > 0 && (extras || slRows.length !== 1 || !slOk);
  const placeTp = !quiet && (extras || !tpOk);
  const slices = takeQtys(liveQty, afterTp1 ? 1 : 2, quantityPrecision, formatQty);

  return {
    afterTp1,
    throughTp1,
    tps,
    wantTp,
    slOk,
    tpOk,
    extras,
    collapsed,
    runnerLive: Boolean(runnerLive),
    recentSet,
    noop,
    wipe,
    placeSl,
    placeTp,
    slices,
    beMove,
  };
}
