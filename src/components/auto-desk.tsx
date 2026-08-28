import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AccountChip, SiteFooter, Wordmark } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BotBreakdown, LegalDisclaimer } from "@/components/legal";
import { KeepAliveCard, PermanentDeskCard } from "@/components/keep-alive";
import { formatPx, formatUsd, signedClass } from "@/lib/format";
import {
  clearWeexKeys,
  flattenSignal,
  getAutoDesk,
  reviewBook,
  runAutoTick,
  saveWeexKeys,
  setArmed,
  setContinueToGoal,
} from "@/lib/fns/auto";
import { cn } from "@/lib/utils";

export function AutoDesk() {
  const qc = useQueryClient();
  const [snap] = useState(() => {
    if (typeof window === "undefined") return undefined;
    try {
      const raw = localStorage.getItem("vela-desk-snap");
      return raw ? (JSON.parse(raw) as Awaited<ReturnType<typeof getAutoDesk>>) : undefined;
    } catch {
      return undefined;
    }
  });
  const desk = useQuery({
    queryKey: ["auto"],
    queryFn: async () => {
      const d = await getAutoDesk();
      try {
        localStorage.setItem("vela-desk-snap", JSON.stringify(d));
      } catch {
        /* quota */
      }
      return d;
    },
    placeholderData: snap,
    refetchInterval: 12_000,
    staleTime: 6_000,
  });
  const s = desk.data?.settings;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["auto"] });
  const hosted =
    typeof window !== "undefined" && window.location.hostname.endsWith("onrender.com");

  const tick = useMutation({
    mutationFn: () => runAutoTick(),
    onSuccess: (r) => {
      if (r.opened || r.closed) toast.message(r.note);
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Tick failed"),
  });

  useEffect(() => {
    if (!s?.armed) return;
    const id = window.setInterval(() => tick.mutate(), 18_000);
    return () => window.clearInterval(id);
  }, [s?.armed]);

  return (
    <div className="min-h-dvh bg-bg">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-8">
        <Wordmark />
        <AccountChip />
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6 sm:px-8">
        {!hosted && (
        <div className="mb-4 rounded-lg bg-raised px-3 py-3">
          <p className="text-sm font-medium">Home Screen — Safari only</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Delete any old VELA icon on the Home Screen (press and hold → Remove App → Delete).</li>
            <li>Stay on this page. Tap <span className="text-fg">Copy Safari URL</span>.</li>
            <li>Leave Grok. Open the <span className="text-fg">Safari</span> app (the compass). Not Chrome. Not Private.</li>
            <li>Paste the URL in Safari’s address bar → Go. Sign in with the same email if asked.</li>
            <li>You should see Auto, Tick now, Kill switch, Majors. Not Desk / paper / Buy BTC.</li>
            <li>Tap the Share button (square with the arrow up) → <span className="text-fg">Add to Home Screen</span> → Add.</li>
            <li>Open only that new icon. Do not add from inside Grok again.</li>
          </ol>
          <Button
            className="mt-3"
            variant="secondary"
            onClick={() => {
              const url = `${window.location.origin}/w`;
              void navigator.clipboard.writeText(url).then(() => toast.success("Safari URL copied"));
            }}
          >
            Copy Safari URL
          </Button>
        </div>
        )}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-subtle">Goal · $1,000,000 · live WEEX · no paper</p>
            <h1 className="mt-2 font-display text-4xl font-medium tracking-tight">Auto</h1>
            <p className="mt-2 max-w-xl text-sm text-muted">
              Live WEEX equity (wallet + unrealized, once). 1–2% margin, coin-max leverage. 4 at-risk any mix (4L, 4S, or split). Extra 2 after TP1/BE. 1h idea, 15m fill.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={tick.isPending} onClick={() => tick.mutate()}>
              {tick.isPending ? "Ticking…" : "Tick now"}
            </Button>
            <Button
              variant={s?.armed ? "danger" : "default"}
              disabled={!s}
              onClick={() =>
                void setArmed({ data: { armed: !s?.armed } })
                  .then((r) => {
                    toast.success(r.armed ? "Live armed" : "Disarmed");
                    refresh();
                  })
                  .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Arm failed"))
              }
            >
              {s?.armed ? "Kill switch" : "I accept the risk — Arm live"}
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-4">
          <Stat label="WEEX" value={s?.weexLive ? formatUsd(s.accountUsd) : "—"} />
          <Stat label="Phase" value={s?.weexLive ? (s.phase ?? "—") : "Waiting"} />
          <Stat label="Method" value={s?.weexLive ? (s.method ?? "vela") : "—"} />
          <Stat
            label={s?.stageTarget === 1_000_000 ? "To $1M" : "To $10k"}
            value={s?.weexLive && s.multipleToGoal > 0 ? `${s.multipleToGoal.toFixed(0)}×` : "—"}
          />
        </div>
        {s?.weexLive && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat label="Win rate" value={s.closed ? `${s.winRate.toFixed(0)}%  (${s.wins}/${s.closed})` : "—"} />
            <Stat label="Avg win" value={s.avgWinR ? `+${s.avgWinR.toFixed(2)}R` : "—"} />
            <Stat label="Avg loss" value={s.avgLossR ? `${s.avgLossR.toFixed(2)}R` : "—"} />
          </div>
        )}
        {s?.weexLive && s.recordNames?.length ? (
          <p className="mt-2 text-xs text-subtle">{s.recordNames.join(" · ")}</p>
        ) : null}

        {s && (
          <div className="mt-4 rounded-xl bg-surface p-4 shadow-border">
            <div className="flex items-baseline justify-between gap-3 text-xs text-subtle">
              <span>Of {formatUsd(s.stageTarget ?? 10_000)}</span>
              <span>{s.progressPct.toFixed(1)}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-accent" style={{ width: `${s.progressPct}%` }} />
            </div>
            <p className="mt-3 text-[10px] uppercase tracking-[0.16em] text-subtle">Last pass</p>
            <p className="mt-1.5 whitespace-pre-line font-mono text-[12px] leading-6 text-fg sm:text-[13px]">
              {s.lastTickNote && s.lastTickNote !== "Tick running…"
                ? s.lastTickNote
                : s.lastTickNote === "Tick running…"
                  ? "Hunt in flight…"
                  : "Hunt hasn’t printed yet. Next pass will say if it’s hunting, watching, or standing down."}
            </p>
            {s.correction ? <p className="mt-2 text-xs text-subtle">{s.correction}</p> : null}
            {s.phaseId === "checkpoint" && (
              <Button
                className="mt-3"
                onClick={() =>
                  void setContinueToGoal({ data: { on: true } }).then(() => {
                    toast.success("Stage 3 on. Scaling toward $1M.");
                    refresh();
                  })
                }
              >
                Re-evaluated — continue to $1M
              </Button>
            )}
          </div>
        )}

        <div className="mt-8">
          <TicketsTable signals={desk.data?.signals ?? []} refresh={refresh} />
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          <SettingsCard />
          <KeysCard onSaved={refresh} />
        </div>

        {!hosted && (
          <div className="mt-4">
            <PermanentDeskCard />
          </div>
        )}
        <div className="mt-4">
          <KeepAliveCard compact={hosted} />
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <details className="rounded-xl bg-surface p-5 shadow-border">
            <summary className="cursor-pointer text-sm font-medium">Bot breakdown</summary>
            <div className="mt-3">
              <BotBreakdown />
            </div>
          </details>
          <LegalDisclaimer />
        </div>

        <section className="mt-8">
          <h2 className="font-display text-2xl font-medium tracking-tight">Majors</h2>
          <p className="mt-1 text-sm text-muted">
            Known WEEX perps only (INJ, ARB, OP, ATOM, FIL, RENDER, and the rest of the board). New listings stay out. Leverage pulled live.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(desk.data?.universe ?? []).map((c) => (
              <div key={c.weex} className="rounded-lg bg-surface px-3 py-2 shadow-border">
                <p className="text-sm font-medium">{c.id}</p>
                <p className="font-mono text-[11px] text-subtle">{c.maxLeverage}x · {c.weex}</p>
              </div>
            ))}
          </div>
        </section>

        <ReviewBlock />
      </main>
      <SiteFooter />
    </div>
  );
}

