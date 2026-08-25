/**
 * Process-local loop. One hunt at a time. Cron returns 200 immediately and
 * this keeps the tick alive after the HTTP response so cron-job.org does not
 * time out and send “successfully started up” spam.
 */
const globalRef = globalThis as typeof globalThis & {
  __velaAutoLoop__?: boolean;
  __velaTicking__?: Promise<unknown>;
};

export function kickArmedTicks(): Promise<unknown> {
  if (globalRef.__velaTicking__) return globalRef.__velaTicking__;
  globalRef.__velaTicking__ = (async () => {
    try {
      const { getSql } = await import("@/lib/db");
      const { executeAutoTick } = await import("@/lib/fns/auto");
      const sql = await getSql();
      const rows = await sql<{ user_id: string }>`
        select user_id from auto_settings where armed = true
      `;
      for (const row of rows) {
        try {
          await executeAutoTick(row.user_id);
        } catch (err) {
          console.warn("[auto-loop]", row.user_id, err);
        }
      }
    } catch (err) {
      console.warn("[auto-loop]", err);
    } finally {
      globalRef.__velaTicking__ = undefined;
    }
  })();
  return globalRef.__velaTicking__;
}

export function ensureAutoLoop() {
  if (globalRef.__velaAutoLoop__) return;
  globalRef.__velaAutoLoop__ = true;
  void kickArmedTicks();
  setInterval(() => void kickArmedTicks(), 20_000);
}

if (typeof window === "undefined" && process.env.VELA_WORKER === "1") {
  ensureAutoLoop();
}
