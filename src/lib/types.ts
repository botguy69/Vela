import type { MarketId } from "./markets";

export type TapeQuote = {
  id: MarketId;
  last: number;
  changePct: number;
};
