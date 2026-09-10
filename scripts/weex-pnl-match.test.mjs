import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Mirror of coalesceWeexHit scoring — keep in sync with auto.ts */
function coalesceWeexHit(cands, orig, opts = {}) {
  if (!cands.length) return null;
  const real = cands.filter((c) => Math.abs(c.pnl) >= 0.05);
  const pool = real.length ? real : cands;
  const side = opts.side ?? "";
  const entry = opts.entry ?? 0;
  const score = (c) => {
    const q = c.qty && c.qty > 0 ? c.qty : orig;
    const px = c.closePx > 0 ? c.closePx : 0;
    const e = c.entry && c.entry > 0 ? c.entry : entry;
    const est =
      e > 0 && px > 0 && q > 0 ? (side === "short" ? (e - px) * q : (px - e) * q) : null;
    const notional = e > 0 && q > 0 ? e * q : Math.abs(est ?? 0);
    const feeBand = Math.max(0.35, notional * 0.0025);
    let s = 0;
    if (est != null) {
      const err = Math.abs(c.pnl - est);
      if (err <= feeBand) s += 100 - (err / feeBand) * 20;
      else s += Math.max(0, 40 - err);
      if (est < 0 && c.pnl <= est && c.pnl >= est - feeBand) s += 8;
      if (est > 0 && c.pnl <= est && c.pnl >= est - feeBand) s += 8;
    }
    if (orig > 0 && c.qty && c.qty > 0) {
      const qr = Math.abs(c.qty - orig) / orig;
      if (qr <= 0.08) s += 25;
      else if (qr <= 0.25) s += 10;
      else s -= 15;
    }
    s += Math.min(5, Math.abs(c.pnl) / 50);
    return s;
  };
  return [...pool].sort((a, b) => score(b) - score(a) || Math.abs(b.pnl) - Math.abs(a.pnl))[0] ?? null;
}

describe("WEEX PnL match", () => {
  it("prefers DOT history −12.63 over a wrong −5.90 partial", () => {
    const hit = coalesceWeexHit(
      [
        { symbol: "DOTUSDT", side: "long", pnl: -5.9, closePx: 1.0829, entry: 1.092, ts: 1, qty: 650 },
        { symbol: "DOTUSDT", side: "long", pnl: -12.6347, closePx: 1.0833, entry: 1.092, ts: 2, qty: 1329 },
      ],
      1329,
      { side: "long", entry: 1.092 },
    );
    assert.ok(hit);
    assert.equal(hit.pnl, -12.6347);
  });

  it("prefers tiny ALGO −0.05 over a bogus −1.77", () => {
    const hit = coalesceWeexHit(
      [
        { symbol: "ALGOUSDT", side: "long", pnl: -1.77, closePx: 0.09671, entry: 0.09711, ts: 1, qty: 4425 },
        { symbol: "ALGOUSDT", side: "long", pnl: -0.0523, closePx: 0.09671, entry: 0.09711, ts: 2, qty: 110 },
      ],
      110,
      { side: "long", entry: 0.09711 },
    );
    assert.ok(hit);
    assert.equal(hit.pnl, -0.0523);
  });
});
