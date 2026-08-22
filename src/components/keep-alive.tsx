import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getAutoDesk, setKeepAlive } from "@/lib/fns/auto";

function ageLabel(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3600_000)}h ago`;
}

export function PermanentDeskCard() {
  return (
    <div className="rounded-xl bg-surface p-5 shadow-border">
      <h2 className="text-sm font-medium">Permanent desk · Render</h2>
      <p className="mt-1 max-w-xl text-sm text-muted">
        This Grok preview will keep dying. The lasting copy lives on Render + Neon. Same bot, keys
        pasted once, Home Screen that does not say Session terminated.
      </p>
    </div>
  );
}

export function KeepAliveCard({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const desk = useQuery({ queryKey: ["auto"], queryFn: () => getAutoDesk(), refetchInterval: 15_000 });
  const s = desk.data?.settings;
  const origin = typeof window !== "undefined" ? window.location.origin : s?.publicOrigin ?? "";
  const ping = `${origin}/api/cron/tick?src=cron`;
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (s) setOn(s.keepAlive);
  }, [s]);

  const cronFresh = Boolean(s?.lastCronAt && Date.now() - new Date(s.lastCronAt).getTime() < 3 * 60_000);
  const loopFresh = Boolean(s?.lastTickAt && Date.now() - new Date(s.lastTickAt).getTime() < 90_000);

  const turn = async (next: boolean) => {
    try {
      await setKeepAlive({ data: { on: next, origin } });
      setOn(next);
      if (next) {
        await navigator.clipboard.writeText(ping).catch(() => undefined);
        toast.success("Ping URL copied. Paste it in cron-job.org — every 1 minute, GET.");
      } else {
        toast.message("24/7 off.");
      }
      void qc.invalidateQueries({ queryKey: ["auto"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not toggle 24/7");
    }
  };

  return (
    <div className="rounded-xl bg-surface p-5 shadow-border">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{compact ? "24/7 ping" : "24/7 · free ping (this Grok preview)"}</h2>
          {!compact && (
            <p className="mt-1 max-w-xl text-sm text-muted">
              Only works while this preview is alive. Session terminated = bot off. For a desk that
              stays up, use Permanent desk above.
            </p>
          )}
        </div>
        <Button variant={on ? "danger" : "default"} onClick={() => void turn(!on)}>
          {on ? "24/7 on — turn off" : "Turn 24/7 on"}
        </Button>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Status ok={on} label="Switch" value={on ? "On" : "Off"} />
        <Status ok={loopFresh} label="Last tick" value={ageLabel(s?.lastTickAt)} />
        <Status ok={cronFresh} label="Cron ping" value={ageLabel(s?.lastCronAt)} />
      </div>

      <p className="mt-3 break-all font-mono text-[11px] text-subtle">{ping}</p>

      {!compact && (
        <ol className="mt-3 list-decimal space-y-1 pl-4 text-sm text-muted">
          <li>Store WEEX keys and arm.</li>
          <li>Tap Turn 24/7 on — the URL is copied.</li>
          <li>
            Open console.cron-job.org → Create cronjob → paste the ping URL → every{" "}
            <strong>1 minute</strong> → GET → Save.
          </li>
          <li>Cron ping on this card turns green when it is hitting.</li>
        </ol>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            void navigator.clipboard.writeText(ping).then(() => toast.success("Ping URL copied"))
          }
        >
          Copy ping URL
        </Button>
      </div>
    </div>
  );
}

function Status({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-subtle">{label}</p>
      <p className={`mt-1 text-sm ${ok ? "text-up" : "text-muted"}`}>{value}</p>
    </div>
  );
}
