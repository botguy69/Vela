import assert from "node:assert/strict";
import { describe, it } from "node:test";

function n(v) {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}
function takeQtys(total, nTakes, precision, fmt) {
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
function feeBePx(side, entry, _mark, weexBe) {
  if (weexBe > 0) {
    if (side === "long" && weexBe >= entry) return weexBe;
    if (side === "short" && weexBe <= entry) return weexBe;
  }
  return side === "long" ? entry * 1.002 : entry * 0.998;
}
function fmtQty(q, p) {
  if (!Number.isFinite(q) || q <= 0) return "0";
  const step = 10 ** -p;
  return (Math.floor(q / step) * step).toFixed(p);
}
function shouldRestateAfterWipe(leftover) { return leftover <= 3; }

describe("takeQtys", () => {
  it("splits 80/20", () => assert.deepEqual(takeQtys(10, 2, 3, fmtQty), ["8.000", "2.000"]));
  it("tiny qty stays whole", () => assert.deepEqual(takeQtys(0.002, 2, 3, fmtQty), ["0.002"]));
  it("no zero remainder", () => assert.ok(takeQtys(1, 2, 0, fmtQty).every((s) => Number(s) > 0)));
});
describe("feeBePx", () => {
  it("uses WEEX BE on the right side", () => {
    assert.equal(feeBePx("long", 100, 101, 100.15), 100.15);
    assert.equal(feeBePx("long", 100, 101, 99.9), 100.2);
    assert.equal(feeBePx("short", 100, 99, 99.8), 99.8);
  });
});
describe("wipe leftover", () => {
  it("blocks restate when >3 leftover", () => {
    assert.equal(shouldRestateAfterWipe(4), false);
    assert.equal(shouldRestateAfterWipe(3), true);
  });
});
describe("n", () => {
  it("junk is 0", () => { assert.equal(n("12.5"), 12.5); assert.equal(n("nope"), 0); });
});

function taggedTake(side, last, target) {
  if (!(target > 0) || !(last > 0)) return false;
  return side === "long" ? last >= target * 0.999 : last <= target * 1.001;
}
function near(a, b) {
  return a > 0 && b > 0 && Math.abs(a - b) / b < 0.01;
}
function classifyAlgoRows(listed, side, mark) {
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
function planTakes(input) {
  const { side, entry: entryPx, mark, liveQty, planned, tp1Hit, beMoved, listed, pricePrecision, quantityPrecision, formatPx, formatQty } = input;
  const stopPx = input.stopOverride != null && input.stopOverride > 0 ? input.stopOverride : input.stop;
  const empty = { afterTp1: false, throughTp1: false, tps: [], wantTp: 2, slOk: false, tpOk: false, extras: false, collapsed: false, runnerLive: false, recentSet: false, noop: true, wipe: false, placeSl: false, placeTp: false, slices: [], beMove: false };
  if (!(liveQty > 0)) return empty;
  const beStop = entryPx > 0 && stopPx > 0 && Math.abs(stopPx - entryPx) / entryPx < 0.004;
  const riskFromStop = !beStop && stopPx > 0 && entryPx > 0 ? Math.abs(entryPx - stopPx) : 0;
  const riskFromTp = planned[0] && entryPx > 0 ? Math.abs(planned[0] - entryPx) : 0;
  const risk = riskFromStop >= entryPx * 0.003 ? riskFromStop : riskFromTp;
  const r1 = risk >= entryPx * 0.002 ? risk : planned[0] && entryPx > 0 ? Math.abs(planned[0] - entryPx) : entryPx * 0.008;
  const t1Guess = entryPx > 0 && r1 > 0 ? (side === "short" ? entryPx - r1 : entryPx + r1) : planned[0] ?? 0;
  const throughTp1 = mark > 0 && t1Guess > 0 && taggedTake(side, mark, t1Guess);
  const afterTp1 = Boolean(tp1Hit) || Boolean(beMoved) || throughTp1 || (input.origQty > 0 && liveQty < input.origQty * 0.85);
  const tick = 10 ** -Math.max(0, pricePrecision);
  const tps = [];
  const pushTp = (raw, force = false) => {
    let px = Number(formatPx(raw, pricePrecision));
    if (!(px > 0)) return;
    if (tps.includes(px)) px = Number(formatPx(side === "short" ? px - 2 * tick : px + 2 * tick, pricePrecision));
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
    if (afterTp1 && mark > 0 && taggedTake(side, mark, t2)) t2 = side === "short" ? mark * 0.992 : mark * 1.008;
    if (afterTp1) pushTp(t2, true);
    else {
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
  const distinctTp = tpRows.filter((r, i) => !tpRows.slice(0, i).some((o) => near(o.trigger, r.trigger))).length;
  const collapsed = !afterTp1 && tpRows.length >= 1 && distinctTp < 2;
  const tpOk = afterTp1 ? Boolean(runnerLive) : tpRows.length >= 2 && !collapsed;
  const extras = listed.length > 3 || slRows.length > 1 || tpRows.length > (afterTp1 ? 1 : 2) || collapsed;
  const setAt = Number(/tps:set@(\d+)/.exec(input.weexResp ?? "")?.[1] ?? 0);
  const recentSet = setAt > 0 && (input.now ?? Date.now()) - setAt < 5 * 60_000;
  const noop = slOk && tpOk && !extras;
  const wipe = !afterTp1 && (extras || listed.length > 3);
  const beMove = input.stopOverride != null && input.stopOverride > 0 && !slOk;
  const placeSl = stopPx > 0 && (extras || slRows.length !== 1 || !slOk);
  const placeTp = extras || !tpOk;
  const slices = takeQtys(liveQty, afterTp1 ? 1 : 2, quantityPrecision, formatQty);
  return { afterTp1, throughTp1, tps, wantTp, slOk, tpOk, extras, collapsed, runnerLive: Boolean(runnerLive), recentSet, noop, wipe, placeSl, placeTp, slices, beMove };
}
function fmtPx(px, p) {
  if (!Number.isFinite(px)) return "0";
  return px.toFixed(Math.max(0, p));
}
const base = {
  side: "long",
  entry: 100,
  stop: 98,
  mark: 100.2,
  liveQty: 10,
  origQty: 10,
  planned: [102, 104],
  tp1Hit: false,
  beMoved: false,
  listed: [],
  pricePrecision: 4,
  quantityPrecision: 3,
  formatPx: fmtPx,
  formatQty: fmtQty,
};
describe("planTakes", () => {
  it("fresh fill wants 2 TPs 80/20", () => {
    const p = planTakes(base);
    assert.equal(p.wantTp, 2);
    assert.equal(p.tps.length, 2);
    assert.deepEqual(p.slices, ["8.000", "2.000"]);
    assert.equal(p.placeSl, true);
  });
  it("after TP1 wants 1 runner", () => {
    const p = planTakes({ ...base, tp1Hit: true, mark: 102.2 });
    assert.equal(p.afterTp1, true);
    assert.equal(p.wantTp, 1);
    assert.equal(p.tps.length, 1);
  });
  it("reduced size counts as after TP1", () => {
    assert.equal(planTakes({ ...base, liveQty: 1.5, origQty: 10 }).afterTp1, true);
  });
  it("BE move does not wipe", () => {
    const p = planTakes({
      ...base,
      tp1Hit: true,
      beMoved: true,
      stopOverride: 100.15,
      mark: 102.1,
      listed: [
        { type: "SL", trigger: 98, posSide: "LONG" },
        { type: "TP", trigger: 104, posSide: "LONG" },
      ],
    });
    assert.equal(p.wipe, false);
    assert.equal(p.beMove, true);
  });
  it("collapsed TPs wipe", () => {
    const p = planTakes({
      ...base,
      listed: [
        { type: "SL", trigger: 98, posSide: "LONG" },
        { type: "TP", trigger: 102, posSide: "LONG" },
        { type: "TP", trigger: 102.05, posSide: "LONG" },
      ],
    });
    assert.equal(p.collapsed, true);
    assert.equal(p.wipe, true);
  });
  it("healthy book is noop", () => {
    const p = planTakes({
      ...base,
      weexResp: `tps:set@${Date.now() - 30000}`,
      listed: [
        { type: "SL", trigger: 98, posSide: "LONG" },
        { type: "TP", trigger: 102, posSide: "LONG" },
        { type: "TP", trigger: 104, posSide: "LONG" },
      ],
    });
    assert.equal(p.noop, true);
    assert.equal(p.recentSet, true);
  });
  it("bumps runner past mark after TP1", () => {
    const p = planTakes({ ...base, tp1Hit: true, mark: 104.5, planned: [102, 104] });
    assert.ok(p.tps[0] > 104.5);
  });
});
