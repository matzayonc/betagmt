import { PublicKey } from "@solana/web3.js";
import { APP_MARKETS, connection } from "./chain";
import { MARKETS, MARKET_KEYS, type MarketKey } from "./config";

/** GMTrade's cached price tickers (what its frontend polls); not rate-limited like the keeper API. */
const GMTRADE_TICKERS = "https://gmtrade-web-backend.gmtrade.xyz/cache/prices/tickers";
/** GMTrade's keeper API: used only for market open/closed status (it rate-limits browsers heavily). */
const GMTRADE_KEEPER_API = "https://keeper-prod-api.gmtrade.xyz/graphql";
const KEEPER_TOKEN_PRICES = `query KeeperTokenPrices($pubkeys: [StringPubkey!]) {
  tokens(pubkeys: $pubkeys) { pubkey price { isOpen } }
}`;

/** Pyth push oracle (sponsored feeds updated on-chain) — fallback for crypto if GMTrade is down. */
const PYTH_PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
/** Prices older than this are ignored. */
const MAX_PRICE_AGE_S = 120;

export type Prices = Record<MarketKey, number | null>;

async function tickerPrices(): Promise<Prices> {
  const res = await fetch(GMTRADE_TICKERS);
  if (!res.ok) throw new Error(`GMTrade tickers ${res.status}`);
  const tickers = (await res.json()) as { tokenAddress: string; minPrice: string; maxPrice: string; timestamp: number }[];
  const now = Date.now() / 1000;
  const prices = {} as Prices;
  for (const k of MARKET_KEYS) {
    const t = tickers.find((x) => x.tokenAddress === APP_MARKETS[k].indexToken.toBase58());
    prices[k] = t && now - t.timestamp < MAX_PRICE_AGE_S
      ? ((Number(t.minPrice) + Number(t.maxPrice)) / 2) * 10 ** (MARKETS[k].tickerDecimals - 30)
      : null;
  }
  return prices;
}

/** Whether each market is open for trading (e.g. SPY outside US hours), from GMTrade's keeper API. */
export async function loadMarketStatus(): Promise<Partial<Record<MarketKey, boolean>>> {
  const res = await fetch(GMTRADE_KEEPER_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: KEEPER_TOKEN_PRICES,
      variables: { pubkeys: MARKET_KEYS.map((k) => APP_MARKETS[k].indexToken.toBase58()) },
    }),
  });
  if (!res.ok) throw new Error(`GMTrade keeper API ${res.status}`);
  const body = (await res.json()) as { data?: { tokens: { pubkey: string; price: { isOpen: boolean } | null }[] } };
  const status: Partial<Record<MarketKey, boolean>> = {};
  for (const k of MARKET_KEYS) {
    const token = body.data?.tokens.find((t) => t.pubkey === APP_MARKETS[k].indexToken.toBase58());
    if (token?.price) status[k] = token.price.isOpen;
  }
  return status;
}

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

const pushAccounts = MARKET_KEYS.map(
  (k) => PublicKey.findProgramAddressSync([Uint8Array.of(0, 0), hexToBytes(MARKETS[k].feed)], PYTH_PUSH_ORACLE)[0],
);

/** Decode a Pyth `PriceUpdateV2` account into a price and publish time. */
function decodePriceUpdate(data: Uint8Array): { price: number; publishTime: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // discriminator (8) + write_authority (32) + verification_level (Partial: 2 bytes, Full: 1 byte) + feed_id (32)
  const o = 40 + (data[40] === 0 ? 2 : 1) + 32;
  const price = Number(view.getBigInt64(o, true));
  const expo = view.getInt32(o + 16, true);
  const publishTime = Number(view.getBigInt64(o + 20, true));
  return { price: price * 10 ** expo, publishTime };
}

async function pythPrices(): Promise<Prices> {
  const accounts = await connection.getMultipleAccountsInfo(pushAccounts);
  const now = Date.now() / 1000;
  const prices = {} as Prices;
  MARKET_KEYS.forEach((k, i) => {
    const update = accounts[i] ? decodePriceUpdate(accounts[i]!.data) : null;
    prices[k] = update && now - update.publishTime < MAX_PRICE_AGE_S ? update.price : null;
  });
  return prices;
}

/** Latest prices from GMTrade's tickers, falling back to on-chain Pyth (crypto only). */
export async function loadPrices(): Promise<Prices> {
  try {
    return await tickerPrices();
  } catch (err) {
    console.warn("GMTrade prices unavailable, using on-chain Pyth:", err);
    return pythPrices();
  }
}
