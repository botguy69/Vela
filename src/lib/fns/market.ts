import { createServerFn } from "@tanstack/react-start";
import { MARKET_IDS, type Granularity, type MarketId } from "@/lib/markets";

export const fetchTickers = createServerFn({ method: "GET" }).handler(async () => {
  const { getTickers } = await import("@/lib/market.server");
  return getTickers();
});

export const fetchCandles = createServerFn({ method: "GET" })
  .validator((input: { symbol: string; gran?: Granularity; limit?: number }) => {
    const symbol = (MARKET_IDS.includes(input.symbol as MarketId)
      ? input.symbol
      : "BTC-USD") as MarketId;
    const gran: Granularity = input.gran === "5m" ? "5m" : "1h";
    const limit = Math.min(Math.max(input.limit ?? 180, 40), 300);
    return { symbol, gran, limit };
  })
  .handler(async ({ data }) => {
    const { getCandles } = await import("@/lib/market.server");
    return getCandles(data.symbol, data.gran, data.limit);
  });
