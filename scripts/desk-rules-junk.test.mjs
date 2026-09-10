/**
 * Desk rule contracts — self-contained mirrors of src/lib/desk-rules.ts
 * (same pattern as desk-takes.test.mjs: node --test, no TS loader).
 * Mirrors: eliteScalp, setupQuality/aPlusKind, htfAllows thin fail-closed,
 * ltfTrigger thin 15m, mixAllows, huntRank/locationScore/sessionSoft.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// --- mirrors desk-rules ---

function aPlusKind(thesis) {
  const t = thesis;
  if (/double (top|bottom)|buyers on 2nd|supply on 2nd|vol fade/i.test(t)) return "double";
  if (/Failed bounce|lower high/i.test(t)) return "failed bounce";
  if (/failed range/i.test(t)) return "failed range";
  if (/Pin bar/i.test(t)) return "pin";
  if (/engulf/i.test(t)) return "engulf";
  if (/climax rejection/i.test(t)) return "climax";
  if (/With-trend 1h/i.test(t)) return "with-trend";
  if (/Dry-up at/i.test(t)) return "dry-up";
  if (/washout RSI/i.test(t)) return "washout";
  if (/Trend cooling/i.test(t)) return "trend cooling";
  if (/Oversold bounce RSI (1\d|2[0-8])/i.test(t)) return "oversold";
  if (/Overbought RSI (7[0-9]|8\d)/i.test(t)) return "overbought";
  if (/Continuation/i.test(t)) return "continuation";
  return null;
}

function setupQuality(thesis) {
  const k = aPlusKind(thesis);
  if (k === "continuation" || k === "failed bounce") return -1;
  if (k === "double" || k === "pin" || k === "engulf" || k === "failed range" || k === "climax") return 2;
  if (k === "with-trend") return 1;
  return 0;
}

function fadeAtExtreme(thesis, side) {
  if (side === "short") {
    return /double top|Failed range high|Pin bar at high|climax rejection at high/i.test(thesis);
  }
  return /double bottom|Failed range low|Pin bar at low|climax rejection at low/i.test(thesis);
}

function eliteScalp(thesis, conf, bar, bias) {
  const floor = Math.max(85, bar);
  if (
    /Failed bounce|lower high|Continuation (on|short on) 21h|Oversold bounce|washout RSI|Trend cooling|Dry-up at|With-trend 1h|Swing hold/i.test(
      thesis,
    )
  )
    return false;
  const structure =
    /double (top|bottom)|failed range|vol fade|climax rejection|Pin bar|engulf|buyers on 2nd|supply on 2nd/i.test(
      thesis,
    );
  if (!(structure && conf >= floor)) return false;
  const side = /^long\b/i.test(thesis) ? "long" : /^short\b/i.test(thesis) ? "short" : null;
  if ((bias === "long" || bias === "short") && side && side !== bias && !fadeAtExtreme(thesis, side)) {
    return false;
  }
  return true;
}

/** mirrors htfAllows thin fail-closed (desk-rules: fourHour.length < 24 → false) */
function htfAllowsThinFailClosed(fourHour) {
  if (fourHour.length < 24) return false;
  return true; // only asserting thin gate here
}

/** mirrors ltfTrigger thin 15m (desk-rules) */
function ltfTriggerThin(fifteen) {
  if (fifteen.length < 24) return { ok: false, wait: false, reason: "thin 15m", pullback: null };
  return { ok: true, wait: false, reason: "ok", pullback: null };
}

function mixAllows(pickSide, thesis, _conf, heat, _live) {
  if ((heat === "long" || heat === "short") && pickSide !== heat && !fadeAtExtreme(thesis, pickSide)) {
    return { ok: false, why: `against ${heat} book` };
  }
  return { ok: true, why: "coin tape" };
}

function closedCandles(candles, intervalMs) {
  if (!candles.length) return [];
  const last = candles[candles.length - 1];
  const age = Date.now() - last.time;
  if (age < intervalMs) return candles.slice(0, -1);
  return candles;
}

const FOUR_H_MS = 4 * 60 * 60 * 1000;

