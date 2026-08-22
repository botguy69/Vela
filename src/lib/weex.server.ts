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
  if (status === 403 || /forbidden|restricted|whitelist|cloudflare/i.test(msg + text)) {
    return "WEEX blocked this server. On the API key, turn IP whitelist OFF (allow any IP). Wait 15 minutes after creating the key. Futures trade must be ON, withdrawals OFF.";
  }
  if (code === -1044 || code === -1047 || code === -1049 || status === 401) {
    return "WEEX says the key, secret, or passphrase is wrong. Passphrase must be letters/numbers only. Copy secret again — it is shown only once.";
  }
  if (code === -1052) {
    return "Key is missing Futures permission. Edit the key on WEEX and enable Futures / contract trade.";
  }
  return msg || text.slice(0, 280) || `WEEX ${status}`;
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
  }[];
  const usdt = list.find((r) => (r.asset ?? r.coinName) === "USDT") ?? list[0];
  if (!usdt) return null;
  const balance = Number(usdt.equity ?? usdt.balance ?? 0);
  const pnl = Number(usdt.unrealizePnl ?? usdt.unrealizedPnl ?? 0);
  const available = Number(usdt.availableBalance ?? usdt.available ?? 0);
  const equity = Number.isFinite(Number(usdt.equity))
    ? Number(usdt.equity)
    : (Number.isFinite(balance) ? balance : 0) + (Number.isFinite(pnl) ? pnl : 0);
  return {
    equity: Math.max(0, equity),
    available: Number.isFinite(available) ? available : 0,
    asset: usdt.asset ?? usdt.coinName ?? "USDT",
  };
}

function rowsFrom(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as { data?: unknown; balances?: unknown; list?: unknown };
  if (Array.isArray(o.data)) return o.data;
  if (Array.isArray(o.balances)) return o.balances;
  if (Array.isArray(o.list)) return o.list;
  if (o.data && typeof o.data === "object") {
    const d = o.data as { balances?: unknown; list?: unknown };
    if (Array.isArray(d.balances)) return d.balances;
    if (Array.isArray(d.list)) return d.list;
    if (!Array.isArray(d) && ("asset" in d || "coinName" in d || "balance" in d)) return [d];
  }
  if ("asset" in o || "coinName" in o) return [o];
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
    tp: string;
    sl: string;
  },
): Promise<WeexResult<unknown>> {
  const body: Record<string, string> = {
    symbol: order.symbol,
    side: order.side,
    positionSide: order.positionSide,
    type: order.type,
    quantity: order.quantity,
    newClientOrderId: order.clientOid.slice(0, 36),
    tpTriggerPrice: order.tp,
    slTriggerPrice: order.sl,
    TpWorkingType: "CONTRACT_PRICE",
    SlWorkingType: "MARK_PRICE",
  };
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
      executePrice: "0",
      quantity: "0",
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
