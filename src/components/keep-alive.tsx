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