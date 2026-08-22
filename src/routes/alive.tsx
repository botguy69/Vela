import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/alive")({
  component: Alive,
});

function Alive() {
  const [last, setLast] = useState<string>("starting…");
  const [ok, setOk] = useState(true);

  useEffect(() => {
    const beat = () => {
      void fetch("/api/cron/tick?src=alive", { cache: "no-store" })
        .then(async (r) => {
          const body = (await r.json().catch(() => null)) as { ok?: boolean; awake?: boolean } | null;
          const awake = r.ok && (body?.ok || body?.awake);
          setOk(Boolean(awake));
          setLast(awake ? `${new Date().toLocaleTimeString()} · awake` : `fail ${r.status}`);
        })
        .catch(() => {
          setOk(false);
          setLast("offline");
        });
    };
    beat();
    const id = window.setInterval(beat, 20_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-5">
      <div className="max-w-sm text-center">
        <p className="text-xs uppercase tracking-[0.18em] text-subtle">VELA keep-alive</p>
        <h1 className="mt-3 font-display text-3xl font-medium">24/7</h1>
        <p className={`mt-4 font-mono text-sm ${ok ? "text-up" : "text-down"}`}>{last}</p>
        <p className="mt-4 text-sm text-muted">
          Optional extra. The real 24/7 is the 1-minute cron. This tab just helps while it is open.
        </p>
      </div>
    </main>
  );
}
