/** Pure hunt note helpers lifted from auto.ts — no sql / weex. */

export function huntHeader(liveL: number, liveS: number, beN = 0, liveTotal?: number) {
  const at = liveL + liveS;
  const live = liveTotal ?? at + beN;
  if (live >= 6) {
    return `Not hunting — ${live} live. Cap 6 (4 at-risk + BE extras).`;
  }
  if (at >= 4) {
    return `4/4 at-risk (${liveL}L/${liveS}S, ${beN} BE). Next ticket only after TP1→BE.`;
  }
  if (at >= 1) {
    return `Hunting next A++ (${at}/4 at-risk, ${liveL}L/${liveS}S, ${beN} BE). Either side. Best location. One per tick.`;
  }
  return `Hunting 1 A++ per tick. Either side. Best location. 4 at-risk. BE extras to 6.`;
}

export function composePass(
  note: string | null,
  liveL: number,
  liveS: number,
  liveLines: string[],
  beN = 0,
  liveTotal?: number,
) {
  const head = huntHeader(liveL, liveS, beN, liveTotal);
  const fromTick = (note ?? "")
    .split("\n")
    .map((ln) => ln.trim())
    .filter((ln) =>
      /^(Eying |Took |Skip |BTC |Book |One |A\+\+|Closed )/i.test(ln),
    )
    .filter((ln) => !/trend cooling|80%\+|21h-mean|No dip-buy vs a dump/i.test(ln));
  const uniq = [...new Set([...liveLines.filter(Boolean), ...fromTick])];
  return [head, ...uniq].filter(Boolean).join("\n");
}

// TODO(desk-place): extract placeTicket helper into src/lib/desk-place.ts when it
// can be lifted cleanly without dragging weex/sql side effects.
