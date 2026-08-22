import { formatPct, formatPx, signedClass } from "@/lib/format";
import { marketById, type MarketId } from "@/lib/markets";
import type { TapeQuote } from "@/lib/types";
import { cn } from "@/lib/utils";

export function MarketTape({
  tickers,
  selected,
  onSelect,
}: {
  tickers: TapeQuote[];
  selected?: string;
  onSelect?: (id: MarketId) => void;
}) {
  return (
    <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0">
      {tickers.map((t) => {
        const m = marketById(t.id);
        const active = selected === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect?.(t.id)}
            className={cn(
              "min-w-36 shrink-0 rounded-lg px-3 py-2.5 text-left shadow-border transition-[box-shadow,background-color] duration-150",
              active ? "bg-raised shadow-border-hover" : "bg-surface hover:shadow-border-hover",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium tracking-wide">{m.base}</span>
              <span className={cn("font-mono text-[11px] tabular-nums", signedClass(t.changePct))}>
                {formatPct(t.changePct)}
              </span>
            </div>
            <div className="mt-1 font-mono text-sm tabular-nums">{formatPx(t.last)}</div>
          </button>
        );
      })}
    </div>
  );
}
