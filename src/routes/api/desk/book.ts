import { createFileRoute } from "@tanstack/react-router";

function cors(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, X-Cron-Secret, Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
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

    const { getSql } = await import("@/lib/db");
    const sql = await getSql();

    type SettingsRow = {
      user_id: string;
      account_usd: string | number | null;
      peak_usd: string | number | null;
      last_tick_note: string | null;
      api_key_enc: string | null;
      api_secret_enc: string | null;
      api_pass_enc: string | null;
      armed: boolean;
    };

    const settings = await sql<SettingsRow>`
      select user_id, account_usd, peak_usd, last_tick_note,
             api_key_enc, api_secret_enc, api_pass_enc, armed
      from auto_settings
      order by updated_at desc nulls last
      limit 20
    `;

    const desks: unknown[] = [];

    for (const row of settings) {
      let accountUsd = num(row.account_usd);
      let peakUsd = Math.max(num(row.peak_usd), accountUsd);
      let positions: {
        symbol: string;
        side: string;
        qty: number;
        entry: number;
        uPnL: number | null;
        mark: number;
      }[] = [];
      let weexError: string | null = null;

      const hasKeys = Boolean(row.api_key_enc && row.api_secret_enc && row.api_pass_enc);
      if (hasKeys) {
        try {
          const { openSeal, getWeexEquity, listWeexPositions } = await import("@/lib/weex.server");
          let creds: { apiKey: string; apiSecret: string; passphrase: string } | null = null;
          try {
            creds = {
              apiKey: openSeal(row.api_key_enc!),
              apiSecret: openSeal(row.api_secret_enc!),
              passphrase: openSeal(row.api_pass_enc!),
            };
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            weexError = /authenticate|Unsupported state|seal|decrypt/i.test(m)
              ? "WEEX keys unreadable — re-save keys"
              : m.slice(0, 160);
          }
          if (creds) {
            const bal = await getWeexEquity(creds);
            if (bal.ok) {
              accountUsd = bal.data.equity;
              peakUsd = Math.max(peakUsd, accountUsd);
            } else {
              weexError = bal.error;
            }
            const book = await listWeexPositions(creds).catch(() => null);
            if (book) {
              positions = book.map((p) => ({
                symbol: p.symbol,
                side: p.side,
                qty: p.qty,
                entry: p.entry,
                uPnL: p.pnl,
                mark: p.mark,
              }));
            }
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : "weex failed";
          weexError = /authenticate|Unsupported state|seal|decrypt/i.test(m)
            ? "WEEX keys unreadable — re-save keys"
            : m.slice(0, 160);
        }
      }

      const openUPnL = positions.reduce((s, p) => s + (p.uPnL ?? 0), 0);

      let signals: unknown[] = [];
      try {
        const rows = await sql<{
          id: number;
          symbol: string;
          weex_symbol: string;
          side: string;
          status: string;
          entry: string | number;
          stop: string | number;
          target: string | number;
          qty: string | number;
          leverage: number;
          thesis: string | null;
          confidence: string | number | null;
          filled_at: string | null;
          created_at: string;
        }>`
          select id, symbol, weex_symbol, side, status, entry, stop, target, qty, leverage,
                 thesis, confidence, filled_at, created_at
          from auto_signals
          where user_id = ${row.user_id}
            and status in ('proposed', 'working', 'filled')
          order by updated_at desc
          limit 40
        `;
        signals = rows.map((s) => ({
          id: s.id,
          symbol: s.symbol,
          weexSymbol: s.weex_symbol,
          side: s.side,
          status: s.status,
          entry: num(s.entry),
          stop: num(s.stop),
          target: num(s.target),
          qty: num(s.qty),
          leverage: s.leverage,
          thesis: s.thesis,
          confidence: s.confidence == null ? null : num(s.confidence),
          filledAt: s.filled_at,
          createdAt: s.created_at,
        }));
      } catch {
        signals = [];
      }

      desks.push({
        userId: row.user_id,
        armed: Boolean(row.armed),
        accountUsd,
        peakUsd,
        openUPnL,
        lastTickNote: row.last_tick_note,
        hasKeys,
        weexError,
        positions,
        signals,
      });
    }

    return cors({
      ok: true,
      desks,
      at: new Date().toISOString(),
    });
  } catch (err) {
    return cors({
      ok: true,
      desks: [],
      at: new Date().toISOString(),
      error: err instanceof Error ? err.message.slice(0, 160) : "book failed",
    });
  }
}

export const Route = createFileRoute("/api/desk/book")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      OPTIONS: () => cors({ ok: true }, 200),
    },
  },
});
