import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { DEFAULT_PARAMS, type BotParams } from "@/lib/markets";


export type LiveGateInput = {
  symbol: string;
  weexSymbol: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  rr: number;
  thesis: string;
  confidence: number;
  style?: string;
  bias?: string;
  plan?: string | null;
};

export type LiveGateResult = {
  action: "take" | "skip";
  reason: string;
  source: "ai" | "off" | "error";
};

/** Live hunt take/skip before WEEX place. Fail-open without key or on AI errors. */
export async function gateLiveTicket(input: LiveGateInput): Promise<LiveGateResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { action: "take", reason: "AI gate off", source: "off" };
  }

  const prompt = [
    "You are the night desk at VELA on live WEEX USDT-M futures.",
    "Decide take or skip for ONE sized ticket the rules already cleared.",
    "Skip only on clear junk: against book without fade, thin location, garbage thesis, or terrible R:R vs the story.",
    "Take when structure + thesis + bias hang together. Be brief and cold.",
    "Reply with ONLY compact JSON: {\"action\":\"take\"|\"skip\",\"reason\":\"<=120 chars\"}",
    `Pair: ${input.symbol} (${input.weexSymbol})`,
    `Side: ${input.side}  Style: ${input.style ?? "n/a"}  Bias: ${input.bias ?? "n/a"}`,
    `Entry: ${input.entry}  Stop: ${input.stop}  Target: ${input.target}  RR: ${input.rr}`,
    `Confidence: ${input.confidence}`,
    `Thesis: ${input.thesis}`,
    `Plan: ${input.plan ?? "n/a"}`,
  ].join("\n");

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 120,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      return { action: "take", reason: `AI gate error ${res.status}`, source: "error" };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (body.choices?.[0]?.message?.content ?? "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { action: "take", reason: "AI gate unparseable", source: "error" };
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { action?: string; reason?: string };
    const action = parsed.action === "skip" ? "skip" : "take";
    const reason = String(parsed.reason ?? action).slice(0, 120);
    return { action, reason, source: "ai" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI gate failed";
    return { action: "take", reason: msg.slice(0, 120), source: "error" };
  }
}

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
