/**
 * Process-local loop. Ticks every armed book while this Node process is up.
 * On Oracle (VELA_WORKER=1) it starts at boot. Preview only runs while awake.
 */
const globalRef = globalThis as typeof globalThis & { __velaAutoLoop__?: boolean };

export function ensureAutoLoop() {
  if (globalRef.__velaAutoLoop__) return;
  globalRef.__velaAutoLoop__ = true;
  const beat = async () => {
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
    }
  };
  void beat();
  setInterval(() => void beat(), 20_000);
}

if (typeof window === "undefined" && process.env.VELA_WORKER === "1") {
  ensureAutoLoop();
}
