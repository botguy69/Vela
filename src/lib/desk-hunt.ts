/** Pure hunt note helpers lifted from auto.ts — no sql / weex. */

export function huntHeader(
  liveL: number,
  liveS: number,
  beN = 0,
  liveTotal?: number,
  opts?: { atRiskCap?: number; liveCap?: number; rebuild?: boolean; marginPct?: number; scanned?: number; universe?: number; missed?: number },
) {
  const atRiskCap = opts?.atRiskCap ?? 4;
  const liveCap = opts?.liveCap ?? 6;
  const at = liveL + liveS;
  const live = liveTotal ?? at + beN;
  const rebuild = Boolean(opts?.rebuild);
  const m = opts?.marginPct ?? 3;
  const scan =
    opts?.universe && opts.universe > 0
      ? ` Scanned ${opts.scanned ?? opts.universe}/${opts.universe}${opts.missed ? ` · ${opts.missed} no 1h book` : ""}.`
      : "";
  if (live >= liveCap) {
    return rebuild
      ? `Not hunting — ${live} live. Rebuild cap ${liveCap} (1 at-risk ${m}% + BE extras).${scan}`
      : `Not hunting — ${live} live. Cap ${liveCap} (${atRiskCap} at-risk + BE extras).${scan}`;
  }
  if (at >= atRiskCap) {
    return rebuild
      ? `${at}/${atRiskCap} at-risk (${liveL}L/${liveS}S, ${beN} BE). Next ${m}% only after TP1→BE.${scan}`
      : `${at}/${atRiskCap} at-risk (${liveL}L/${liveS}S, ${beN} BE). Next ticket only after TP1→BE.${scan}`;
  }
  if (at >= 1) {
    return rebuild
      ? `Rebuild hunt (${at}/${atRiskCap} at-risk, ${liveL}L/${liveS}S, ${beN} BE). ${m}% A++. One per tick.${scan}`
      : `Hunting next A++ (${at}/${atRiskCap} at-risk, ${liveL}L/${liveS}S, ${beN} BE). Either side. Best location. One per tick.${scan}`;
  }
  return rebuild
    ? `Rebuild · flat · 1×${m}% A++ · 2nd after TP1→BE · to $500.${scan}`
    : `Hunting 1 A++ per tick. Either side. Best location. ${atRiskCap} at-risk. BE extras to ${liveCap}.${scan}`;
}

export function composePass(
  note: string | null,
  liveL: number,
  liveS: number,
  liveLines: string[],
  beN = 0,
  liveTotal?: number,
  opts?: { atRiskCap?: number; liveCap?: number; rebuild?: boolean; marginPct?: number; scanned?: number; universe?: number; missed?: number },
) {
  const head = huntHeader(liveL, liveS, beN, liveTotal, opts);
  const fromTick = (note ?? "")
    .split("\n")
    .map((ln) => ln.trim())
    .filter((ln) =>
      /^(Eying |Took |Skip |BTC |Book |One |A\+\+|Closed |Rebuild |Thinking |Scanned |Hunting )/i.test(ln),
    )
    .filter((ln) => !/trend cooling|80%\+|21h-mean|No dip-buy vs a dump/i.test(ln));
  const uniq = [...new Set([...liveLines.filter(Boolean), ...fromTick])];
  return [head, ...uniq].filter(Boolean).join("\n");
}

// TODO(desk-place): extract placeTicket helper into src/lib/desk-place.ts when it
// can be lifted cleanly without dragging weex/sql side effects.
