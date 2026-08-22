export type AutoCoin = {
  id: string;
  weex: string;
  name: string;
  fallbackMax: number;
};

/** Known WEEX USDT-M perps only. No new listings, no sketch books. */
export const TOP25: AutoCoin[] = [
  { id: "BTC", weex: "BTCUSDT", name: "Bitcoin", fallbackMax: 400 },
  { id: "ETH", weex: "ETHUSDT", name: "Ether", fallbackMax: 400 },
  { id: "BNB", weex: "BNBUSDT", name: "BNB", fallbackMax: 200 },
  { id: "XRP", weex: "XRPUSDT", name: "XRP", fallbackMax: 300 },
  { id: "SOL", weex: "SOLUSDT", name: "Solana", fallbackMax: 300 },
  { id: "DOGE", weex: "DOGEUSDT", name: "Dogecoin", fallbackMax: 200 },
  { id: "ADA", weex: "ADAUSDT", name: "Cardano", fallbackMax: 300 },
  { id: "TRX", weex: "TRXUSDT", name: "TRON", fallbackMax: 200 },
  { id: "TON", weex: "TONUSDT", name: "Toncoin", fallbackMax: 50 },
  { id: "LINK", weex: "LINKUSDT", name: "Chainlink", fallbackMax: 200 },
  { id: "AVAX", weex: "AVAXUSDT", name: "Avalanche", fallbackMax: 200 },
  { id: "XLM", weex: "XLMUSDT", name: "Stellar", fallbackMax: 200 },
  { id: "SUI", weex: "SUIUSDT", name: "Sui", fallbackMax: 200 },
  { id: "SHIB", weex: "1000SHIBUSDT", name: "Shiba (1000)", fallbackMax: 200 },
  { id: "BCH", weex: "BCHUSDT", name: "Bitcoin Cash", fallbackMax: 200 },
  { id: "HBAR", weex: "HBARUSDT", name: "Hedera", fallbackMax: 200 },
  { id: "LTC", weex: "LTCUSDT", name: "Litecoin", fallbackMax: 200 },
  { id: "DOT", weex: "DOTUSDT", name: "Polkadot", fallbackMax: 200 },
  { id: "UNI", weex: "UNIUSDT", name: "Uniswap", fallbackMax: 200 },
  { id: "PEPE", weex: "1000PEPEUSDT", name: "Pepe (1000)", fallbackMax: 200 },
  { id: "AAVE", weex: "AAVEUSDT", name: "Aave", fallbackMax: 200 },
  { id: "NEAR", weex: "NEARUSDT", name: "NEAR", fallbackMax: 200 },
  { id: "APT", weex: "APTUSDT", name: "Aptos", fallbackMax: 200 },
  { id: "TAO", weex: "TAOUSDT", name: "Bittensor", fallbackMax: 200 },
  { id: "HYPE", weex: "HYPEUSDT", name: "Hyperliquid", fallbackMax: 100 },
  { id: "INJ", weex: "INJUSDT", name: "Injective", fallbackMax: 200 },
  { id: "ARB", weex: "ARBUSDT", name: "Arbitrum", fallbackMax: 200 },
  { id: "OP", weex: "OPUSDT", name: "Optimism", fallbackMax: 200 },
  { id: "ATOM", weex: "ATOMUSDT", name: "Cosmos", fallbackMax: 200 },
  { id: "FIL", weex: "FILUSDT", name: "Filecoin", fallbackMax: 75 },
  { id: "RENDER", weex: "RENDERUSDT", name: "Render", fallbackMax: 200 },
  { id: "SEI", weex: "SEIUSDT", name: "Sei", fallbackMax: 200 },
  { id: "TIA", weex: "TIAUSDT", name: "Celestia", fallbackMax: 200 },
  { id: "FET", weex: "FETUSDT", name: "Fetch", fallbackMax: 200 },
  { id: "ICP", weex: "ICPUSDT", name: "Internet Computer", fallbackMax: 200 },
  { id: "IMX", weex: "IMXUSDT", name: "Immutable", fallbackMax: 200 },
  { id: "ETC", weex: "ETCUSDT", name: "Ethereum Classic", fallbackMax: 200 },
  { id: "JUP", weex: "JUPUSDT", name: "Jupiter", fallbackMax: 200 },
  { id: "PENDLE", weex: "PENDLEUSDT", name: "Pendle", fallbackMax: 125 },
];

export const TOP25_WEEX = TOP25.map((c) => c.weex);

/** Until $10k: only the tight books. */
export const CORE_WEEX = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT"] as const;
export const CORE_SET = new Set<string>(CORE_WEEX);

export function coinByWeex(symbol: string): AutoCoin {
  return TOP25.find((c) => c.weex === symbol) ?? TOP25[0]!;
}
