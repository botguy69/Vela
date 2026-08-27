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
    const res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.method === "POST" || (opts.method === "DELETE" && body) ? body : undefined,
    });
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
    equity?: string;
    availableBalance?: string;
    available?: string;
    unrealizePnl?: string;
    unrealizedPnl?: string;
    crossedMargin?: string;
    marginBalance?: string;
  }[];
  const usdt = list.find((r) => (r.asset ?? r.coinName) === "USDT") ?? list[0];
  if (!usdt) return null;
  const rawEq = Number(usdt.equity);
  const rawBal = Number(usdt.balance);
  const rawMar = Number(usdt.marginBalance ?? usdt.crossedMargin);
  const pnl = Number(usdt.unrealizePnl ?? usdt.unrealizedPnl ?? 0);
  const available = Number(usdt.availableBalance ?? usdt.available ?? 0);
  const has = (x: number) => Number.isFinite(x);
  const wallet = has(rawBal) ? rawBal : 0;
  const marked = has(rawMar) && rawMar > 0 ? rawMar : NaN;

  let equity = 0;
  if (has(rawEq) && has(wallet) && Math.abs(rawEq - wallet) < 0.05) {
    equity = wallet + (has(pnl) ? pnl : 0);
  } else if (has(rawEq) && has(wallet) && has(pnl) && Math.abs(rawEq - (wallet + pnl)) < 1) {
    equity = rawEq;
  } else if (has(marked) && marked > 0) {
    equity = marked;
  } else if (has(rawEq) && rawEq > 0) {
    equity = rawEq;
  } else if (has(wallet)) {
    equity = wallet + (has(pnl) ? pnl : 0);
  }
  if (has(wallet) && has(pnl) && equity > wallet + Math.abs(pnl) + 1) {
    equity = wallet + pnl;
  }
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
    for (const k of ["balances", "list", "positions", "positionList", "holdList", "records", "result", "entrustedList", "orderList", "orders", "tpslList", "algoOrderList", "planList"]) {
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
  const r = row as {
    symbol?: string;
    contract?: string;
    positionAmt?: string | number;
    holdVol?: string | number;
    total?: string | number;
    size?: string | number;
    available?: string | number;
    positionSize?: string | number;
    positionSide?: string;
    holdSide?: string;
    posSide?: string;
    side?: string;
    entryPrice?: string | number;
    openPriceAvg?: string | number;
    averagePrice?: string | number;
    unrealizedPnl?: string | number;
    unrealizePnl?: string | number;
    upl?: string | number;
    profit?: string | number;
    markPrice?: string | number;
    marketPrice?: string | number;
  };
  const symbol = String(r.symbol ?? r.contract ?? "")
    .replace(/_/g, "")
    .replace(/^cmt/i, "")
    .toUpperCase();
  const q = Math.abs(
    Number(
      r.positionAmt ??
        r.holdVol ??
        r.positionSize ??
        r.size ??
        r.total ??
        (r as { volume?: string | number }).volume ??
        (r as { qty?: string | number }).qty ??
        0,
    ),
  );
  if (!symbol || !Number.isFinite(q) || q <= 0) return null;
  const sideRaw = String(r.positionSide ?? r.holdSide ?? r.side ?? r.posSide ?? "").toLowerCase();
  const amt = Number(r.positionAmt);
  const side: "long" | "short" =
    sideRaw.includes("short") || sideRaw === "sell" || sideRaw === "2" || amt < 0
      ? "short"
      : "long";
  const entry = Number(
    r.entryPrice ??
      r.openPriceAvg ??
      r.averagePrice ??
      ((r as { openValue?: string | number }).openValue != null && q > 0
        ? Number((r as { openValue?: string | number }).openValue) / q
        : 0),
  );
  const rawPnl = Number(
    r.unrealizedPnl ??
      r.unrealizePnl ??
      (r as { unrealizedPL?: string | number }).unrealizedPL ??
      r.upl ??
      r.profit ??
      (r as { pnl?: string | number }).pnl ??
      (r as { floatProfit?: string | number }).floatProfit ??
      (r as { achievedProfits?: string | number }).achievedProfits ??
      (r as { uPnL?: string | number }).uPnL,
  );
  const mark = Number(r.markPrice ?? r.marketPrice ?? 0);
  const bePx = Number(
    (r as { breakEvenPrice?: string | number }).breakEvenPrice ??
      (r as { breakevenPrice?: string | number }).breakevenPrice ??
      (r as { breakEven?: string | number }).breakEven ??
      (r as { avgBreakEvenPrice?: string | number }).avgBreakEvenPrice ??
      0,
  );
  if (Number.isFinite(entry) && entry > 0 && q * entry < 0.05) return null;
  return {
    symbol,
    side,
    qty: q,
    entry: Number.isFinite(entry) ? entry : 0,
    pnl: Number.isFinite(rawPnl) ? rawPnl : null,
    mark: Number.isFinite(mark) ? mark : 0,
    bePx: Number.isFinite(bePx) && bePx > 0 ? bePx : 0,
  };
}

