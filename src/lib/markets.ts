export type MarketId =
  | "BTC-USD"
  | "ETH-USD"
  | "SOL-USD"
  | "XRP-USD"
  | "DOGE-USD"
  | "AVAX-USD"
  | "LINK-USD"
  | "LTC-USD"
  | "ADA-USD"
  | "ATOM-USD";

export type StrategyId = "dca" | "grid" | "rsi" | "ma_cross" | "momentum";

export type Granularity = "5m" | "1h";

export const MARKETS: {
  id: MarketId;
  base: string;
  quote: string;
  name: string;
}[] = [
  { id: "BTC-USD", base: "BTC", quote: "USD", name: "Bitcoin" },
  { id: "ETH-USD", base: "ETH", quote: "USD", name: "Ether" },
  { id: "SOL-USD", base: "SOL", quote: "USD", name: "Solana" },
  { id: "XRP-USD", base: "XRP", quote: "USD", name: "XRP" },
  { id: "DOGE-USD", base: "DOGE", quote: "USD", name: "Dogecoin" },
  { id: "AVAX-USD", base: "AVAX", quote: "USD", name: "Avalanche" },
  { id: "LINK-USD", base: "LINK", quote: "USD", name: "Chainlink" },
  { id: "LTC-USD", base: "LTC", quote: "USD", name: "Litecoin" },
  { id: "ADA-USD", base: "ADA", quote: "USD", name: "Cardano" },
  { id: "ATOM-USD", base: "ATOM", quote: "USD", name: "Cosmos" },
];

export const MARKET_IDS = MARKETS.map((m) => m.id);

export function marketById(id: string) {
  return MARKETS.find((m) => m.id === id) ?? MARKETS[0];
}

export const STRATEGIES: {
  id: StrategyId;
  name: string;
  blurb: string;
}[] = [
  {
    id: "rsi",
    name: "RSI reversion",
    blurb: "Buy washed-out prints. Sell when the tape gets crowded.",
  },
  {
    id: "grid",
    name: "Grid",
    blurb: "Layer bids and offers around the last fill.",
  },
  {
    id: "ma_cross",
    name: "Trend cross",
    blurb: "Ride a fast / slow average cross. Flat on the fade.",
  },
  {
    id: "dca",
    name: "DCA",
    blurb: "Spend a fixed ticket on a clock. No opinion, just cadence.",
  },
  {
    id: "momentum",
    name: "Momentum",
    blurb: "Lean into a streak of green or red candles.",
  },
];

export function strategyById(id: string) {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
}

export const STARTING_CASH = 25_000;
export const DEFAULT_ALLOCATION = 2_500;
export const FEE_RATE = 0.001;

export const GRANULARITY_SECONDS: Record<Granularity, number> = {
  "5m": 300,
  "1h": 3600,
};

export type BotParams = {
  dcaUsd: number;
  dcaEvery: number;
  gridPct: number;
  rsiPeriod: number;
  rsiBuy: number;
  rsiSell: number;
  fast: number;
  slow: number;
  streak: number;
};

export const DEFAULT_PARAMS: BotParams = {
  dcaUsd: 80,
  dcaEvery: 6,
  gridPct: 0.9,
  rsiPeriod: 14,
  rsiBuy: 38,
  rsiSell: 62,
  fast: 9,
  slow: 21,
  streak: 3,
};

export type BotTemplate = {
  id: string;
  name: string;
  symbol: MarketId;
  strategy: StrategyId;
  allocation: number;
  params: Partial<BotParams>;
};

export const TEMPLATES: BotTemplate[] = [
  {
    id: "rsi-btc",
    name: "RSI · Bitcoin",
    symbol: "BTC-USD",
    strategy: "rsi",
    allocation: 3_000,
    params: { rsiPeriod: 14, rsiBuy: 38, rsiSell: 62 },
  },
  {
    id: "grid-eth",
    name: "Grid · Ether",
    symbol: "ETH-USD",
    strategy: "grid",
    allocation: 3_000,
    params: { gridPct: 0.85 },
  },
  {
    id: "cross-sol",
    name: "Cross · Solana",
    symbol: "SOL-USD",
    strategy: "ma_cross",
    allocation: 2_500,
    params: { fast: 9, slow: 21 },
  },
  {
    id: "dca-btc",
    name: "DCA · Bitcoin",
    symbol: "BTC-USD",
    strategy: "dca",
    allocation: 2_000,
    params: { dcaUsd: 75, dcaEvery: 6 },
  },
  {
    id: "mom-doge",
    name: "Momentum · Doge",
    symbol: "DOGE-USD",
    strategy: "momentum",
    allocation: 1_500,
    params: { streak: 3 },
  },
];
