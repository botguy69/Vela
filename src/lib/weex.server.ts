import { createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const BASE = "https://api-contract.weex.com";

export type WeexCreds = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
};

function material(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET || "vela-preview-wrap";
  return scryptSync(secret, "vela-weex-v1", 32);
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", material(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function openSeal(packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", material(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function sign(secret: string, timestamp: string, method: string, path: string, query: string, body: string) {
  const qs = query ? `?${query}` : "";
  const message = `${timestamp}${method.toUpperCase()}${path}${qs}${body}`;
  return createHmac("sha256", secret).update(message).digest("base64");
}

export type WeexResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export async function weexRequest<T>(opts: {
  creds: WeexCreds;
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}): Promise<WeexResult<T>> {
  const query = opts.query
    ? Object.entries(opts.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const body = opts.body ? JSON.stringify(opts.body) : "";
  const timestamp = Date.now().toString();
  const signature = sign(opts.creds.apiSecret, timestamp, opts.method, opts.path, query, body);
  const url = `${BASE}${opts.path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    "ACCESS-KEY": opts.creds.apiKey,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": opts.creds.passphrase,
    "User-Agent": "Mozilla/5.0 VELA/1.0",
  };
  if (opts.method === "POST" || opts.method === "DELETE") {
    headers["Content-Type"] = "application/json";
  }
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 4000);
    const res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.method === "POST" || (opts.method === "DELETE" && body) ? body : undefined,
      signal: ac.signal,
    });
    clearTimeout(to);
    const text = await res.text();
    let parsed: Record<string, unknown> | unknown = text;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* raw */
    }
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const code = obj && "code" in obj ? obj.code : undefined;
    const msg = obj && typeof obj.msg === "string" ? obj.msg : "";
    const codeNum = typeof code === "number" ? code : Number(code);
    const authFail =
      res.status === 401 ||
      res.status === 403 ||
      codeNum === -1044 ||
      codeNum === -1047 ||
      codeNum === -1049 ||
      codeNum === -1052;
    if (!res.ok || authFail || (Number.isFinite(codeNum) && codeNum < 0)) {
      const err = weexHumanError(res.status, codeNum, msg, text);
      return { ok: false, error: err, status: authFail ? 401 : res.status };
    }
    return { ok: true, data: parsed as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "WEEX network error", status: 0 };
  }
}

function weexHumanError(status: number, code: number, msg: string, text: string): string {
  const blob = `${msg} ${text}`;
  if (/ip.?white.?list|not (?:in|on) the white.?list|whitelist/i.test(blob)) {
    return "WEEX: this IP isn’t on the key whitelist. If whitelist is already OFF, ignore — next tick retries.";
  }
  if (status === 403 && /cloudflare|cf-ray/i.test(blob)) {
    return "WEEX CDN 403 from Render. Not your key. Next tick retries.";
  }
  if (code === -1044 || code === -1047 || code === -1049 || status === 401) {
    return "WEEX says the key, secret, or passphrase is wrong. Passphrase must be letters/numbers only. Copy secret again — it is shown only once.";
  }
  if (code === -1052) {
    return "Key is missing Futures permission. Edit the key on WEEX and enable Futures / contract trade.";
  }
  const raw = (msg || text).replace(/\s+/g, " ").trim().slice(0, 180);
  if (status === 403) return `WEEX 403${raw ? `: ${raw}` : ""}. Keys are fine if other tickets are live — next tick retries.`;
  return raw || `WEEX ${status || code}`;
}

export function orderPath(sim: boolean): string {
  return sim ? "/capi/v3/sim/order" : "/capi/v3/order";
}

export function accountPath(sim: boolean): string {
  return sim ? "/capi/v3/sim/account" : "/capi/v3/account";
}

export async function verifyKeys(creds: WeexCreds): Promise<WeexResult<unknown>> {
  return getWeexEquity(creds);
}

function pickUsdt(rows: unknown[]): { equity: number; available: number; asset: string } | null {
  const list = rows as {
    asset?: string;
    coinName?: string;
    balance?: string;
    availableBalance?: string;
    available?: string;
  }[];
  const usdt = list.find((r) => (r.asset ?? r.coinName) === "USDT") ?? list[0];
  if (!usdt) return null;
  const wallet = Number(usdt.balance);
  const available = Number(usdt.availableBalance ?? usdt.available ?? 0);
  if (!Number.isFinite(wallet) && !Number.isFinite(available)) return null;
  // WEEX v3 "balance" = UI Margin balance (wallet + uPnL already). Never add unrealizePnl.
  const equity = Number.isFinite(wallet) ? wallet : available;
  return {
    equity: Math.max(0, Number.isFinite(equity) ? equity : 0),
    available: Number.isFinite(available) ? available : 0,
    asset: usdt.asset ?? usdt.coinName ?? "USDT",
  };
}

function rowsFrom(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.data)) return o.data;
  if (Array.isArray(o.balances)) return o.balances;
  if (Array.isArray(o.list)) return o.list;
  if (Array.isArray(o.positions)) return o.positions;
  if (o.data && typeof o.data === "object") {
    const d = o.data as Record<string, unknown>;
    for (const k of ["balances", "list", "positions", "positionList", "holdList", "records", "result", "entrustedList", "orderList", "orders", "tpslList", "algoOrderList", "planList", "algoOrders", "openAlgoOrders", "order_data"]) {
      if (Array.isArray(d[k])) return d[k] as unknown[];
    }
    if ("asset" in d || "coinName" in d || "symbol" in d || "holdVol" in d) return [d];
  }
  if ("asset" in o || "coinName" in o || "symbol" in o || "holdVol" in o) return [o];
  return [];
}

export async function getWeexEquity(creds: WeexCreds): Promise<
  WeexResult<{ equity: number; available: number; asset: string }>
> {
  const v3 = await weexRequest<unknown>({ creds, method: "GET", path: "/capi/v3/account/balance" });
  if (v3.ok) {
    const picked = pickUsdt(rowsFrom(v3.data));
    if (picked) return { ok: true, data: picked };
  }
  const v2 = await weexRequest<unknown>({ creds, method: "GET", path: "/capi/v2/account/assets" });
  if (v2.ok) {
    const picked = pickUsdt(rowsFrom(v2.data));
    if (picked) return { ok: true, data: picked };
  }
  if (!v3.ok) return v3;
  if (!v2.ok) return v2;
  return { ok: false, error: "WEEX answered but no USDT futures row. Deposit USDT to futures, not spot.", status: 200 };
}

function numField(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parsePosition(row: unknown): {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entry: number;
  pnl: number | null;
  mark: number;
  bePx: number;
} | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const symbol = String(r.symbol ?? r.contract ?? "")
    .replace(/_/g, "")
    .replace(/^cmt/i, "")
    .toUpperCase();
  const q = Math.abs(
    numField(r.positionAmt, r.holdVol, r.positionSize, r.size, r.volume, r.qty, r.total) ?? 0,
  );
  if (!symbol || !(q > 0)) return null;
  const sideRaw = String(r.positionSide ?? r.holdSide ?? r.side ?? r.posSide ?? "").toLowerCase();
  const amt = numField(r.positionAmt) ?? 0;
  const side: "long" | "short" =
    sideRaw.includes("short") || sideRaw === "sell" || sideRaw === "2" || amt < 0
      ? "short"
      : "long";
  const entry =
    numField(r.entryPrice, r.openPriceAvg, r.averagePrice, r.avgPrice) ??
    (numField(r.openValue) != null && q > 0 ? (numField(r.openValue) as number) / q : 0);
  const rawPnl = numField(
    r.unrealizedPnl,
    r.unRealizedProfit,
    r.unrealizedProfit,
    r.unrealizePnl,
    r.unrealizedPL,
    r.unrealisedPnl,
    r.upl,
    r.floatProfit,
    r.uPnL,
  );
  const mark = numField(r.markPrice, r.marketPrice, r.lastPrice, r.mark) ?? 0;
  const bePx = numField(r.breakEvenPrice, r.breakevenPrice, r.breakEven, r.avgBreakEvenPrice) ?? 0;
  if (Number.isFinite(entry) && entry > 0 && q * entry < 0.05) return null;
  let pnl = rawPnl;
  if (pnl == null && mark > 0 && entry > 0) {
    const signed = side === "short" ? entry - mark : mark - entry;
    pnl = signed * q;
  }
  return {
    symbol,
    side,
    qty: q,
    entry: Number.isFinite(entry) ? entry : 0,
    pnl: pnl != null && Number.isFinite(pnl) ? pnl : null,
    mark,
    bePx: bePx > 0 ? bePx : 0,
  };
}

function positionQtyFrom(raw: unknown, symbol: string): number | null {
  const rows = rowsFrom(raw);
  const hit = rows
    .map(parsePosition)
    .find((p) => p && (p.symbol === symbol || p.symbol.replace("_", "") === symbol));
  return hit?.qty ?? null;
}

const posMemo = new Map<
  string,
  {
    at: number;
    data: { symbol: string; side: "long" | "short"; qty: number; entry: number; pnl: number | null; mark: number; bePx: number }[] | null;
  }
>();

export async function listWeexPositions(
  creds: WeexCreds,
): Promise<{ symbol: string; side: "long" | "short"; qty: number; entry: number; pnl: number | null; mark: number; bePx: number }[] | null> {
  const memo = posMemo.get(creds.apiKey);
  if (memo && Date.now() - memo.at < 8000) return memo.data;
  const paths = [
    "/capi/v3/account/position/allPosition",
    "/capi/v3/positionRisk",
    "/capi/v3/account/positions",
    "/capi/v2/account/positions",
  ];
  const replies = await Promise.all(
    paths.map((path) => weexRequest<unknown>({ creds, method: "GET", path })),
  );
  let sawOk = false;
  const uniq = new Map<
    string,
    { symbol: string; side: "long" | "short"; qty: number; entry: number; pnl: number | null; mark: number; bePx: number }
  >();
  for (const res of replies) {
    if (!res.ok) continue;
    sawOk = true;
    const parsed = rowsFrom(res.data).map(parsePosition).filter((x): x is NonNullable<typeof x> => x != null);
    for (const pos of parsed) {
      const k = `${pos.symbol}|${pos.side}`;
      const prev = uniq.get(k);
      if (!prev) {
        uniq.set(k, pos);
        continue;
      }
      const score = (p: typeof pos) => (p.pnl != null ? 4 : 0) + (p.mark > 0 ? 2 : 0) + (p.entry > 0 ? 1 : 0);
      if (score(pos) > score(prev)) uniq.set(k, { ...pos, bePx: pos.bePx || prev.bePx });
      else if (score(pos) === score(prev) && pos.pnl != null) uniq.set(k, { ...prev, pnl: pos.pnl, mark: pos.mark || prev.mark, bePx: pos.bePx || prev.bePx });
    }
  }
  const data = uniq.size ? [...uniq.values()] : sawOk ? [] : null;
  posMemo.set(creds.apiKey, { at: Date.now(), data });
  return data;
}

export type WeexClose = {
  symbol: string;
  side?: "long" | "short";
  pnl: number;
  closePx: number;
  entry: number;
  qty: number;
  ts: number;
};

function parseClose(r: Record<string, unknown>): WeexClose | null {
  const symbol = String(r.symbol ?? r.contract ?? r.coin ?? "")
    .replace(/_/g, "")
    .replace(/^cmt/i, "")
    .toUpperCase();
  const pnl = Number(
    r.realizedPnl ??
      r.realisedPnl ??
      r.closePnl ??
      r.netProfit ??
      r.achievedProfits ??
      r.income ??
      r.pnl ??
      r.profit ??
      r.closeProfit,
  );
  if (!symbol.includes("USDT") || !Number.isFinite(pnl)) return null;
  let ts = Number(r.cTime ?? r.uTime ?? r.closeTime ?? r.updatedTime ?? r.time ?? r.timestamp ?? 0);
  if (ts > 0 && ts < 1e12) ts *= 1000;
  const closePx = Number(
    r.closePrice ?? r.closeAvgPrice ?? r.avgClosePrice ?? r.price ?? r.markPrice ?? 0,
  );
  const entry = Number(
    r.openPriceAvg ??
      r.openAvgPrice ??
      r.entryPrice ??
      r.openPrice ??
      r.averageOpenPrice ??
      r.openPriceAvg ??
      r.avgOpenPrice ??
      0,
  );
  const qty = Math.abs(
    Number(
      r.closeSize ??
        r.size ??
        r.qty ??
        r.holdVol ??
        r.amount ??
        r.closeTotalPos ??
        r.maxOpen ??
        r.maxHold ??
        r.holdAvai ??
        r.volume ??
        0,
    ),
  );
  const sideRaw = String(r.positionSide ?? r.holdSide ?? r.side ?? r.posSide ?? "").toLowerCase();
  const side: "long" | "short" | undefined = sideRaw.includes("short") || sideRaw === "sell" || sideRaw === "2"
    ? "short"
    : sideRaw.includes("long") || sideRaw === "buy" || sideRaw === "1"
      ? "long"
      : undefined;
  return {
    symbol,
    side,
    pnl,
    closePx: Number.isFinite(closePx) ? closePx : 0,
    entry: Number.isFinite(entry) ? entry : 0,
    qty,
    ts,
  };
}

export async function listWeexClosedPnl(creds: WeexCreds, symbol?: string): Promise<WeexClose[]> {
  const sym = symbol?.replace(/_/g, "").toUpperCase();
  const q = (extra: Record<string, string> = {}) => ({
    limit: "100",
    ...(sym ? { symbol: sym } : {}),
    ...extra,
  });
  const paths: { path: string; query?: Record<string, string> }[] = [
    { path: "/capi/v2/mix/position/history", query: q({ productType: "USDT-FUTURES" }) },
    { path: "/capi/v3/historyPositions", query: q() },
    { path: "/capi/v3/position/history", query: q() },
    { path: "/capi/v3/positionHistory", query: q() },
    { path: "/capi/v3/account/position/history", query: q() },
    { path: "/capi/v3/userTrades", query: q() },
    { path: "/capi/v3/income", query: { incomeType: "REALIZED_PNL", limit: "100", ...(sym ? { symbol: sym } : {}) } },
  ];
  const replies = await Promise.all(
    paths.map((p) => weexRequest<unknown>({ creds, method: "GET", path: p.path, query: p.query })),
  );
  for (const res of replies) {
    if (!res.ok) continue;
    const batch: WeexClose[] = [];
    const seen = new Set<string>();
    for (const row of rowsFrom(res.data)) {
      const hit = parseClose(row as Record<string, unknown>);
      if (!hit) continue;
      if (sym && hit.symbol.replace(/_/g, "").toUpperCase() !== sym) continue;
      const k = `${hit.symbol}|${hit.ts}|${hit.pnl.toFixed(4)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      batch.push(hit);
    }
    if (!batch.length) continue;
    const collapsed = collapseCloses(batch);
    collapsed.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return collapsed.slice(0, 200);
  }
  return [];
}

function collapseCloses(closes: WeexClose[]): WeexClose[] {
  const sorted = [...closes].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const same = (a: WeexClose, b: WeexClose) => {
    if (a.symbol !== b.symbol) return false;
    if ((a.side ?? "?") !== (b.side ?? "?")) return false;
    if (a.entry > 0 && b.entry > 0 && Math.abs(a.entry - b.entry) / a.entry > 0.006) return false;
    return true;
  };
  const groups: WeexClose[][] = [];
  for (const c of sorted) {
    let g: WeexClose[] | undefined;
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const arr = groups[i]!;
      if (!same(arr[0]!, c)) continue;
      const latest = Math.max(...arr.map((x) => x.ts || 0));
      if (Math.abs((c.ts || 0) - latest) <= 14 * 3600_000) {
        g = arr;
        break;
      }
    }
    if (g) g.push(c);
    else groups.push([c]);
  }
  const out: WeexClose[] = [];
  for (const arr of groups) {
    const full = [...arr].sort((a, b) => (b.qty || 0) - (a.qty || 0))[0]!;
    const maxQty = Math.max(...arr.map((c) => c.qty || 0));
    const entire = arr.find((c) => maxQty > 0 && (c.qty || 0) >= maxQty * 0.92 && Math.abs(c.pnl) >= Math.abs(full.pnl) * 0.9);
    if (entire) {
      out.push(entire);
      continue;
    }
    const last = arr.reduce((a, c) => ((c.ts || 0) >= (a.ts || 0) ? c : a));
    out.push({
      ...last,
      pnl: arr.reduce((s, c) => s + c.pnl, 0),
      qty: arr.reduce((s, c) => s + (c.qty || 0), 0) || maxQty,
      closePx: last.closePx,
      entry: arr.find((c) => c.entry > 0)?.entry ?? last.entry,
      ts: Math.max(...arr.map((c) => c.ts || 0)),
    });
  }
  return out;
}

export async function getWeexPositionQty(
  creds: WeexCreds,
  symbol: string,
): Promise<number | null> {
  const all = await listWeexPositions(creds);
  if (all == null) return null;
  const key = symbol.replace(/_/g, "").toUpperCase();
  const hit = all.find((p) => p.symbol.replace(/_/g, "").toUpperCase() === key);
  return hit?.qty ?? 0;
}

export async function setCrossMaxLeverage(creds: WeexCreds, symbol: string, leverage: number) {
  const margin = await weexRequest({
    creds,
    method: "POST",
    path: "/capi/v3/account/marginType",
    body: { symbol, marginType: "CROSSED", separatedType: "COMBINED" },
  });
  const lev = await weexRequest({
    creds,
    method: "POST",
    path: "/capi/v3/account/leverage",
    body: { symbol, marginType: "CROSSED", crossLeverage: String(leverage) },
  });
  return { margin, lev };
}

export async function placeWeexOrder(
  creds: WeexCreds,
  _sim: boolean,
  order: {
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    type: "LIMIT" | "MARKET";
    quantity: string;
    price?: string;
    clientOid: string;
    tp?: string;
    sl?: string;
  },
): Promise<WeexResult<unknown>> {
  const body: Record<string, string> = {
    symbol: order.symbol,
    side: order.side,
    positionSide: order.positionSide,
    type: order.type,
    quantity: order.quantity,
    newClientOrderId: order.clientOid.slice(0, 36),
  };
  if (order.price) body.price = order.price;
  // SL/TP only via ensureTakes after fill — attaching here duplicates SL-Mark (limit + market).
  if (order.type === "LIMIT") {
    body.timeInForce = "POST_ONLY";
    body.price = order.price ?? "";
  }
  const first = await weexRequest({ creds, method: "POST", path: "/capi/v3/order", body });
  if (first.ok || order.type !== "LIMIT") return first;
  body.timeInForce = "GTC";
  delete body.postOnly;
  return weexRequest({ creds, method: "POST", path: "/capi/v3/order", body });
}

export async function flattenWeex(
  creds: WeexCreds,
  order: {
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    quantity: string;
    clientOid: string;
  },
): Promise<WeexResult<unknown>> {
  const live = await getWeexPositionQty(creds, order.symbol);
  const want = Number(order.quantity);
  if (live != null && live > 0 && Number.isFinite(want) && want > 0 && live > want * 1.25) {
    return { ok: false, error: "refuse partial flatten — larger position live", status: 0 };
  }
  const qty = live != null && live > 0 ? String(live) : order.quantity;
  return weexRequest({
    creds,
    method: "POST",
    path: "/capi/v3/order",
    body: {
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      type: "MARKET",
      quantity: qty,
      newClientOrderId: order.clientOid.slice(0, 36),
      reduceOnly: "true",
    },
  });
}

export async function moveWeexStop(
  creds: WeexCreds,
  order: {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    stop: string;
    clientOid: string;
    quantity?: string;
  },
): Promise<WeexResult<unknown>> {
  return weexRequest({
    creds,
    method: "POST",
    path: "/capi/v3/placeTpSlOrder",
    body: {
      symbol: order.symbol,
      clientAlgoId: order.clientOid.slice(0, 36),
      planType: "STOP_LOSS",
      triggerPrice: order.stop,
      quantity: "0",
      positionSide: order.positionSide,
      triggerPriceType: "MARK_PRICE",
      reduceOnly: true,
    },
  });
}

export async function cancelWeexOrder(
  creds: WeexCreds,
  order: { symbol: string; clientOid: string },
): Promise<WeexResult<unknown>> {
  return weexRequest({
    creds,
    method: "DELETE",
    path: "/capi/v3/order",
    query: { symbol: order.symbol, origClientOrderId: order.clientOid.slice(0, 36) },
  });
}

function pairIds(symbol: string): string[] {
  const raw = symbol.replace(/^cmt_/i, "").replace(/_/g, "");
  const u = raw.toUpperCase();
  const base = u.replace(/USDT$/i, "").toLowerCase();
  return [...new Set([u, `cmt_${base}usdt`, symbol])];
}

export async function cancelWeexProtective(
  creds: WeexCreds,
  symbol: string,
  _holdSide?: "long" | "short",
) {
  const jobs: Promise<unknown>[] = [];
  for (const s of pairIds(symbol)) {
    jobs.push(weexRequest({ creds, method: "DELETE", path: "/capi/v3/algoOpenOrders", query: { symbol: s } }));
    jobs.push(weexRequest({ creds, method: "DELETE", path: "/capi/v3/allOpenOrders", query: { symbol: s } }));
    jobs.push(weexRequest({ creds, method: "DELETE", path: "/capi/v3/openOrders", query: { symbol: s } }));
  }
  await Promise.all(jobs.map((p) => p.catch(() => null)));
  let left = await listWeexAlgoRows(creds, symbol);
  if (left.length > 3) {
    await weexRequest({ creds, method: "DELETE", path: "/capi/v3/algoOpenOrders" }).catch(() => null);
    left = await listWeexAlgoRows(creds, symbol);
  }
  if (left.length) await cancelAlgoIds(creds, symbol, left.map((r) => r.id));
}

async function cancelAlgoIds(creds: WeexCreds, symbol: string, ids: string[]) {
  const uniq = [...new Set(ids.filter((id) => id && id !== "undefined"))].slice(0, 80);
  for (let i = 0; i < uniq.length; i += 8) {
    const chunk = uniq.slice(i, i + 8);
    await Promise.all(
      chunk.map((id) =>
        Promise.all([
          weexRequest({ creds, method: "DELETE", path: "/capi/v3/algoOrder", query: { orderId: id } }),
          weexRequest({ creds, method: "DELETE", path: "/capi/v3/order", query: { symbol, orderId: id } }),
          weexRequest({
            creds,
            method: "POST",
            path: "/capi/v2/order/cancel_order",
            body: { orderId: id, clientOid: id },
          }),
        ]).catch(() => null),
      ),
    );
  }
}

export async function listWeexAlgoRows(
  creds: WeexCreds,
  symbol: string,
): Promise<{ id: string; type: string; trigger: number; posSide: string; qty: number }[]> {
  const paths: { path: string; query: Record<string, string> }[] = [];
  for (const s of pairIds(symbol)) {
    paths.push({ path: "/capi/v3/algoOpenOrders", query: { symbol: s } });
    paths.push({ path: "/capi/v3/openAlgoOrders", query: { symbol: s } });
    paths.push({ path: "/capi/v3/openOrders", query: { symbol: s } });
    paths.push({ path: "/capi/v2/order/currentPlan", query: { symbol: s, limit: "100", page: "0" } });
  }
  const out: { id: string; type: string; trigger: number; posSide: string; qty: number }[] = [];
  const seen = new Set<string>();
  const replies = await Promise.all(
    paths.map((p) => weexRequest<unknown>({ creds, method: "GET", path: p.path, query: p.query })),
  );
  for (const res of replies) {
    if (!res.ok) continue;
    for (const row of rowsFrom(res.data)) {
      const o = row as Record<string, unknown>;
      const id = String(o.algoId ?? o.orderId ?? o.order_id ?? o.id ?? o.clientAlgoId ?? o.clientOid ?? o.clientOrderId ?? "");
      if (!id || id === "undefined" || seen.has(id)) continue;
      seen.add(id);
      let pos = String(o.positionSide ?? o.holdSide ?? o.posSide ?? o.tdPositionSide ?? "")
        .toUpperCase()
        .replace(/_USDT|_BOTH/g, "");
      if (!pos.includes("LONG") && !pos.includes("SHORT")) {
        const reduce = o.reduceOnly === true || String(o.reduceOnly ?? "") === "true";
        const sd = String(o.side ?? o.tradeSide ?? o.type ?? "").toUpperCase();
        if (reduce && (sd === "SELL" || sd.includes("CLOSE_LONG") || sd === "3" || sd === "5")) pos = "LONG";
        else if (reduce && (sd === "BUY" || sd.includes("CLOSE_SHORT") || sd === "4" || sd === "6")) pos = "SHORT";
        else if (sd === "3" || sd === "5") pos = "LONG";
        else if (sd === "4" || sd === "6") pos = "SHORT";
      }
      const plan = String(o.planType ?? o.type ?? o.orderType ?? "");
      out.push({
        id,
        type: plan,
        trigger: Number(o.triggerPrice ?? o.stopPrice ?? o.executePrice ?? o.price ?? o.presetTakeProfitPrice ?? o.presetStopLossPrice ?? 0),
        posSide: pos.includes("SHORT") ? "SHORT" : pos.includes("LONG") ? "LONG" : "",
        qty: Number(o.quantity ?? o.size ?? o.orderQty ?? o.qty ?? o.volume ?? o.sz ?? 0),
      });
    }
  }
  return out;
}

export async function trimWeexTakes(
  creds: WeexCreds,
  symbol: string,
  opts: { side: "long" | "short"; sl: number; tps: number[]; mark?: number },
): Promise<{ kept: number; killed: number; haveSl: boolean; haveTp: number; listed: number; wiped: boolean }> {
  const live = opts.side === "short" ? "SHORT" : "LONG";
  const rows = await listWeexAlgoRows(creds, symbol);
  const mark = opts.mark ?? 0;
  const sl = opts.sl;
  const tps = opts.tps.filter((p) => p > 0).slice(0, 2);
  const wrong = rows.filter((r) => r.posSide && r.posSide !== live);
  if (wrong.length || rows.length > 3) {
    await cancelWeexProtective(creds, symbol);
    return { kept: 0, killed: rows.length, haveSl: false, haveTp: 0, listed: rows.length, wiped: true };
  }
  const isStop = (r: { type: string; trigger: number; posSide: string }) => {
    if (r.posSide && r.posSide !== live) return false;
    if (/TAKE|PROFIT|^TP$|TP-|pos_profit|profit_plan/i.test(r.type) && !/STOP|LOSS/i.test(r.type)) return false;
    if (/STOP|LOSS|^SL$|SL-|pos_loss|loss_plan|STOP_MARKET/i.test(r.type)) return true;
    if (!(r.trigger > 0) || !(mark > 0)) return false;
    return opts.side === "long" ? r.trigger < mark * 0.9995 : r.trigger > mark * 1.0005;
  };
  const isTp = (r: { type: string; trigger: number; posSide: string }) => {
    if (r.posSide && r.posSide !== live) return false;
    if (/STOP|LOSS|^SL$|SL-|pos_loss|loss_plan/i.test(r.type) && !/TAKE|PROFIT/i.test(r.type)) return false;
    if (/TAKE|PROFIT|^TP$|TP-|pos_profit|profit_plan/i.test(r.type)) {
      if (!(r.trigger > 0) || !(mark > 0)) return true;
      return opts.side === "long" ? r.trigger > mark : r.trigger < mark;
    }
    if (!(r.trigger > 0) || !(mark > 0)) return false;
    return opts.side === "long" ? r.trigger > mark * 1.0005 : r.trigger < mark * 0.9995;
  };
  const keep = new Set<string>();
  const slRows = rows.filter(isStop).sort((a, b) => Math.abs(a.trigger - sl) - Math.abs(b.trigger - sl));
  if (slRows[0]) keep.add(slRows[0].id);
  const tpRows = rows.filter((r) => isTp(r) && !keep.has(r.id));
  for (const tp of tps) {
    const cand = tpRows
      .filter((r) => !keep.has(r.id))
      .sort((a, b) => Math.abs(a.trigger - tp) - Math.abs(b.trigger - tp))[0];
    if (cand && Math.abs(cand.trigger - tp) / tp < 0.01) keep.add(cand.id);
  }
  const kill = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (kill.length) await cancelAlgoIds(creds, symbol, kill);
  const haveSl = [...keep].some((id) => slRows.some((r) => r.id === id));
  const haveTp = Math.max(0, keep.size - (haveSl ? 1 : 0));
  return { kept: keep.size, killed: kill.length, haveSl, haveTp, listed: rows.length, wiped: false };
}

export async function listWeexAlgos(creds: WeexCreds, symbol: string): Promise<string[]> {
  return (await listWeexAlgoRows(creds, symbol)).map((r) => r.id);
}

/** Kill stop-loss tickets. Leaves take-profits. keepPx = the one BE stop to leave. */
export async function cancelWeexStops(
  creds: WeexCreds,
  symbol: string,
  opts?: { side?: "long" | "short"; mark?: number; keepPx?: number },
) {
  if (!(opts?.keepPx) || opts.keepPx <= 0) {
    await weexRequest({
      creds,
      method: "POST",
      path: "/capi/v2/mix/order/cancel-all-plan",
      body: { symbol, productType: "USDT-FUTURES", planType: "pos_loss", marginCoin: "USDT" },
    }).catch(() => null);
    await weexRequest({
      creds,
      method: "POST",
      path: "/capi/v3/algoOrder/cancelAll",
      body: { symbol, planType: "STOP_LOSS" },
    }).catch(() => null);
  }
  const rows = await listWeexAlgoRows(creds, symbol);
  const side = opts?.side;
  const mark = opts?.mark ?? 0;
  const keep = opts?.keepPx ?? 0;
  const ids: string[] = [];
  for (const r of rows) {
    const nearKeep = keep > 0 && r.trigger > 0 && Math.abs(r.trigger - keep) / keep < 0.0015;
    if (nearKeep) continue;
    const typed = /STOP|LOSS|^SL$|SL-|pos_loss|STOP_MARKET|STOP_LOSS/i.test(r.type);
    const tpTyped = /TAKE|PROFIT|^TP$|TP-|pos_profit|TAKE_PROFIT/i.test(r.type);
    const stopSide =
      side === "long" && mark > 0 && r.trigger > 0 && r.trigger < mark * 0.9994
        ? true
        : side === "short" && mark > 0 && r.trigger > 0 && r.trigger > mark * 1.0006
          ? true
          : false;
    const wrongSide =
      (side === "long" && mark > 0 && r.trigger > mark * 1.0005) ||
      (side === "short" && mark > 0 && r.trigger > 0 && r.trigger < mark * 0.9995);
    if (tpTyped && !typed && !wrongSide) continue;
    if (typed || stopSide || wrongSide) ids.push(r.id);
  }
  await cancelAlgoIds(creds, symbol, ids);
}

export async function placeWeexTake(
  creds: WeexCreds,
  order: {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    tp: string;
    quantity: string;
    clientOid: string;
  },
) {
  const v3 = await weexRequest({
    creds,
    method: "POST",
    path: "/capi/v3/placeTpSlOrder",
    body: {
      symbol: order.symbol,
      clientAlgoId: order.clientOid.slice(0, 36),
      planType: "TAKE_PROFIT",
      triggerPrice: order.tp,
      quantity: order.quantity,
      positionSide: order.positionSide,
      triggerPriceType: "MARK_PRICE",
      reduceOnly: true,
    },
  });
  if (v3.ok) return v3;
  return weexRequest({
    creds,
    method: "POST",
    path: "/capi/v2/order/placeTpSlOrder",
    body: {
      symbol: order.symbol,
      clientOrderId: order.clientOid.slice(0, 36),
      planType: "profit_plan",
      triggerPrice: order.tp,
      executePrice: "0",
      size: order.quantity,
      positionSide: order.positionSide.toLowerCase(),
      marginMode: 1,
    },
  });
}

export async function cancelWeexOpenLimits(
  creds: WeexCreds,
  symbol: string,
  keepOid?: string | null,
) {
  const paths = [
    { path: "/capi/v3/openOrders", query: { symbol } as Record<string, string> },
    { path: "/capi/v3/openOrders", query: { symbol, productType: "USDT-FUTURES" } },
  ];
  const keep = (keepOid ?? "").slice(0, 36);
  const seen = new Set<string>();
  for (const p of paths) {
    const res = await weexRequest<unknown>({ creds, method: "GET", path: p.path, query: p.query });
    if (!res.ok) continue;
    for (const row of rowsFrom(res.data)) {
      const o = row as Record<string, unknown>;
      const oid = String(o.clientOid ?? o.clientOrderId ?? o.origClientOrderId ?? "");
      const id = String(o.orderId ?? o.id ?? oid);
      if (!id || seen.has(id)) continue;
      if (keep && (oid === keep || id === keep)) continue;
      seen.add(id);
      await weexRequest({
        creds,
        method: "DELETE",
        path: "/capi/v3/order",
        query: { symbol, orderId: id, origClientOrderId: oid.slice(0, 36) },
      }).catch(() => null);
    }
    if (seen.size) break;
  }
}

export async function hasWeexWorkingOrder(
  creds: WeexCreds,
  symbol: string,
  clientOid?: string | null,
): Promise<boolean | null> {
  const paths = [
    { path: "/capi/v3/openOrders", query: { symbol } as Record<string, string> },
    { path: "/capi/v3/openOrders", query: { symbol, productType: "USDT-FUTURES" } },
    { path: "/capi/v2/openOrders", query: { symbol } },
  ];
  let sawOk = false;
  const oid = (clientOid ?? "").slice(0, 36);
  for (const p of paths) {
    const res = await weexRequest<unknown>({ creds, method: "GET", path: p.path, query: p.query });
    if (!res.ok) continue;
    sawOk = true;
    const rows = rowsFrom(res.data);
    if (!rows.length) return false;
    if (!oid) return true;
    const hit = rows.some((r) => {
      const o = r as Record<string, unknown>;
      const id = String(o.clientOid ?? o.clientOrderId ?? o.origClientOrderId ?? "");
      return id === oid || id.startsWith("vela");
    });
    return hit;
  }
  return sawOk ? false : null;
}
