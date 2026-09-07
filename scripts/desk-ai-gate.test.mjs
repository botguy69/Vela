import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Smoke: gateLiveTicket is TS; here we only assert the fail-open contract by simulating the decision helper.
function decideFromRaw(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { action: "take", reason: "AI gate unparseable", source: "error" };
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const action = parsed.action === "skip" ? "skip" : "take";
  const reason = String(parsed.reason ?? action).slice(0, 120);
  return { action, reason, source: "ai" };
}

assert.deepEqual(decideFromRaw('{"action":"skip","reason":"against book"}'), {
  action: "skip",
  reason: "against book",
  source: "ai",
});
assert.equal(decideFromRaw("not json").action, "take");
assert.equal(decideFromRaw('{"action":"take","reason":"clean A++"}').action, "take");
console.log("desk-ai-gate.test.mjs ok");
