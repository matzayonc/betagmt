/** In dev, RPC goes through the Vite proxy (`/rpc`); production builds need a browser-friendly VITE_RPC_URL. */
export const RPC_URL =
  import.meta.env.VITE_RPC_URL || (import.meta.env.DEV ? new URL("/rpc", location.origin).href : "https://api.mainnet-beta.solana.com");
export const PRIORITY_FEE_MICRO_LAMPORTS = 50_000;
/** Lamports kept aside per leg for order/position account deposits and keeper fees (refunded on close). */
export const SOL_PER_LEG = 0.02;
/** Collateral must clear the market minimum after fees; keep this margin above it. */
export const MIN_COLLATERAL_MARGIN = 1.1;

/**
 * `tickerDecimals`: GMTrade's `decimals_gmx` for the index token. Prices from its tickers API are
 * `USD × 10^(30 - tickerDecimals)` (GMX's EVM convention; ETH uses 18, unlike its 8-decimal mint).
 */
export const MARKETS = {
  SOL: { sym: "SOL/USD", market: "SOL/USD[USDC-USDC]", feed: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", dp: 2, tickerDecimals: 9 },
  BTC: { sym: "BTC/USD", market: "BTC/USD[USDC-USDC]", feed: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", dp: 0, tickerDecimals: 8 },
  ETH: { sym: "ETH/USD", market: "ETH/USD[USDC-USDC]", feed: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", dp: 2, tickerDecimals: 18 },
  SPY: { sym: "SPY/USD", market: "SPY/USD[USDC-USDC]", feed: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5", dp: 2, tickerDecimals: 8 },
  EUR: { sym: "EUR/USD", market: "EUR/USD[USDC-USDC]", feed: "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b", dp: 5, tickerDecimals: 8 },
  XAU: { sym: "XAU/USD", market: "XAU/USD[USDC-USDC]", feed: "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", dp: 2, tickerDecimals: 8 },
} as const;

export type MarketKey = keyof typeof MARKETS;
export const MARKET_KEYS = Object.keys(MARKETS) as MarketKey[];

export interface StrategyLeg {
  mkt: MarketKey;
  /** +1 = same direction as the strategy, -1 = opposite. */
  dir: 1 | -1;
  /** Share of the strategy size. */
  w: number;
}

/** Yield-bearing tokens a strategy can park its spare capital in, bought and sold through Jupiter. */
export const RESERVE_TOKENS = {
  ONyc: { sym: "ONyc", mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5", decimals: 9 },
} as const;

export type ReserveKey = keyof typeof RESERVE_TOKENS;

export interface StrategyDef {
  id: number;
  name: string;
  desc: string;
  legs: StrategyLeg[];
  /** Fixed leverage (no slider). */
  lev?: number;
  /**
   * With a reserve, the typed size is the capital: perp collateral is size ÷ leverage and the
   * rest (less fees) is swapped into this token.
   */
  reserve?: ReserveKey;
}

export const STRATEGIES: StrategyDef[] = [
  { id: 2, name: "S&P 500 vs euro", desc: "Long S&P 500, short EUR/USD — gains when US equities rally and the dollar strengthens against the euro.", legs: [{ mkt: "SPY", dir: 1, w: 0.5 }, { mkt: "EUR", dir: -1, w: 0.5 }] },
  {
    id: 5, name: "S&P 500 on yield", lev: 10, reserve: "ONyc",
    desc: "Full S&P 500 exposure on your capital while most of it earns yield. A 10× SPY perp needs only 10% as collateral; the other 90% is swapped into ONyc, OnRe's yield-bearing reinsurance token, and swapped back to USDC on close.",
    legs: [{ mkt: "SPY", dir: 1, w: 1 }],
  },
];
