import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { DEFAULT_PARAMS, type BotParams } from "@/lib/markets";

export const briefBot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: number }) => input)
  .handler(async ({ context, data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "Desk notes are unavailable in this environment." };
    }

    const { getSql } = await import("@/lib/db");
    const { lastPrice } = await import("@/lib/market.server");
    const sql = await getSql();
    const [bot] = await sql<{
      id: number;
      name: string;
      symbol: string;
      strategy: string;
      params: BotParams | string;
      allocated: string | number;
      cash: string | number;
      position_qty: string | number;
      avg_entry: string | number;
    }>`select * from bots where id = ${data.id} and user_id = ${context.userId}`;
    if (!bot) throw new Error("Bot not found");

    const trades = await sql<{
      side: string;
      price: string | number;
      pnl: string | number | null;
      reason: string | null;
    }>`
      select side, price, pnl, reason from trades
      where user_id = ${context.userId} and bot_id = ${bot.id}
      order by ts desc limit 16
    `;

    const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
    const params =
      typeof bot.params === "string"
        ? { ...DEFAULT_PARAMS, ...(JSON.parse(bot.params) as Partial<BotParams>) }
        : { ...DEFAULT_PARAMS, ...(bot.params ?? {}) };
    const lastPx = await lastPrice(bot.symbol as Parameters<typeof lastPrice>[0]);
    const equity = n(bot.cash) + n(bot.position_qty) * lastPx;
    const pnl = equity - n(bot.allocated);
    const wins = trades.filter((t) => n(t.pnl) > 0).length;
    const losses = trades.filter((t) => n(t.pnl) < 0).length;

    const prompt = [
      "You are the night desk at VELA, a paper-trading terminal.",
      "Write a tight briefing (120-180 words) on this simulated bot.",
      "No hype, no emojis, no investment-advice lecture.",
      "Speak like a calm prop-desk note: what the tape did, how the book looks, one risk, one tweak.",
      `Bot: ${bot.name}`,
      `Pair: ${bot.symbol}`,
      `Strategy: ${bot.strategy}`,
      `Params: ${JSON.stringify(params)}`,
      `Allocated: ${n(bot.allocated).toFixed(2)}  Equity: ${equity.toFixed(2)}  PnL: ${pnl.toFixed(2)}`,
      `Cash: ${n(bot.cash).toFixed(2)}  Qty: ${n(bot.position_qty)}  Avg: ${n(bot.avg_entry)}  Last: ${lastPx}`,
      `Recent fills: ${trades.length}  Winning sells in this slice: ${wins}  Losing: ${losses}`,
      `Fills: ${JSON.stringify(trades.map((t) => ({ side: t.side, px: n(t.price), pnl: t.pnl == null ? null : n(t.pnl), reason: t.reason })))}`,
    ].join("\n");

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 360,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return { ok: false as const, error: `Desk note failed (${res.status}).` };
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return { ok: true as const, text: body.choices[0]?.message.content ?? "" };
  });
