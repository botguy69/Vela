import { DEFAULT_PARAMS, FEE_RATE, type BotParams, type StrategyId } from "./markets";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Book = {
  cash: number;
  qty: number;
  avgEntry: number;
  lastActionPx: number;
  dcaCount: number;
  prevFast: number | null;
  prevSlow: number | null;
};

export type Fill = {
  side: "buy" | "sell";
  qty: number;
  price: number;
  fee: number;
  pnl: number | null;
  reason: string;
  time: number;
};

export type EquityPoint = {
  time: number;
  equity: number;
};

function sma(values: number[], period: number, end: number): number | null {
  if (end + 1 < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i += 1) sum += values[i]!;
  return sum / period;
}

function rsiAt(closes: number[], period: number, end: number): number | null {
  if (end < period) return null;
  let gain = 0;
  let loss = 0;
  const start = end - period;
  for (let i = start + 1; i <= end; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function emptyBook(cash: number, lastPx = 0): Book {
  return {
    cash,
    qty: 0,
    avgEntry: 0,
    lastActionPx: lastPx,
    dcaCount: 0,
    prevFast: null,
    prevSlow: null,
  };
}

export function mark(book: Book, px: number): number {
  return book.cash + book.qty * px;
}

function buy(
  book: Book,
  usd: number,
  price: number,
  reason: string,
  time: number,
): Fill | null {
  const spend = Math.min(usd, book.cash);
  if (spend < 2 || price <= 0) return null;
  const fee = spend * FEE_RATE;
  const qty = (spend - fee) / price;
  if (qty <= 0) return null;
  const newQty = book.qty + qty;
  book.avgEntry = (book.avgEntry * book.qty + price * qty) / newQty;
  book.qty = newQty;
  book.cash -= spend;
  book.lastActionPx = price;
  return { side: "buy", qty, price, fee, pnl: null, reason, time };
}

function sell(
  book: Book,
  fraction: number,
  price: number,
  reason: string,
  time: number,
): Fill | null {
  const qty = book.qty * Math.min(1, Math.max(0, fraction));
  if (qty <= 0 || price <= 0 || qty * price < 2) return null;
  const gross = qty * price;
  const fee = gross * FEE_RATE;
  const net = gross - fee;
  const pnl = net - qty * book.avgEntry;
  book.qty -= qty;
  book.cash += net;
  if (book.qty < 1e-10) {
    book.qty = 0;
    book.avgEntry = 0;
  }
  book.lastActionPx = price;
  return { side: "sell", qty, price, fee, pnl, reason, time };
}

export function stepStrategy(
  strategy: StrategyId,
  params: BotParams,
  book: Book,
  candles: Candle[],
  index: number,
): Fill[] {
  const candle = candles[index];
  if (!candle) return [];
  const px = candle.close;
  const fills: Fill[] = [];
  if (book.lastActionPx <= 0) book.lastActionPx = px;

  if (strategy === "dca") {
    book.dcaCount += 1;
    if (book.dcaCount >= params.dcaEvery) {
      const fill = buy(book, params.dcaUsd, px, `DCA every ${params.dcaEvery} bars`, candle.time);
      if (fill) fills.push(fill);
      book.dcaCount = 0;
    }
    return fills;
  }

  if (strategy === "grid") {
    const down = book.lastActionPx * (1 - params.gridPct / 100);
    const up = book.lastActionPx * (1 + params.gridPct / 100);
    if (px <= down) {
      const ticket = Math.max(book.cash * 0.18, 25);
      const fill = buy(book, ticket, px, `Grid bid −${params.gridPct.toFixed(2)}%`, candle.time);
      if (fill) fills.push(fill);
    } else if (px >= up && book.qty > 0) {
      const fill = sell(book, 0.35, px, `Grid offer +${params.gridPct.toFixed(2)}%`, candle.time);
      if (fill) fills.push(fill);
    }
    return fills;
  }

  if (strategy === "rsi") {
    const closes = candles.slice(0, index + 1).map((c) => c.close);
    const rsi = rsiAt(closes, params.rsiPeriod, closes.length - 1);
    if (rsi == null) return fills;
    if (rsi <= params.rsiBuy && book.cash > 20) {
      const fill = buy(
        book,
        book.cash * 0.45,
        px,
        `RSI ${rsi.toFixed(1)} ≤ ${params.rsiBuy}`,
        candle.time,
      );
      if (fill) fills.push(fill);
    } else if (rsi >= params.rsiSell && book.qty > 0) {
      const fill = sell(
        book,
        1,
        px,
        `RSI ${rsi.toFixed(1)} ≥ ${params.rsiSell}`,
        candle.time,
      );
      if (fill) fills.push(fill);
    }
    return fills;
  }

  if (strategy === "ma_cross") {
    const closes = candles.slice(0, index + 1).map((c) => c.close);
    const end = closes.length - 1;
    const fast = sma(closes, params.fast, end);
    const slow = sma(closes, params.slow, end);
    if (fast == null || slow == null) {
      book.prevFast = fast;
      book.prevSlow = slow;
      return fills;
    }
    const prevFast = book.prevFast;
    const prevSlow = book.prevSlow;
    if (prevFast != null && prevSlow != null) {
      const golden = prevFast <= prevSlow && fast > slow;
      const death = prevFast >= prevSlow && fast < slow;
      if (golden) {
        const fill = buy(book, book.cash, px, `${params.fast}/${params.slow} golden cross`, candle.time);
        if (fill) fills.push(fill);
      } else if (death) {
        const fill = sell(book, 1, px, `${params.fast}/${params.slow} death cross`, candle.time);
        if (fill) fills.push(fill);
      }
    }
    book.prevFast = fast;
    book.prevSlow = slow;
    return fills;
  }

  // momentum
  const n = params.streak;
  if (index + 1 >= n) {
    const window = candles.slice(index - n + 1, index + 1);
    const up = window.every((c) => c.close >= c.open);
    const down = window.every((c) => c.close <= c.open);
    if (up && book.cash > 20) {
      const fill = buy(book, book.cash * 0.4, px, `${n}-bar green streak`, candle.time);
      if (fill) fills.push(fill);
    } else if (down && book.qty > 0) {
      const fill = sell(book, 0.6, px, `${n}-bar red streak`, candle.time);
      if (fill) fills.push(fill);
    }
  }
  return fills;
}

export function mergeParams(partial?: Partial<BotParams> | null): BotParams {
  return { ...DEFAULT_PARAMS, ...(partial ?? {}) };
}

export function runBacktest(opts: {
  strategy: StrategyId;
  params?: Partial<BotParams> | null;
  candles: Candle[];
  cash: number;
}): { fills: Fill[]; equity: EquityPoint[]; book: Book } {
  const params = mergeParams(opts.params);
  const book = emptyBook(opts.cash, opts.candles[0]?.close ?? 0);
  const fills: Fill[] = [];
  const equity: EquityPoint[] = [];
  for (let i = 0; i < opts.candles.length; i += 1) {
    const made = stepStrategy(opts.strategy, params, book, opts.candles, i);
    fills.push(...made);
    const c = opts.candles[i]!;
    equity.push({ time: c.time, equity: mark(book, c.close) });
  }
  return { fills, equity, book };
}

export function applyNewCandles(opts: {
  strategy: StrategyId;
  params?: Partial<BotParams> | null;
  candles: Candle[];
  book: Book;
  lastTime: number | null;
}): { fills: Fill[]; book: Book } {
  const params = mergeParams(opts.params);
  const fills: Fill[] = [];
  for (let i = 0; i < opts.candles.length; i += 1) {
    const c = opts.candles[i]!;
    if (opts.lastTime != null && c.time <= opts.lastTime) continue;
    fills.push(...stepStrategy(opts.strategy, params, opts.book, opts.candles, i));
  }
  return { fills, book: opts.book };
}