function positionQtyFrom(raw: unknown, symbol: string): number | null {
  const rows = rowsFrom(raw);
  const hit = rows
    .map(parsePosition)
    .find((p) => p && (p.symbol === symbol || p.symbol.replace("_", "") === symbol));
  return hit?.qty ?? null;
}

export async function listWeexPositions(
  creds: WeexCreds,
): Promise<{ symbol: string; side: "long" | "short"; qty: number; entry: number; pnl: number | null; mark: number; bePx: number }[] | null> {
  const paths = [
    { path: "/capi/v3/account/position/allPosition", query: undefined as Record<string, string> | undefined },
    { path: "/capi/v3/account/position/singlePosition", query: undefined },
    { path: "/capi/v3/account/positions", query: undefined },
    { path: "/capi/v3/account/positions", query: { productType: "USDT-FUTURES" } },
    { path: "/capi/v3/account/positions", query: { marginCoin: "USDT" } },
    { path: "/capi/v3/positionRisk", query: undefined },
    { path: "/capi/v3/position/open", query: undefined },
    { path: "/capi/v2/position", query: undefined },
    { path: "/capi/v2/account/positions", query: undefined },
  ];
  let sawOk = false;
  const uniq = new Map<
    string,
    { symbol: string; side: "long" | "short"; qty: number; entry: number; pnl: number | null; mark: number; bePx: number }
  >();
  for (const p of paths) {
    const res = await weexRequest<unknown>({ creds, method: "GET", path: p.path, query: p.query });
    if (!res.ok) continue;
    sawOk = true;
    const parsed = rowsFrom(res.data).map(parsePosition).filter((x): x is NonNullable<typeof x> => x != null);
    for (const pos of parsed) {
      const k = `${pos.symbol}|${pos.side}`;
      const prev = uniq.get(k);
      if (!prev || pos.qty > prev.qty || (pos.pnl != null && prev.pnl == null)) {
        uniq.set(
          k,
          prev && pos.qty < prev.qty
            ? { ...prev, pnl: pos.pnl ?? prev.pnl, mark: pos.mark || prev.mark, bePx: pos.bePx || prev.bePx }
            : pos,
        );
      }
    }
  }
  if (uniq.size) return [...uniq.values()];
  return sawOk ? [] : null;
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
  for (const p of paths) {
    const res = await weexRequest<unknown>({ creds, method: "GET", path: p.path, query: p.query });
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
  const m = new Map<string, WeexClose>();
  for (const c of closes) {
    const ek = c.entry > 0 ? c.entry.toPrecision(5) : "x";
    const k = `${c.symbol}|${c.side ?? "?"}|${ek}`;
    const prev = m.get(k);
    if (!prev) {
      m.set(k, { ...c });
      continue;
    }
    const bigger = Math.max(Math.abs(c.pnl), Math.abs(prev.pnl));
    const smaller = Math.min(Math.abs(c.pnl), Math.abs(prev.pnl));
    const ratio = bigger > 0 ? smaller / bigger : 1;
    const sameSign = Math.sign(c.pnl) === Math.sign(prev.pnl) || prev.pnl === 0 || c.pnl === 0;
    if (sameSign && (ratio > 0.82 || ratio < 0.4)) {
      m.set(k, Math.abs(c.pnl) > Math.abs(prev.pnl) ? c : prev);
      continue;
    }
    m.set(k, {
      ...prev,
      pnl: prev.pnl + c.pnl,
      qty: Math.max(prev.qty, c.qty),
      closePx: (c.ts || 0) >= (prev.ts || 0) ? c.closePx || prev.closePx : prev.closePx,
      ts: Math.max(prev.ts || 0, c.ts || 0),
      entry: prev.entry > 0 ? prev.entry : c.entry,
    });
  }
  return [...m.values()];
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
  return weexRequest({
    creds,
    method: "POST",
    path: "/capi/v3/order",
    body: {
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      type: "MARKET",
      quantity: order.quantity,
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
      quantity: order.quantity && Number(order.quantity) > 0 ? order.quantity : "0",
      positionSide: order.positionSide,
      triggerPriceType: "MARK_PRICE",
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

export async function cancelWeexProtective(
  creds: WeexCreds,
  symbol: string,
  holdSide?: "long" | "short",
) {
  const planTypes = [
    "profit_loss",
    "profit_plan",
    "loss_plan",
    "pos_profit",
    "pos_loss",
    "normal_plan",
    "TAKE_PROFIT",
    "STOP_LOSS",
  ];
  const sides = holdSide ? [holdSide] : ["long", "short"];
  for (const planType of planTypes) {
    for (const side of sides) {
      await weexRequest({
        creds,
        method: "POST",
        path: "/capi/v2/mix/order/cancel-all-plan",
        body: {
          symbol,
          productType: "USDT-FUTURES",
          planType,
          marginCoin: "USDT",
          holdSide: side,
        },
      }).catch(() => null);
    }
  }
  await weexRequest({
    creds,
    method: "POST",
    path: "/capi/v2/mix/order/cancel-all-tpsl",
    body: { symbol, productType: "USDT-FUTURES", marginCoin: "USDT" },
  }).catch(() => null);
  if (!holdSide) {
    await weexRequest({ creds, method: "POST", path: "/capi/v3/algoOrder/cancelAll", body: { symbol } }).catch(() => null);
    await weexRequest({ creds, method: "POST", path: "/capi/v3/cancelAllTpSl", body: { symbol } }).catch(() => null);
    await weexRequest({
      creds,
      method: "POST",
      path: "/capi/v3/plan/cancelAll",
      body: { symbol, productType: "USDT-FUTURES" },
    }).catch(() => null);
  }
  const listed = await listWeexAlgoRows(creds, symbol);
  const ids = listed
    .filter((r) => !holdSide || r.posSide === holdSide.toUpperCase() || !r.posSide)
    .map((r) => r.id);
  await cancelAlgoIds(creds, symbol, ids);
}

async function cancelAlgoIds(creds: WeexCreds, symbol: string, ids: string[]) {
  for (const id of ids) {
    if (!id || id === "undefined") continue;
    await weexRequest({
      creds,
      method: "POST",
      path: "/capi/v2/mix/order/cancel-plan",
      body: {
        symbol,
        productType: "USDT-FUTURES",
        marginCoin: "USDT",
        orderIdList: [{ orderId: id, clientOid: id }],
      },
    }).catch(() => null);
    await weexRequest({ creds, method: "POST", path: "/capi/v3/cancelTpSlOrder", body: { symbol, algoId: id, clientAlgoId: id } }).catch(() => null);
    await weexRequest({ creds, method: "POST", path: "/capi/v3/algoOrder/cancel", body: { symbol, algoId: id } }).catch(() => null);
    await weexRequest({ creds, method: "DELETE", path: "/capi/v3/tpslOrder", query: { symbol, algoId: id } }).catch(() => null);
    await weexRequest({ creds, method: "DELETE", path: "/capi/v3/order", query: { symbol, orderId: id } }).catch(() => null);
    await weexRequest({ creds, method: "POST", path: "/capi/v3/order/tpsl/cancel", body: { symbol, algoId: id } }).catch(() => null);
    await weexRequest({ creds, method: "POST", path: "/capi/v3/plan/cancel", body: { symbol, algoId: id } }).catch(() => null);
    await weexRequest({
      creds,
      method: "DELETE",
      path: "/capi/v3/order",
      query: { symbol, origClientOrderId: id.slice(0, 36) },
    }).catch(() => null);
  }
}

export async function listWeexAlgoRows(
  creds: WeexCreds,
  symbol: string,
): Promise<{ id: string; type: string; trigger: number; posSide: string }[]> {
  const planTypes = [
    "profit_loss",
    "profit_plan",
    "loss_plan",
    "pos_profit",
    "pos_loss",
    "TAKE_PROFIT",
    "STOP_LOSS",
    "normal_plan",
  ];
  const paths: { path: string; query: Record<string, string> }[] = [
    { path: "/capi/v3/algoOrder/open", query: { symbol } },
    { path: "/capi/v3/tpslOrder", query: { symbol } },
    { path: "/capi/v3/pendingTpSlOrder", query: { symbol } },
    { path: "/capi/v3/openTpSlOrders", query: { symbol } },
    { path: "/capi/v3/planOrder/current", query: { symbol } },
    { path: "/capi/v3/position/tpsl", query: { symbol } },
    { path: "/capi/v3/order/tpsl/current", query: { symbol } },
    { path: "/capi/v2/mix/order/orders-tpsl-pending", query: { symbol, productType: "USDT-FUTURES" } },
    ...planTypes.map((planType) => ({
      path: "/capi/v2/mix/order/orders-plan-pending",
      query: { symbol, productType: "USDT-FUTURES", planType },
    })),
    ...planTypes.map((planType) => ({
      path: "/capi/v3/ordersPlan",
      query: { symbol, planType },
    })),
  ];
  const out: { id: string; type: string; trigger: number; posSide: string }[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const res = await weexRequest<unknown>({ creds, method: "GET", path: p.path, query: p.query });
    if (!res.ok) continue;
    for (const row of rowsFrom(res.data)) {
      const o = row as Record<string, unknown>;
      const id = String(o.algoId ?? o.orderId ?? o.id ?? o.clientAlgoId ?? o.clientOid ?? "");
      if (!id || id === "undefined" || seen.has(id)) continue;
      seen.add(id);
      let pos = String(o.positionSide ?? o.holdSide ?? o.posSide ?? o.tdPositionSide ?? o.holdSide ?? "")
        .toUpperCase()
        .replace(/_USDT|_BOTH/g, "");
      if (!pos.includes("LONG") && !pos.includes("SHORT")) {
        const reduce = o.reduceOnly === true || String(o.reduceOnly ?? "") === "true";
        const sd = String(o.side ?? o.tradeSide ?? "").toUpperCase();
        if (reduce && (sd === "SELL" || sd.includes("CLOSE_LONG"))) pos = "LONG";
        else if (reduce && (sd === "BUY" || sd.includes("CLOSE_SHORT"))) pos = "SHORT";
        else if (/CLOSE.?LONG|CLOSE_LONG/i.test(String(o.planType ?? o.type ?? ""))) pos = "LONG";
        else if (/CLOSE.?SHORT|CLOSE_SHORT/i.test(String(o.planType ?? o.type ?? ""))) pos = "SHORT";
      }
      out.push({
        id,
        type: String(o.planType ?? o.type ?? o.orderType ?? o.workingType ?? o.tpslMode ?? ""),
        trigger: Number(o.triggerPrice ?? o.stopPrice ?? o.executePrice ?? o.price ?? 0),
        posSide: pos.includes("SHORT") ? "SHORT" : pos.includes("LONG") ? "LONG" : "",
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
  const opp = opts.side === "short" ? "long" : "short";
  await cancelWeexProtective(creds, symbol, opp);
  const rows = await listWeexAlgoRows(creds, symbol);
  const mark = opts.mark ?? 0;
  const sl = opts.sl;
  const tps = opts.tps.filter((p) => p > 0).slice(0, 2);
  const wrong = rows.filter((r) => r.posSide && r.posSide !== live);
  if (wrong.length || rows.length > 3) {
    if (wrong.length) await cancelAlgoIds(creds, symbol, wrong.map((r) => r.id));
    if (rows.length > 3) await cancelWeexProtective(creds, symbol, opts.side);
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
  return weexRequest({
    creds,
    method: "POST",
    path: "/capi/v3/placeTpSlOrder",
    body: {
      symbol: order.symbol,
      clientAlgoId: order.clientOid.slice(0, 36),
      planType: "TAKE_PROFIT",
      triggerPrice: order.tp,
      executePrice: order.tp,
      quantity: order.quantity,
      positionSide: order.positionSide,
      triggerPriceType: "MARK_PRICE",
    },
  });
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
