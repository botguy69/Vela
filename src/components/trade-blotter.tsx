import { formatPx, formatQty, formatTime, formatUsd, signedClass } from "@/lib/format";
import type { DeskSnapshot } from "@/lib/fns/desk";
import { cn } from "@/lib/utils";

export function TradeBlotter({ trades }: { trades: DeskSnapshot["trades"] }) {
  if (trades.length === 0) {
    return (
      <div className="rounded-xl bg-surface px-5 py-10 text-center text-sm text-muted shadow-border">
        The blotter is quiet. Deploy a bot or lift a ticket.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-[11px] uppercase tracking-[0.14em] text-subtle">
            <tr className="border-b border-line">
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Pair</th>
              <th className="px-4 py-3 font-medium">Side</th>
              <th className="px-4 py-3 font-medium">Qty</th>
              <th className="px-4 py-3 font-medium">Price</th>
              <th className="px-4 py-3 font-medium">PnL</th>
              <th className="px-4 py-3 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id} className="border-b border-line/70 last:border-0">
                <td className="px-4 py-2.5 text-muted">{formatTime(t.ts)}</td>
                <td className="px-4 py-2.5 font-medium">{t.symbol.replace("-USD", "")}</td>
                <td className={cn("px-4 py-2.5 font-medium uppercase", t.side === "buy" ? "text-up" : "text-down")}>
                  {t.side}
                </td>
                <td className="px-4 py-2.5 font-mono tabular-nums">{formatQty(t.qty)}</td>
                <td className="px-4 py-2.5 font-mono tabular-nums">{formatPx(t.price)}</td>
                <td className={cn("px-4 py-2.5 font-mono tabular-nums", signedClass(t.pnl ?? 0))}>
                  {t.pnl == null ? "—" : formatUsd(t.pnl)}
                </td>
                <td className="max-w-48 truncate px-4 py-2.5 text-muted">
                  {t.botName ?? t.reason ?? "Manual"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