function locationScore(side, fourHour) {
  if (fourHour.length < 16) return 40;
  const closed = closedCandles(fourHour, FOUR_H_MS);
  const bars = closed.length >= 16 ? closed : fourHour;
  const last = fourHour[fourHour.length - 1]?.close ?? bars[bars.length - 1]?.close;
  if (last == null) return 40;
  const win = bars.slice(-21);
  const sh = Math.max(...win.map((c) => c.high));
  const sl = Math.min(...win.map((c) => c.low));
  const span = sh - sl;
  if (!(span > 0)) return 40;
  const loc = (last - sl) / span;
  return Math.round(100 * (side === "short" ? loc : 1 - loc));
}

function sessionSoft(thesis, now = new Date()) {
  if (!/with-trend|Continuation on 21h|Continuation short/i.test(thesis)) return 0;
  const utc = now.getUTCHours();
  const dow = now.getUTCDay();
  let pen = 0;
  if (dow === 0) pen += 14;
  if (utc >= 3 && utc <= 8) pen += 10;
  return pen;
}

function huntRank(opts) {
  const q = setupQuality(opts.thesis) * 14;
  const loc = locationScore(opts.side, opts.fourHour);
  const sess = sessionSoft(opts.thesis);
  const c = Number.isFinite(opts.conf) ? opts.conf - 85 : 0;
  return q + loc + c - sess;
}

function candle(t, o, h, l, c) {
  return { time: t, open: o, high: h, low: l, close: c, volume: 100 };
}

/** Tiny 4h fixture: last near box low → long location high, short location low. */
function lowBox4h(n = 21) {
  const out = [];
  const base = Date.now() - n * FOUR_H_MS;
  for (let i = 0; i < n; i++) {
    const mid = 100;
    const hi = mid + 10;
    const lo = mid - 10;
    const close = i === n - 1 ? lo + 0.5 : mid;
    out.push(candle(base + i * FOUR_H_MS, mid, hi, lo, close));
  }
  return out;
}

function highBox4h(n = 21) {
  const out = [];
  const base = Date.now() - n * FOUR_H_MS;
  for (let i = 0; i < n; i++) {
    const mid = 100;
    const hi = mid + 10;
    const lo = mid - 10;
    const close = i === n - 1 ? hi - 0.5 : mid;
    out.push(candle(base + i * FOUR_H_MS, mid, hi, lo, close));
  }
  return out;
}

describe("swing-hold quality / ungated flip rejected", () => {
  it("Swing hold is not location structure (quality < 2)", () => {
    assert.equal(setupQuality("Swing hold long — SL last low, TP last high"), 0);
    assert.ok(setupQuality("Swing hold long — SL last low, TP last high") < 2);
  });
  it("eliteScalp rejects Swing hold even at high conf", () => {
    assert.equal(eliteScalp("long Swing hold — SL last low", 95, 85, "long"), false);
    assert.equal(eliteScalp("Swing hold short — SL last high", 99, 85, "chop"), false);
  });
  it("double structure still clears quality + elite", () => {
    assert.equal(setupQuality("long double bottom at demand"), 2);
    assert.equal(eliteScalp("long double bottom at demand", 90, 85, "long"), true);
  });
});

describe("thin 4h/15m fail-closed", () => {
  it("htfAllows fail-closed when 4h thin", () => {
    assert.equal(htfAllowsThinFailClosed([]), false);
    assert.equal(htfAllowsThinFailClosed(Array.from({ length: 23 }, (_, i) => candle(i, 1, 1, 1, 1))), false);
    assert.equal(htfAllowsThinFailClosed(Array.from({ length: 24 }, (_, i) => candle(i, 1, 1, 1, 1))), true);
  });
  it("ltfTrigger thin 15m", () => {
    const thin = ltfTriggerThin([]);
    assert.equal(thin.ok, false);
    assert.equal(thin.reason, "thin 15m");
    const thin23 = ltfTriggerThin(Array.from({ length: 23 }, (_, i) => candle(i, 1, 1, 1, 1)));
    assert.equal(thin23.ok, false);
    assert.match(thin23.reason, /thin 15m/);
  });
});

