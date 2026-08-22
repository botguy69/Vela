import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPx, formatUsd } from "@/lib/format";
import { placeOrder } from "@/lib/fns/desk";
import { marketById, type MarketId } from "@/lib/markets";

export function OrderTicket({
  symbol,
  last,
  cash,
  heldQty,
  onDone,
}: {
  symbol: MarketId;
  last: number;
  cash: number;
  heldQty: number;
  onDone: () => void;
}) {
  const [usd, setUsd] = useState("250");
  const [busy, setBusy] = useState<"buy" | "sell" | null>(null);
  const m = marketById(symbol);

  async function buy() {
    setBusy("buy");
    try {
      await placeOrder({ data: { symbol, side: "buy", usd: Number(usd) } });
      toast.success(`Bought ${m.base}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Buy failed");
    } finally {
      setBusy(null);
    }
  }

  async function sell() {
    setBusy("sell");
    try {
      await placeOrder({ data: { symbol, side: "sell", fraction: 1 } });
      toast.success(`Sold ${m.base}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sell failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl bg-surface p-4 shadow-border sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-subtle">Ticket</p>
          <h2 className="mt-1 text-sm font-medium">
            {m.base} · {formatPx(last)}
          </h2>
        </div>
        <p className="text-xs text-muted">Cash {formatUsd(cash)}</p>
      </div>
      <div className="mt-4 grid gap-1.5">
        <Label htmlFor="ticket-usd">Buy notional</Label>
        <Input id="ticket-usd" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={busy !== null} onClick={() => void buy()}>
          {busy === "buy" ? "Working…" : `Buy ${m.base}`}
        </Button>
        <Button variant="secondary" disabled={busy !== null || heldQty <= 0} onClick={() => void sell()}>
          {busy === "sell" ? "Working…" : `Sell ${m.base}`}
        </Button>
      </div>
      {heldQty > 0 && (
        <p className="mt-3 text-xs text-muted">
          Long {heldQty.toPrecision(6)} {m.base}
        </p>
      )}
    </div>
  );
}
