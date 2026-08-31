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
  { id: "BRETT", weex: "BRETTUSDT", name: "Brett", fallbackMax: 125 },
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
  { id: "WIF", weex: "WIFUSDT", name: "dogwifhat", fallbackMax: 200 },
  { id: "BONK", weex: "1000BONKUSDT", name: "Bonk (1000)", fallbackMax: 200 },
  { id: "FLOKI", weex: "1000FLOKIUSDT", name: "Floki (1000)", fallbackMax: 200 },
  { id: "MEME", weex: "MEMEUSDT", name: "Memecoin", fallbackMax: 125 },
  { id: "POPCAT", weex: "POPCATUSDT", name: "Popcat", fallbackMax: 125 },
  { id: "AAVE", weex: "AAVEUSDT", name: "Aave", fallbackMax: 200 },
  { id: "NEAR", weex: "NEARUSDT", name: "NEAR", fallbackMax: 200 },
  { id: "APT", weex: "APTUSDT", name: "Aptos", fallbackMax: 200 },
  { id: "TAO", weex: "TAOUSDT", name: "Bittensor", fallbackMax: 200 },
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
  { id: "ONDO", weex: "ONDOUSDT", name: "Ondo", fallbackMax: 200 },
  { id: "ENA", weex: "ENAUSDT", name: "Ethena", fallbackMax: 200 },
  { id: "LDO", weex: "LDOUSDT", name: "Lido", fallbackMax: 200 },
  { id: "POL", weex: "POLUSDT", name: "Polygon", fallbackMax: 125 },
  { id: "PYTH", weex: "PYTHUSDT", name: "Pyth", fallbackMax: 200 },
  { id: "WLD", weex: "WLDUSDT", name: "Worldcoin", fallbackMax: 200 },
  { id: "GRT", weex: "GRTUSDT", name: "The Graph", fallbackMax: 200 },
  { id: "ORDI", weex: "ORDIUSDT", name: "ORDI", fallbackMax: 200 },
  { id: "APE", weex: "APEUSDT", name: "ApeCoin", fallbackMax: 200 },
  { id: "PENGU", weex: "PENGUUSDT", name: "Pudgy Penguins", fallbackMax: 125 },
  { id: "RUNE", weex: "RUNEUSDT", name: "THORChain", fallbackMax: 125 },
  { id: "CRV", weex: "CRVUSDT", name: "Curve", fallbackMax: 125 },
  { id: "ENS", weex: "ENSUSDT", name: "ENS", fallbackMax: 75 },
  { id: "GALA", weex: "GALAUSDT", name: "Gala", fallbackMax: 125 },
  { id: "SAND", weex: "SANDUSDT", name: "Sandbox", fallbackMax: 200 },
  { id: "MANA", weex: "MANAUSDT", name: "Decentraland", fallbackMax: 200 },
  { id: "AXS", weex: "AXSUSDT", name: "Axie", fallbackMax: 200 },
  { id: "DYDX", weex: "DYDXUSDT", name: "dYdX", fallbackMax: 125 },
  { id: "SNX", weex: "SNXUSDT", name: "Synthetix", fallbackMax: 100 },
  { id: "CHZ", weex: "CHZUSDT", name: "Chiliz", fallbackMax: 200 },
  { id: "BLUR", weex: "BLURUSDT", name: "Blur", fallbackMax: 75 },
  { id: "GMX", weex: "GMXUSDT", name: "GMX", fallbackMax: 200 },
  { id: "STRK", weex: "STRKUSDT", name: "Starknet", fallbackMax: 100 },
  { id: "ZK", weex: "ZKUSDT", name: "ZKsync", fallbackMax: 75 },
  { id: "JTO", weex: "JTOUSDT", name: "Jito", fallbackMax: 200 },
  { id: "CAKE", weex: "CAKEUSDT", name: "PancakeSwap", fallbackMax: 125 },
  { id: "THETA", weex: "THETAUSDT", name: "Theta", fallbackMax: 75 },
  { id: "EGLD", weex: "EGLDUSDT", name: "MultiversX", fallbackMax: 125 },
  { id: "ALGO", weex: "ALGOUSDT", name: "Algorand", fallbackMax: 200 },
  { id: "VET", weex: "VETUSDT", name: "VeChain", fallbackMax: 125 },
  { id: "XTZ", weex: "XTZUSDT", name: "Tezos", fallbackMax: 100 },
  { id: "NEO", weex: "NEOUSDT", name: "Neo", fallbackMax: 75 },
  { id: "IOTA", weex: "IOTAUSDT", name: "IOTA", fallbackMax: 125 },
  { id: "KAVA", weex: "KAVAUSDT", name: "Kava", fallbackMax: 200 },
  { id: "FLOW", weex: "FLOWUSDT", name: "Flow", fallbackMax: 200 },
  { id: "MINA", weex: "MINAUSDT", name: "Mina", fallbackMax: 200 },
  { id: "1INCH", weex: "1INCHUSDT", name: "1inch", fallbackMax: 200 },
  { id: "COMP", weex: "COMPUSDT", name: "Compound", fallbackMax: 200 },
  { id: "YFI", weex: "YFIUSDT", name: "yearn", fallbackMax: 75 },
  { id: "CRO", weex: "CROUSDT", name: "Cronos", fallbackMax: 200 },
];

export const TOP25_WEEX = TOP25.map((c) => c.weex);

/** Price-discovery / no history — never hunt, cancel working. */
export const SKIP_WEEX = new Set(["HYPEUSDT", "TONUSDT", "GRAMUSDT", "TRXUSDT"]);

/** Until $10k: only the tight books. */
export const CORE_WEEX = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT"] as const;
export const CORE_SET = new Set<string>(CORE_WEEX);

export function coinByWeex(symbol: string): AutoCoin {
  return TOP25.find((c) => c.weex === symbol) ?? TOP25[0]!;
}
