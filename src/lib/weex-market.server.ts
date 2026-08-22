import type { Candle } from "./engine";
import { TOP25, type AutoCoin } from "./universe";

export type WeexSpec = {
  symbol: string;
  maxLeverage: number;
  quantityPrecision: number;
  pricePrecision: number;
  minOrderSize: number;
};

type CacheEntry<T> = { at: number; value: T };

let specCache: CacheEntry<Map<string, WeexSpec>> | null = null;
const klineCache = new Map<string, CacheEntry<Candle[]>>();
const pxCache = new Map<string, CacheEntry<number>>();

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "vela-auto" },
  });
  if (!res.ok) throw new Error(`weex market ${res.status}`);
  return (await res.json()) as T;
}

export async function getWeexSpecs(): Promise<Map<string, WeexSpec>> {
  const now = Date.now();
  if (specCache && now - specCache.at < 10 * 60_000) return specCache.value;
  const raw = await fetchJson<{
    symbols: {
      symbol: string;
      maxLeverage: number;
      quantityPrecision: number;
      pricePrecision: number;
      minOrderSize: number | string;
    }[];
  }>("https://api-contract.weex.com/capi/v3/market/exchangeInfo");
  const map = new Map<string, WeexSpec>();
  for (const s of raw.symbols ?? []) {
    map.set(s.symbol, {
      symbol: s.symbol,
      maxLeverage: Number(s.maxLeverage) || 20,
      quantityPrecision: Number(s.quantityPrecision),
      pricePrecision: Number(s.pricePrecision) || 4,
      minOrderSize: Number(s.minOrderSize) || 0,
    });
  }
  specCache = { at: now, value: map };
  return map;
}

export async function specFor(coin: AutoCoin): Promise<WeexSpec> {
  const specs = await getWeexSpecs();
  return (
    specs.get(coin.weex) ?? {
      symbol: coin.weex,
      maxLeverage: coin.fallbackMax,
      quantityPrecision: 3,
      pricePrecision: 4,
      minOrderSize: 0,
    }
  );
}

export function formatWeexQty(qty: number, precision: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return "0";
  if (precision >= 0) {
    const step = 10 ** -precision;
    const n = Math.floor(qty / step) * step;
    return n.toFixed(precision);
  }
  const step = 10 ** -precision;
  const n = Math.floor(qty / step) * step;
  return String(Math.max(n, step));
}

export function formatWeexPx(px: number, precision: number): string {
  if (!Number.isFinite(px)) return "0";
  return px.toFixed(Math.max(0, precision));
}

export async function getWeexKlines(symbol: string, interval = "1h", limit = 120): Promise<Candle[]> {
  const key = `${symbol}:${interval}:${limit}`;
  const now = Date.now();
  const hit = klineCache.get(key);
  if (hit && now - hit.at < 25_000) return hit.value;
  const raw = await fetchJson<unknown[]>(
    `https://api-contract.weex.com/capi/v3/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
  );
  const candles: Candle[] = raw
    .map((row) => {
      const r = row as (string | number)[];
      return {
        time: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      };
    })
    .filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
  if (candles.length < 20) throw new Error(`thin ${symbol}`);
  klineCache.set(key, { at: now, value: candles });
  return candles;
}

export async function getWeexLast(symbol: string): Promise<number> {
  const now = Date.now();
  const hit = pxCache.get(symbol);
  if (hit && now - hit.at < 6_000) return hit.value;
  const raw = await fetchJson<{ price: string }>(
    `https://api-contract.weex.com/capi/v3/market/symbolPrice?symbol=${encodeURIComponent(symbol)}`,
  );
  const px = Number(raw.price);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`px ${symbol}`);
  pxCache.set(symbol, { at: now, value: px });
  return px;
}

export async function loadTop25Hours(): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  await Promise.all(
    TOP25.map(async (c) => {
      try {
        out[c.weex] = await getWeexKlines(c.weex, "1h", 120);
      } catch {
        /* skip thin */
      }
    }),
  );
  return out;
}

export async function universeCard() {
  const specs = await getWeexSpecs().catch(() => new Map<string, WeexSpec>());
  return TOP25.map((c) => ({
    id: c.id,
    weex: c.weex,
    name: c.name,
    maxLeverage: specs.get(c.weex)?.maxLeverage ?? c.fallbackMax,
  }));
}

const bookCache = new Map<string, CacheEntry<{ bid: number; ask: number }>>();
const fundCache = new Map<string, CacheEntry<number>>();

export async function getBookTicker(symbol: string): Promise<{ bid: number; ask: number } | null> {
  const now = Date.now();
  const hit = bookCache.get(symbol);
  if (hit && now - hit.at < 12_000) return hit.value;
  try {
    const raw = await fetchJson<Record<string, string> | Record<string, string>[]>(
      `https://api-contract.weex.com/capi/v3/market/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`,
    );
    const row = Array.isArray(raw) ? raw[0] : raw;
    const bid = Number(row?.bidPrice ?? row?.bid);
    const ask = Number(row?.askPrice ?? row?.ask);
    if (!(bid > 0 && ask > 0)) return null;
    const value = { bid, ask };
    bookCache.set(symbol, { at: now, value });
    return value;
  } catch {
    return null;
  }
}

export async function getFundingRate(symbol: string): Promise<number | null> {
  const now = Date.now();
  const hit = fundCache.get(symbol);
  if (hit && now - hit.at < 60_000) return hit.value;
  try {
    const raw = await fetchJson<Record<string, string> | Record<string, string>[]>(
      `https://api-contract.weex.com/capi/v3/market/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
    );
    const row = Array.isArray(raw) ? raw[0] : raw;
    const rate = Number(row?.lastFundingRate ?? row?.fundingRate ?? row?.interestRate);
    if (!Number.isFinite(rate)) return null;
    fundCache.set(symbol, { at: now, value: rate });
    return rate;
  } catch {
    return null;
  }
}

export async function getWeexFourHour(symbol: string): Promise<Candle[]> {
  return getWeexKlines(symbol, "4h", 60);
}
