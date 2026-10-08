import { PublicKey } from "@solana/web3.js";
import { APP_MARKETS, connection } from "./chain";
import { MARKETS, MARKET_KEYS, type MarketKey } from "./config";

/** GMTrade's keeper API: the prices orders are executed at, plus market open/closed status. */
const GMTRADE_KEEPER_API = "https://keeper-prod-api.gmtrade.xyz/graphql";
const KEEPER_TOKEN_PRICES = `query KeeperTokenPrices($pubkeys: [StringPubkey!]) {
  tokens(pubkeys: $pubkeys) { pubkey price { min max ts isOpen } }
}`;

/** Pyth push oracle (sponsored feeds updated on-chain) — fallback for crypto if the API is down. */
const PYTH_PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
/** On-chain prices older than this are ignored (equity/FX/metal feeds aren't pushed). */
const MAX_PRICE_AGE_S = 120;

export interface PriceSnapshot {
  /** USD price per whole index token; `null` when unavailable. */
  prices: Record<MarketKey, number | null>;
  /** Market trading status from GMTrade; `undefined` when unknown. */
  isOpen: Partial<Record<MarketKey, boolean>>;
}

async function keeperPrices(): Promise<PriceSnapshot> {
  const res = await fetch(GMTRADE_KEEPER_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: KEEPER_TOKEN_PRICES,
      variables: { pubkeys: MARKET_KEYS.map((k) => APP_MARKETS[k].indexToken.toBase58()) },
    }),
  });
  if (!res.ok) throw new Error(`GMTrade API ${res.status}`);
  const body = (await res.json()) as {
    data?: { tokens: { pubkey: string; price: { min: string; max: string; ts: number; isOpen: boolean } | null }[] };
  };
  const snap: PriceSnapshot = { prices: {} as PriceSnapshot["prices"], isOpen: {} };
  for (const k of MARKET_KEYS) {
    const token = body.data?.tokens.find((t) => t.pubkey === APP_MARKETS[k].indexToken.toBase58());
    if (!token?.price) { snap.prices[k] = null; continue; }
    // Unit price = USD per smallest token unit, scaled by 1e20.
    const mid = (Number(token.price.min) + Number(token.price.max)) / 2;
    snap.prices[k] = mid * 10 ** (APP_MARKETS[k].indexDecimals - 20);
    snap.isOpen[k] = token.price.isOpen;
  }
  return snap;
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

async function pythPrices(): Promise<PriceSnapshot> {
  const accounts = await connection.getMultipleAccountsInfo(pushAccounts);
  const now = Date.now() / 1000;
  const prices = {} as PriceSnapshot["prices"];
  MARKET_KEYS.forEach((k, i) => {
    const update = accounts[i] ? decodePriceUpdate(accounts[i]!.data) : null;
    prices[k] = update && now - update.publishTime < MAX_PRICE_AGE_S ? update.price : null;
  });
  return { prices, isOpen: {} };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Latest prices from GMTrade's keeper API. It rate-limits aggressively (429s at ~1 req/2s per IP),
 * so retry with backoff before falling back to on-chain Pyth (crypto only).
 */
export async function loadPrices(): Promise<PriceSnapshot> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await keeperPrices();
    } catch (err) {
      if (attempt < 2 && /429/.test(String(err))) { await sleep(1500 * (attempt + 1)); continue; }
      console.warn("GMTrade prices unavailable, using on-chain Pyth:", err);
      return pythPrices();
    }
  }
}
