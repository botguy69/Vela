import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createBot } from "@/lib/fns/desk";
import {
  DEFAULT_ALLOCATION,
  DEFAULT_PARAMS,
  MARKETS,
  STRATEGIES,
  TEMPLATES,
  type StrategyId,
} from "@/lib/markets";
import { formatUsd } from "@/lib/format";

export function CreateBot({
  cash,
  onCreated,
}: {
  cash: number;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [strategy, setStrategy] = useState<StrategyId>("rsi");
  const [symbol, setSymbol] = useState("BTC-USD");
  const [name, setName] = useState("");
  const [allocation, setAllocation] = useState(String(DEFAULT_ALLOCATION));

  async function submit() {
    const alloc = Number(allocation);
    if (!Number.isFinite(alloc) || alloc < 100) {
      toast.error("Allocation needs to be at least $100.");
      return;
    }
    setBusy(true);
    try {
      await createBot({
        data: {
          name,
          symbol,
          strategy,
          allocation: alloc,
          params: DEFAULT_PARAMS,
          backtest: true,
        },
      });
      toast.success("Bot live on the blotter");
      setOpen(false);
      setName("");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create bot");
    } finally {
      setBusy(false);
    }
  }

  async function fromTemplate(id: string) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setBusy(true);
    try {
      await createBot({
        data: {
          name: t.name,
          symbol: t.symbol,
          strategy: t.strategy,
          allocation: Math.min(t.allocation, cash),
          params: { ...DEFAULT_PARAMS, ...t.params },
          backtest: true,
        },
      });
      toast.success(t.name);
      setOpen(false);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create bot");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New bot</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy a bot</DialogTitle>
          <DialogDescription>
            Allocates from unallocated cash ({formatUsd(cash)}). We replay the last week of hourly
            prints so the book is not empty on arrival.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <p className="text-xs font-medium text-muted">Templates</p>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={busy || t.allocation > cash}
                onClick={() => void fromTemplate(t.id)}
                className="rounded-md bg-raised px-3 py-2 text-left text-xs shadow-border hover:shadow-border-hover disabled:opacity-40"
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="bot-name">Name</Label>
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional — we will name it"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="bot-symbol">Pair</Label>
              <select
                id="bot-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="h-11 rounded-md bg-raised px-3 text-sm shadow-border outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {MARKETS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.base} · {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bot-strategy">Strategy</Label>
              <select
                id="bot-strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as StrategyId)}
                className="h-11 rounded-md bg-raised px-3 text-sm shadow-border outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {STRATEGIES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bot-alloc">Allocation</Label>
            <Input
              id="bot-alloc"
              inputMode="decimal"
              value={allocation}
              onChange={(e) => setAllocation(e.target.value)}
            />
          </div>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? "Replaying the tape…" : "Deploy and backtest"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
