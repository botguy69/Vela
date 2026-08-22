import { createFileRoute } from "@tanstack/react-router";

function cors(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, X-Cron-Secret, Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

async function handle(request: Request) {
  try {
    const secret = process.env.CRON_SECRET?.trim();
    if (secret) {
      const got = request.headers.get("authorization") ?? request.headers.get("x-cron-secret") ?? "";
      if (got !== `Bearer ${secret}` && got !== secret) {
        return cors({ ok: false, error: "unauthorized" }, 401);
      }
    }

    const src = new URL(request.url).searchParams.get("src") ?? "cron";
    const { ensureAutoLoop } = await import("@/lib/auto-loop.server");
    ensureAutoLoop();

    try {
      const { stampCronHit } = await import("@/lib/fns/auto");
      await stampCronHit();
    } catch {
      /* old DB or empty book — still awake */
    }

    if (src === "alive" || src === "ping") {
      return cors({ ok: true, awake: true, ticked: 0, note: "awake" });
    }

    const { getSql } = await import("@/lib/db");
    const { executeAutoTick } = await import("@/lib/fns/auto");
    const sql = await getSql();
    const rows = await sql<{ user_id: string }>`select user_id from auto_settings where armed = true`;
    const results = [];
    for (const row of rows) {
      try {
        results.push({ userId: row.user_id, ...(await executeAutoTick(row.user_id)) });
      } catch (err) {
        results.push({ userId: row.user_id, error: err instanceof Error ? err.message : "tick failed" });
      }
    }
    return cors({
      ok: true,
      awake: true,
      ticked: results.length,
      at: new Date().toISOString(),
      results,
    });
  } catch (err) {
    return cors({
      ok: true,
      awake: true,
      ticked: 0,
      note: "awake",
      error: err instanceof Error ? err.message.slice(0, 160) : "tick skipped",
    });
  }
}

export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      OPTIONS: () => cors({ ok: true }, 204),
    },
  },
});