function TicketsTable({
  signals,
  refresh,
}: {
  signals: Array<{
    id: number;
    weexSymbol: string;
    side: "long" | "short";
    entryType: string;
    fillPx: number | null;
    entry: number;
    stop: number;
    target: number;
    targets: number[];
    leverage: number;
    pnl: number | null;
    status: string;
    beMoved: boolean;
    thesis: string | null;
    rr: number;
    confidence: number | null;
    liveOnWeex?: boolean;
    closeReason?: string | null;
    closedPx?: number | null;
  }>;
  refresh: () => void;
}) {
  const [showOld, setShowOld] = useState(false);
  const open = signals.filter(
    (t) => Boolean(t.liveOnWeex) || t.status === "working",
  );
  const history = signals.filter((t) => {
    if (open.includes(t)) return false;
    const why = t.closeReason ?? "";
    if (why.startsWith("Duplicate") || why.startsWith("Replaced by") || why.startsWith("Cancelled —")) return false;
    if (t.status === "proposed" || t.status === "error") return false;
    return t.status === "stopped" || t.status === "targeted" || t.status === "skipped" || Boolean(t.closeReason);
  });
  const fill = 10;
  const recent = history.slice(0, fill);
  const older = history.slice(fill);
  const rows = [...open, ...recent];
  return (
    <section>
      <h2 className="font-display text-2xl font-medium tracking-tight">Tickets</h2>
      <p className="mt-1 text-sm text-muted">
        {open.some((t) => t.liveOnWeex)
          ? `${open.filter((t) => t.liveOnWeex).length} live on WEEX`
          : open.length
            ? `${open.length} working limit`
            : "No live tickets"}
        {` · last ${Math.min(10, recent.length)} closed`}
        {older.length ? ` · ${older.length} older` : ""}
      </p>
      <div className="mt-3">
      <TicketSheet rows={rows} refresh={refresh} />
      </div>
      {older.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline"
            onClick={() => setShowOld((v) => !v)}
          >
            {showOld ? "Hide older tickets" : `Show older tickets (${older.length})`}
          </button>
          {showOld && <div className="mt-2"><TicketSheet rows={older} refresh={refresh} faded /></div>}
        </div>
      )}
    </section>
  );
}

