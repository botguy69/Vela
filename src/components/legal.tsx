export function LegalDisclaimer({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="text-xs leading-relaxed text-subtle">
        VELA is software, not a broker or adviser. Auto places live WEEX USDT-M futures on your
        account. High leverage can wipe the book — and more — on cross. $1M is a target, not a
        promise. You can lose everything you send to WEEX.
      </p>
    );
  }

  return (
    <section id="legal" className="rounded-xl bg-surface p-5 text-sm shadow-border">
      <h2 className="text-sm font-medium">Legal disclaimer</h2>
      <div className="mt-3 grid gap-3 text-muted">
        <p>
          VELA is a software interface. It is not a broker, exchange, investment adviser, or
          commodity trading advisor. Nothing here is financial, legal, or tax advice. Crypto
          perpetual futures are high-risk speculative products.
        </p>
        <p>
          When you arm Auto, it sends live orders to <span className="text-fg">your WEEX account</span>{" "}
          using keys you provide. Funds never sit in this app. You deposit and withdraw only on
          WEEX. You are the account owner and solely responsible for every fill, fee, funding
          payment, and liquidation.
        </p>
        <p>
          The book uses <span className="text-fg">cross margin</span> and each coin’s{" "}
          <span className="text-fg">maximum leverage</span> (up to 400×). A small adverse move can
          erase the ticket and damage the rest of the account. Stops can gap. APIs can lag, reject,
          or fail. The bot can be wrong for a long time.
        </p>
        <p>
          The stated goal of $1,000,000 is a software target, not a forecast or guarantee. Most
          accounts that trade this way lose money. Past prints do not predict the next one. Do not
          arm with money you cannot afford to lose. By clicking Arm live you accept these risks.
        </p>
      </div>
    </section>
  );
}

export function BotBreakdown() {
  const rows: [string, string][] = [
    ["Venue", "WEEX USDT-M perpetual futures. Live only. No paper book."],
    ["Money", "Read from WEEX USDT equity every tick. Deposit on WEEX. Size compounds off that number."],
    ["Goal", "Grow the WEEX book toward $1,000,000. Target, not a promise."],
    ["Size", "1–2% of live equity as margin. Notional = margin × that coin’s max leverage."],
    ["Margin", "Cross. Combined. Coin-max leverage (BTC 400×, others per WEEX)."],
    ["Universe", "Curated known WEEX perps (majors + INJ/ARB/OP/ATOM/FIL/RENDER and similar). No new listings."],
    ["First method", "Structure + RSI + ATR. Bot sets SL. One, two, or three takes. Limits are post-only."],
    ["Breakeven + trail", "Stop walks to entry + fee after 1R or the first take, then trails last swing."],
    ["Time stops", "Unfilled limits die in 4–10h. Dead fills flatten after 8–20h if they never paid 0.3R."],
    ["One-beta", "The book is one BTC-direction at a time. No stacked ETH+SOL+BTC longs."],
    ["HTF veto", "No 1h long if the 4h mean is still selling. Reverse for shorts."],
    ["Spread / funding", "Skip a wide book. Skip chasing the side already paying 8bps+ funding."],
    ["Regime", "If BTC hourly ATR is 2.2× its median AND the last bar is a shock wick, stand down. Trend grinds can still trade."],
    ["Self-score", "After 8+ closes of a setup type, winners get size in the scan. Losers get demoted."],
    ["Loop", "20s in-process while awake. Free cron-job.org ping on /api/cron/tick keeps the preview up 24/7."],
    ["Will not", "Raise margin past 2%. Trade new or sketch listings. All-in to “catch up.” Hold your funds."],
    ["Controls", "Arm live sends orders. Kill switch stops new ones. Flatten closes a ticket on WEEX."],
  ];

  return (
    <section id="breakdown" className="rounded-xl bg-surface p-5 shadow-border">
      <h2 className="text-sm font-medium">Bot breakdown</h2>
      <dl className="mt-4 grid gap-3">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-0.5 sm:grid-cols-[7.5rem_1fr] sm:gap-4">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-subtle">{k}</dt>
            <dd className="text-sm text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