describe("with-trend not elite A++", () => {
  it("eliteScalp rejects With-trend 1h", () => {
    assert.equal(eliteScalp("long With-trend 1h continuation", 95, 85, "long"), false);
  });
  it("setupQuality ranks with-trend below structure (1 < 2)", () => {
    assert.equal(setupQuality("long With-trend 1h"), 1);
    assert.ok(setupQuality("long With-trend 1h") < 2);
    assert.equal(aPlusKind("long With-trend 1h"), "with-trend");
  });
});

describe("mixAllows / huntRank book bias", () => {
  it("mixAllows rejects against-book without fade", () => {
    const r = mixAllows("short", "short With-trend 1h", 90, "long", []);
    assert.equal(r.ok, false);
    assert.match(r.why, /against long book/);
  });
  it("mixAllows allows fade at extreme against book", () => {
    const r = mixAllows("short", "short double top at supply", 90, "long", []);
    assert.equal(r.ok, true);
  });
  it("mixAllows ok when heat chop", () => {
    assert.equal(mixAllows("long", "long pin bar", 90, "chop", []).ok, true);
  });
  it("huntRank prefers structure at good location over with-trend", () => {
    const box = lowBox4h();
    const doubleRank = huntRank({
      thesis: "long double bottom at demand",
      side: "long",
      fourHour: box,
      conf: 90,
    });
    const trendRank = huntRank({
      thesis: "long With-trend 1h",
      side: "long",
      fourHour: box,
      conf: 90,
    });
    assert.ok(doubleRank > trendRank, `double ${doubleRank} vs with-trend ${trendRank}`);
  });
  it("huntRank location: long scores higher at box low than box high", () => {
    const low = huntRank({ thesis: "long pin bar", side: "long", fourHour: lowBox4h(), conf: 90 });
    const high = huntRank({ thesis: "long pin bar", side: "long", fourHour: highBox4h(), conf: 90 });
    assert.ok(low > high, `low-box ${low} vs high-box ${high}`);
  });
});


describe("stopOnWrongSide", () => {
  function stopOnWrongSide(side, entry, stop) {
    if (!(entry > 0) || !(stop > 0)) return false;
    return side === "long" ? stop >= entry * 0.9995 : stop <= entry * 1.0005;
  }
  it("flags ALGO-style long stop above entry", () => {
    assert.equal(stopOnWrongSide("long", 0.09711, 0.09730422), true);
    assert.equal(stopOnWrongSide("long", 0.09711, 0.0965), false);
    assert.equal(stopOnWrongSide("short", 0.09711, 0.0965), true);
    assert.equal(stopOnWrongSide("short", 0.09711, 0.0978), false);
  });
});


describe("mixAllows against-book fade cap", () => {
  function fadeAtExtreme(thesis, side) {
    return /pin|double|climax|failed range/i.test(thesis);
  }
  function mixAllows(pickSide, thesis, conf, heat, live) {
    if ((heat === "long" || heat === "short") && pickSide !== heat) {
      if (!fadeAtExtreme(thesis, pickSide)) return { ok: false, why: `against ${heat} book` };
      if (conf < 90) return { ok: false, why: `fade vs ${heat} book needs 90%+` };
      const same = live.filter((p) => p.side === pickSide).length;
      if (same >= 1) return { ok: false, why: `fade seat full vs ${heat} book` };
    }
    return { ok: true, why: "coin tape" };
  }
  it("blocks stacked fade longs on BTC 1h offer", () => {
    const live = [{ side: "long" }];
    const a = mixAllows("long", "Pin bar at lows", 91, "short", live);
    assert.equal(a.ok, false);
    assert.match(a.why, /fade seat full/);
    const b = mixAllows("long", "Pin bar at lows", 86, "short", []);
    assert.equal(b.ok, false);
    assert.match(b.why, /90%/);
    const c = mixAllows("long", "Pin bar at lows", 91, "short", []);
    assert.equal(c.ok, true);
  });
});
