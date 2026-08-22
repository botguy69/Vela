import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { AccountChip, SiteFooter, Wordmark } from "@/components/app-shell";
import { BotBreakdown, LegalDisclaimer } from "@/components/legal";
import { MarketTape } from "@/components/market-tape";
import { PriceChart } from "@/components/price-chart";
import { Button } from "@/components/ui/button";
import type { Candle } from "@/lib/engine";
import { formatPct, formatPx, signedClass } from "@/lib/format";
import { fetchCandles } from "@/lib/fns/market";
import type { MarketId } from "@/lib/markets";
import type { TapeQuote } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Landing({
  tickers,
  candles: initialCandles,
}: {
  tickers: TapeQuote[];
  candles: Candle[];
}) {
  const [symbol, setSymbol] = useState<MarketId>("BTC-USD");
  const candlesQuery = useQuery({
    queryKey: ["candles", symbol, "1h"],
    queryFn: () => fetchCandles({ data: { symbol, gran: "1h", limit: 120 } }),
    initialData: symbol === "BTC-USD" ? initialCandles : undefined,
  });
  const active = tickers.find((t) => t.id === symbol) ?? tickers[0];
  const candles = candlesQuery.data ?? (symbol === "BTC-USD" ? initialCandles : []);

  return (
    <div className="min-h-dvh bg-bg">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Wordmark />
        <AccountChip />
      </header>

      <main className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
        <section className="grid gap-10 pt-6 lg:grid-cols-[1.15fr_0.85fr] lg:items-end lg:pt-10">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-subtle">WEEX live futures</p>
            <h1 className="mt-4 max-w-xl font-display text-5xl font-medium leading-[1.05] tracking-tight sm:text-6xl">
              A bot that trades your book.
            </h1>
            <p className="mt-5 max-w-md text-base text-muted">
              VELA reads your WEEX equity and sends live cross futures. Money stays on WEEX. There
              is no paper mode.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <a href="/login">
                  Open the bot
                  <ArrowRight className="size-4" />
                </a>
              </Button>
              <Button asChild variant="outline" size="lg">
                <a href="#legal">How it works</a>
              </Button>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl bg-surface p-4 shadow-border sm:p-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-subtle">{symbol}</p>
                <p className="mt-1 font-mono text-3xl tabular-nums">{formatPx(active?.last ?? 0)}</p>
              </div>
              <p className={cn("font-mono text-sm tabular-nums", signedClass(active?.changePct ?? 0))}>
                {formatPct(active?.changePct ?? 0)} session
              </p>
            </div>
            <PriceChart candles={candles} className="mt-3" height={220} />
          </div>
        </section>

        <section className="mt-12">
          <MarketTape tickers={tickers} selected={symbol} onSelect={setSymbol} />
        </section>

        <section className="mt-16 grid gap-4 lg:grid-cols-2">
          <BotBreakdown />
          <LegalDisclaimer />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
