import { GRANULARITY_SECONDS, MARKET_IDS, type Granularity, type MarketId } from "./markets";
import type { Candle } from "./engine";

export type Ticker = {
  id: MarketId;
  last: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  changePct: number;
};

type CacheEntry<T> = { at: number; value: T };

let tickerCache: CacheEntry<Ticker[]> | null = null;
const candleCache = new Map<string, CacheEntry<Candle[]>>();

const BASES: Record<MarketId, number> = {
  "BTC-USD": 64000,
  "ETH-USD": 1900,
  "SOL-USD": 77,
  "XRP-USD": 1,
  "DOGE-USD": 0.07,
  "AVAX-USD": 6.3,
  "LINK-USD": 9.5,
  "LTC-USD": 44,
  "ADA-USD": 0.17,
  "ATOM-USD": 1.4,
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "vela-paper-desk" },
  });
  if (!res.ok) throw new Error(`market ${res.status}`);
  return (await res.json()) as T;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function syntheticCandles(id: MarketId, gran: Granularity, count: number): Candle[] {
  const seconds = GRANULARITY_SECONDS[gran];
  const now = Math.floor(Date.now() / 1000);
  const aligned = now - (now % seconds);
  const seed = hash(id);
  let px = BASES[id];
  const out: Candle[] = [];
  for (let i = count; i >= 1; i -= 1) {
    const t = aligned - i * seconds;
    const rnd = ((hash(`${seed}:${t}`) % 10000) / 10000) * 2 - 1;
    const close = Math.max(px * (1 + 0.00015 + rnd * 0.006), px * 0.2);
    const open = px;
    const high = Math.max(open, close) * (1 + Math.abs(rnd) * 0.003);
    const low = Math.min(open, close) * (1 - Math.abs(rnd) * 0.003);
    px = close;
    out.push({
      time: t * 1000,
      open,
      high,
      low,
      close,
      volume: 100 + (hash(`${t}`) % 400),
    });
  }
  return out;
}

function syntheticTickers(): Ticker[] {
  return MARKET_IDS.map((id) => {
    const candles = syntheticCandles(id, "1h", 24);
    const last = candles[candles.length - 1]!.close;
    const open = candles[0]!.open;
    return {
      id,
      last,
      open,
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
      volume: candles.reduce((s, c) => s + c.volume, 0),
      changePct: open ? ((last - open) / open) * 100 : 0,
    };
  });
}

export async function getTickers(): Promise<Ticker[]> {
  const now = Date.now();
  if (tickerCache && now - tickerCache.at < 8_000) return tickerCache.value;
  try {
    const rows = await Promise.all(
      MARKET_IDS.map(async (id) => {
        const stats = await fetchJson<{
          open: string;
          high: string;
          low: string;
          last: string;
          volume: string;
        }>(`https://api.exchange.coinbase.com/products/${id}/stats`);
        const last = Number(stats.last);
        const open = Number(stats.open);
        return {
          id,
          last,
          open,
          high: Number(stats.high),
          low: Number(stats.low),
          volume: Number(stats.volume),
          changePct: open ? ((last - open) / open) * 100 : 0,
        } satisfies Ticker;
      }),
    );
    tickerCache = { at: now, value: rows };
    return rows;
  } catch {
    if (tickerCache) return tickerCache.value;
    return syntheticTickers();
  }
}

export async function getCandles(id: MarketId, gran: Granularity, limit = 200): Promise<Candle[]> {
  const key = `${id}:${gran}:${limit}`;
  const now = Date.now();
  const hit = candleCache.get(key);
  if (hit && now - hit.at < 20_000) return hit.value;
  try {
    const raw = await fetchJson<number[][]>(
      `https://api.exchange.coinbase.com/products/${id}/candles?granularity=${GRANULARITY_SECONDS[gran]}`,
    );
    const candles = raw
      .map((row) => ({
        time: row[0]! * 1000,
        low: row[1]!,
        high: row[2]!,
        open: row[3]!,
        close: row[4]!,
        volume: row[5]!,
      }))
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
    if (candles.length < 10) throw new Error("thin");
    candleCache.set(key, { at: now, value: candles });
    return candles;
  } catch {
    if (hit) return hit.value;
    return syntheticCandles(id, gran, limit);
  }
}

export async function lastPrice(id: MarketId): Promise<number> {
  const tape = await getTickers();
  return tape.find((t) => t.id === id)?.last ?? BASES[id];
}