function TicketSheet({
  rows,
  refresh,
  faded,
}: {
  rows: Array<{
    id: number;
    weexSymbol: string;
    side: "long" | "short";
    entryType: string;
    fillPx: number | null;
    entry: number;
    stop: number;
    target: number;
    targets: number[];
    leverage: number;
    pnl: number | null;
    status: string;
    beMoved: boolean;
    thesis: string | null;
    rr: number;
    confidence: number | null;
    liveOnWeex?: boolean;
    closeReason?: string | null;
    closedPx?: number | null;
  }>;
  refresh: () => void;
  faded?: boolean;
}) {
  return (
      <div className={cn("overflow-hidden rounded-xl bg-surface shadow-border", faded && "opacity-80")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-subtle">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-medium">Pair</th>
                <th className="px-4 py-3 font-medium">Side</th>
                <th className="px-4 py-3 font-medium">Entry</th>
                <th className="px-4 py-3 font-medium">Takes</th>
                <th className="px-4 py-3 font-medium">Lev</th>
                <th className="px-4 py-3 font-medium">PnL</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted">
                    No tickets. Store keys, then arm.
                  </td>
                </tr>
              )}
              {rows.map((t) => {
                const live = Boolean(t.liveOnWeex);
                const pending = t.status === "working" && !live;
                const why = live
                  ? [
                      t.rr > 0 ? `${t.rr.toFixed(1)}R` : null,
                      t.confidence != null ? `${Math.round(t.confidence)}%` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : t.closeReason || t.status;
                return (
                <tr
                  key={t.id}
                  className={cn(
                    "border-b border-line/70 last:border-0",
                    live && "bg-up/10",
                    pending && "bg-warn/10",
                    !live && !pending && "opacity-45",
                  )}
                >
                  <td className={cn("px-4 py-2.5 font-medium", live && "text-up")}>
                    {t.weexSymbol}
                    <div className="text-[11px] text-subtle">{why || "cross"}</div>
                  </td>
                  <td className={cn("px-4 py-2.5 uppercase", t.side === "long" ? "text-up" : "text-down")}>
                    {t.side}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {t.entryType} {formatPx(t.fillPx ?? t.entry)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs tabular-nums">
                    {live ? (
                      <>
                        SL {formatPx(t.stop)}
                        <div className="text-subtle">
                          {(t.targets.length ? t.targets : [t.target]).map((px, i) => (
                            <span key={`${px}-${i}`}>
                              {i ? " · " : ""}TP{i + 1} {formatPx(px)}
                            </span>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        Closed {t.closedPx ? formatPx(t.closedPx) : "—"}
                        <div className="text-subtle">WEEX {t.closeReason || t.status}</div>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">{t.leverage}x</td>
                  <td className={cn("px-4 py-2.5 font-mono tabular-nums", signedClass(t.pnl ?? 0))}>
                    {t.pnl == null ? "—" : formatUsd(t.pnl)}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={live ? "live" : "default"}>
                      {live ? (t.beMoved ? "BE locked" : "live") : pending ? "working" : t.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {live && (
                      <button
                        type="button"
                        className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline"
                        onClick={() =>
                          void flattenSignal({ data: { id: t.id } })
                            .then((r) => {
                              toast.message(`Flattened · ${formatUsd(r.pnl)}`);
                              refresh();
                            })
                            .catch((err: unknown) =>
                              toast.error(err instanceof Error ? err.message : "Flatten failed"),
                            )
                        }
                      >
                        Flatten
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface px-4 py-3 shadow-border">
      <p className="text-[10px] uppercase tracking-[0.14em] text-subtle">{label}</p>
      <p className="mt-1 font-mono text-sm tabular-nums">{value}</p>
    </div>
  );
}

function SettingsCard() {
  const desk = useQuery({ queryKey: ["auto"], queryFn: () => getAutoDesk() });
  const s = desk.data?.settings;

  return (
    <div className="rounded-xl bg-surface p-5 shadow-border">
      <h2 className="text-sm font-medium">Live book</h2>
      <p className="mt-1 text-sm text-muted">
        Balance is pulled from WEEX on every load and every tick. Deposit or withdraw on the
        exchange — Auto sees it next pass. No number to type.
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-subtle">Equity</dt>
          <dd className="mt-1 font-mono tabular-nums">{s?.weexLive ? formatUsd(s.accountUsd) : "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-subtle">Source</dt>
          <dd className="mt-1">{s?.weexLive ? "WEEX live" : s?.hasKeys ? "Waiting on WEEX" : "Store keys"}</dd>
          {s?.weexError && (
            <p className="mt-3 text-sm text-loss">{s.weexError}</p>
          )}
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-subtle">Margin</dt>
          <dd className="mt-1 font-mono tabular-nums">{s?.riskPct ?? 2}%</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-subtle">Record</dt>
          <dd className="mt-1 font-mono tabular-nums">{s ? `${s.wins}/${s.closed}` : "0/0"}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-muted">{s?.correction}</p>
    </div>
  );
}

function KeysCard({ onSaved }: { onSaved: () => void }) {
  const desk = useQuery({ queryKey: ["auto"], queryFn: () => getAutoDesk() });
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [pass, setPass] = useState("");

  return (
    <div className="rounded-xl bg-surface p-5 shadow-border">
      <h2 className="text-sm font-medium">WEEX keys</h2>
      <p className="mt-1 text-sm text-muted">
        Paste keys only here, never in chat. Futures trade ON, withdrawals OFF, IP whitelist OFF
        (this server is not your home IP). Wait 15 minutes after creating a new key. Passphrase
        letters and numbers only. After they land, Auto reads the live USDT book.
      </p>
      {desk.data?.settings.hasKeys && (
        <p className="mt-3 text-xs text-muted">Stored key {desk.data.settings.keyHint}</p>
      )}
      <div className="mt-4 grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="k">API key</Label>
          <Input id="k" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sec">Secret</Label>
          <Input id="sec" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pp">Passphrase</Label>
          <Input id="pp" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={() =>
            void saveWeexKeys({ data: { apiKey, apiSecret, passphrase: pass } })
              .then((r) => {
                toast.success(r.weexNote);
                setApiKey("");
                setApiSecret("");
                setPass("");
                onSaved();
              })
              .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Key save failed"))
          }
        >
          Store keys
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void clearWeexKeys().then(() => {
              toast.message("Keys cleared. Disarmed.");
              onSaved();
            })
          }
        >
          Clear keys
        </Button>
      </div>
    </div>
  );
}

function ReviewBlock() {
  const [note, setNote] = useState<string | null>(null);
  const review = useMutation({
    mutationFn: () => reviewBook(),
    onSuccess: (r) => {
      if (r.ok) setNote(r.text);
      else toast.error(r.error);
    },
  });
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-2xl font-medium tracking-tight">Review</h2>
        <Button variant="outline" size="sm" disabled={review.isPending} onClick={() => review.mutate()}>
          {review.isPending ? "Reading…" : "Review open tickets"}
        </Button>
      </div>
      {note && (
        <article className="mt-3 rounded-xl bg-surface p-5 text-sm leading-relaxed text-fg/90 shadow-border">
          {note}
        </article>
      )}
    </section>
  );
}
