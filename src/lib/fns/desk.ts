import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  DEFAULT_ALLOCATION,
  DEFAULT_PARAMS,
  MARKET_IDS,
  STARTING_CASH,
  type BotParams,
  type MarketId,
  type StrategyId,
} from "@/lib/markets";
import type { Book } from "@/lib/engine";

type BotRow = {
  id: number;
  user_id: string;
  name: string;
  symbol: string;
  strategy: string;
  params: BotParams | string;
  status: string;
  allocated: string | number;
  cash: string | number;
  position_qty: string | number;
  avg_entry: string | number;
  last_action_px: string | number;
  dca_count: number;
  last_candle_time: number | null;
  created_at: string;
};

type TradeRow = {
  id: number;
  user_id: string;
  bot_id: number | null;
  symbol: string;
  side: string;
  qty: string | number;
  price: string | number;
  fee: string | number;
  pnl: string | number | null;
  reason: string | null;
  ts: string;
  bot_name?: string | null;
};

type PosRow = {
  user_id: string;
  symbol: string;
  qty: string | number;
  avg_entry: string | number;
};

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseParams(raw: BotRow["params"]): BotParams {
  if (typeof raw === "string") {
    try {
      return { ...DEFAULT_PARAMS, ...(JSON.parse(raw) as Partial<BotParams>) };
    } catch {
      return { ...DEFAULT_PARAMS };
    }
  }
  return { ...DEFAULT_PARAMS, ...(raw ?? {}) };
}

function bookFrom(row: BotRow): Book {
  return {
    cash: num(row.cash),
    qty: num(row.position_qty),
    avgEntry: num(row.avg_entry),
    lastActionPx: num(row.last_action_px),
    dcaCount: row.dca_count ?? 0,
    prevFast: null,
    prevSlow: null,
  };
}

async function ensurePortfolio(sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>, userId: string) {
  await sql`
    insert into portfolios (user_id, cash, starting_cash)
    values (${userId}, ${STARTING_CASH}, ${STARTING_CASH})
    on conflict (user_id) do nothing
  `;
}

export type PublicTicker = {
  id: MarketId;
  last: number;
  changePct: number;
};

export type DeskSnapshot = {
  cash: number;
  startingCash: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  bots: Array<{
    id: number;
    name: string;
    symbol: string;
    strategy: string;
    status: string;
    allocated: number;
    cash: number;
    qty: number;
    avgEntry: number;
    lastPx: number;
    equity: number;
    pnl: number;
    trades: number;
    realized: number;
    createdAt: string;
    params: BotParams;
  }>;
  positions: Array<{
    symbol: string;
    qty: number;
    avgEntry: number;
    lastPx: number;
    value: number;
    pnl: number;
  }>;
  trades: Array<{
    id: number;
    botId: number | null;
    botName: string | null;
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    fee: number;
    pnl: number | null;
    reason: string | null;
    ts: string;
  }>;
  tickers: PublicTicker[];
};

function paperGone(): never {
  throw new Error("Paper desk is gone. Delete the old Home Screen icon and open VELA from the Grok preview.");
}

export const getDesk = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async (): Promise<DeskSnapshot> => {
    throw new Error("Paper desk is gone. Delete the old Home Screen icon and open VELA from the Grok preview.");
  });

const createInput = (input: {
  name?: string;
  symbol: string;
  strategy: StrategyId;
  allocation?: number;
  params?: Partial<BotParams>;
  backtest?: boolean;
}) => {
  const symbol = (MARKET_IDS.includes(input.symbol as MarketId) ? input.symbol : "BTC-USD") as MarketId;
  const strategy = input.strategy;
  const allocation = Math.max(100, Math.min(input.allocation ?? DEFAULT_ALLOCATION, 100_000));
  return {
    name: (input.name ?? "").trim(),
    symbol,
    strategy,
    allocation,
    params: { ...DEFAULT_PARAMS, ...(input.params ?? {}) },
    backtest: input.backtest !== false,
  };
};

export const createBot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(createInput)
  .handler(async () => paperGone());

export const setBotStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: number; status: "running" | "paused" }) => input)
  .handler(async () => paperGone());

export const deleteBot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: number }) => input)
  .handler(async () => paperGone());

export const tickBots = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => paperGone());

export const placeOrder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { symbol: string; side: "buy" | "sell"; usd?: number; fraction?: number }) => input)
  .handler(async () => paperGone());

export const resetDesk = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => paperGone());

export const getBotDetail = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { id: number }) => input)
  .handler(async () => paperGone());
