// Browser-safe helpers for trading on GMTrade (GMX-Solana) with @gmsol-labs/gmsol-sdk.
// No Node-only imports: works in a CLI and in a website (with a WASM-capable bundler).
import {
  Market,
  Position,
  create_orders,
  default_store_program,
  type CreateOrderKind,
  type SerializedTransactionGroup,
} from "@gmsol-labs/gmsol-sdk";
import {
  PublicKey,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** USD values in GMTrade use 20 decimals. */
export const USD_DECIMALS = 20;
export const USD_UNIT = 10n ** BigInt(USD_DECIMALS);

/** Anything that can sign, e.g. `useWallet()` from @solana/wallet-adapter-react. */
export interface WalletSigner {
  publicKey: PublicKey;
  signAllTransactions<T extends VersionedTransaction>(txs: T[]): Promise<T[]>;
}

export interface StoreInfo {
  programId: PublicKey;
  store: PublicKey;
}

export interface MarketInfo {
  /** e.g. `SOL/USD[WSOL-USDC]` (index/USD[long-short]). */
  name: string;
  address: PublicKey;
  marketToken: PublicKey;
  indexToken: PublicKey;
  longToken: PublicKey;
  shortToken: PublicKey;
}

export interface PositionInfo {
  address: PublicKey;
  sizeUsd: bigint;
  sizeInTokens: bigint;
  collateralAmount: bigint;
}

export function getStore(): StoreInfo {
  const { id, store } = default_store_program();
  return { programId: new PublicKey(id), store: new PublicKey(store) };
}

async function anchorDiscriminator(accountName: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`account:${accountName}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash).slice(0, 8);
}

// `Market.name` is a [u8; 64] at this offset (discriminator 8 + header 16).
const MARKET_NAME_OFFSET = 24;
const MARKET_NAME_LEN = 64;

function decodeMarketName(data: Uint8Array): string {
  const raw = data.subarray(MARKET_NAME_OFFSET, MARKET_NAME_OFFSET + MARKET_NAME_LEN);
  const end = raw.indexOf(0);
  return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
}

// Offsets of `MarketConfig` fields inside the `Market` account (gmsol-store IDL, SDK 0.9/0.10).
const MIN_COLLATERAL_VALUE_OFFSET = 376;
const MIN_COLLATERAL_FACTOR_OFFSET = 392;
const ORDER_FEE_FACTOR_NEGATIVE_IMPACT_OFFSET = 568;

export interface MarketParams {
  /** Minimum collateral value in USD, checked after fees. */
  minCollateralUsd: number;
  /** 1 / min collateral factor. */
  maxLeverage: number;
  /** Order fee as a fraction of size (the higher, negative-impact rate). */
  orderFeeFactor: number;
}

function readU128(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true) + (view.getBigUint64(offset + 8, true) << 64n);
}

const toUnitNumber = (v: bigint) => Number(v) / Number(USD_UNIT);

/** Decode trading limits and fees from raw `Market` account data. */
export function decodeMarketParams(data: Uint8Array): MarketParams {
  const minCollateralFactor = toUnitNumber(readU128(data, MIN_COLLATERAL_FACTOR_OFFSET));
  return {
    minCollateralUsd: toUnitNumber(readU128(data, MIN_COLLATERAL_VALUE_OFFSET)),
    maxLeverage: minCollateralFactor > 0 ? 1 / minCollateralFactor : Infinity,
    orderFeeFactor: toUnitNumber(readU128(data, ORDER_FEE_FACTOR_NEGATIVE_IMPACT_OFFSET)),
  };
}

function toMarketInfo(address: PublicKey, data: Uint8Array): MarketInfo {
  const market = Market.decode(data);
  try {
    return {
      name: decodeMarketName(data),
      address,
      marketToken: new PublicKey(market.market_token_address()),
      indexToken: new PublicKey(market.index_token_address()),
      longToken: new PublicKey(market.long_token_address()),
      shortToken: new PublicKey(market.short_token_address()),
    };
  } finally {
    market.free();
  }
}

/** List all markets of the default store. */
export async function listMarkets(connection: Connection): Promise<MarketInfo[]> {
  const { programId, store } = getStore();
  const disc = await anchorDiscriminator("Market");
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Encode(disc) } }],
  });
  const markets: MarketInfo[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const info = toMarketInfo(pubkey, account.data);
      // Markets of other stores are skipped by checking the PDA.
      if (findMarketAddress(store, info.marketToken, programId).equals(pubkey)) {
        markets.push(info);
      }
    } catch {
      // Not decodable with this SDK version; ignore.
    }
  }
  return markets;
}

/** Find a market by name, e.g. `SOL/USD[WSOL-USDC]` or `SPY/USD[USDC-USDC]`. */
export async function findMarket(connection: Connection, name = "SOL/USD[WSOL-USDC]"): Promise<MarketInfo> {
  return (await findMarkets(connection, [name]))[0];
}

/** Find several markets by name with a single account scan. */
export async function findMarkets(connection: Connection, names: string[]): Promise<MarketInfo[]> {
  const markets = await listMarkets(connection);
  return names.map((name) => {
    const match = markets.find((m) => m.name === name);
    if (!match) {
      throw new Error(`Market "${name}" not found. Available: ${markets.map((m) => m.name).join(", ")}`);
    }
    return match;
  });
}

export function findMarketAddress(store: PublicKey, marketToken: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("market"), store.toBytes(), marketToken.toBytes()],
    programId,
  )[0];
}

export function findPositionAddress(args: {
  owner: PublicKey;
  marketToken: PublicKey;
  collateralToken: PublicKey;
  isLong: boolean;
}): PublicKey {
  const { programId, store } = getStore();
  return PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("position"),
      store.toBytes(),
      args.owner.toBytes(),
      args.marketToken.toBytes(),
      args.collateralToken.toBytes(),
      Uint8Array.of(args.isLong ? 1 : 2),
    ],
    programId,
  )[0];
}

/** Fetch a position; returns `null` if it does not exist or is empty. */
export async function fetchPosition(
  connection: Connection,
  args: { owner: PublicKey; market: MarketInfo; collateralToken: PublicKey; isLong: boolean },
): Promise<PositionInfo | null> {
  const address = findPositionAddress({ ...args, marketToken: args.market.marketToken });
  const positionAccount = await connection.getAccountInfo(address);
  if (!positionAccount) return null;
  const [marketAccount, supply] = await Promise.all([
    connection.getAccountInfo(args.market.address),
    connection.getTokenSupply(args.market.marketToken),
  ]);
  if (!marketAccount) return null;

  const marketModel = Market.decode(marketAccount.data).to_model(BigInt(supply.value.amount));
  const model = Position.decode(positionAccount.data).to_model(marketModel);
  try {
    const info: PositionInfo = {
      address,
      sizeUsd: model.size(),
      sizeInTokens: model.size_in_tokens(),
      collateralAmount: model.collateral_amount(),
    };
    return info.sizeUsd > 0n ? info : null;
  } finally {
    model.free();
    marketModel.free();
  }
}

/**
 * Fetch several positions in two RPC calls. Returns one entry per request, `null` if
 * the position doesn't exist or is empty.
 */
export async function fetchPositions(
  connection: Connection,
  owner: PublicKey,
  requests: { market: MarketInfo; collateralToken: PublicKey; isLong: boolean }[],
): Promise<(PositionInfo | null)[]> {
  if (requests.length === 0) return [];
  const markets = [...new Map(requests.map((r) => [r.market.address.toBase58(), r.market])).values()];
  const addresses = requests.map((r) => findPositionAddress({ owner, ...r, marketToken: r.market.marketToken }));
  const [accounts, mints] = await Promise.all([
    connection.getMultipleAccountsInfo([...addresses, ...markets.map((m) => m.address)]),
    connection.getMultipleParsedAccounts(markets.map((m) => m.marketToken)),
  ]);
  const marketData = new Map(markets.map((m, i) => [m.address.toBase58(), accounts[addresses.length + i]]));
  const supply = new Map(
    markets.map((m, i) => {
      const data = mints.value[i]?.data;
      return [m.address.toBase58(), data && "parsed" in data ? BigInt(data.parsed.info.supply) : 0n];
    }),
  );

  return requests.map((r, i) => {
    const positionAccount = accounts[i];
    const marketAccount = marketData.get(r.market.address.toBase58());
    if (!positionAccount || !marketAccount) return null;
    const marketModel = Market.decode(marketAccount.data).to_model(supply.get(r.market.address.toBase58())!);
    const model = Position.decode(positionAccount.data).to_model(marketModel);
    try {
      const info: PositionInfo = {
        address: addresses[i],
        sizeUsd: model.size(),
        sizeInTokens: model.size_in_tokens(),
        collateralAmount: model.collateral_amount(),
      };
      return info.sizeUsd > 0n ? info : null;
    } finally {
      model.free();
      marketModel.free();
    }
  });
}

/** Average entry price of a position, given the index token's decimals. */
export function positionEntryPrice(position: PositionInfo, indexDecimals: number): number {
  if (position.sizeInTokens === 0n) return 0;
  return toUnitNumber(position.sizeUsd) / (Number(position.sizeInTokens) / 10 ** indexDecimals);
}

interface BuildOrderArgs {
  owner: PublicKey;
  market: MarketInfo;
  isLong: boolean;
  collateralToken: PublicKey;
  recentBlockhash: string;
  /** Priority fee, in micro-lamports per CU. */
  computeUnitPriceMicroLamports?: number;
}

function buildOrder(
  kind: CreateOrderKind,
  args: BuildOrderArgs,
  order: { size: bigint; amount: bigint; acceptablePrice?: bigint },
  tokens: { pay_token?: string; receive_token?: string },
): SerializedTransactionGroup {
  const marketToken = args.market.marketToken.toBase58();
  const group = create_orders(
    kind,
    [
      {
        market_token: marketToken,
        is_long: args.isLong,
        size: order.size,
        amount: order.amount,
        acceptable_price: order.acceptablePrice,
      },
    ],
    {
      recent_blockhash: args.recentBlockhash,
      compute_unit_price_micro_lamports: args.computeUnitPriceMicroLamports,
      payer: args.owner.toBase58(),
      collateral_or_swap_out_token: args.collateralToken.toBase58(),
      hints: new Map([
        [
          marketToken,
          {
            long_token: args.market.longToken.toBase58(),
            short_token: args.market.shortToken.toBase58(),
          },
        ],
      ]),
      ...tokens,
    },
  );
  try {
    return group.serialize();
  } finally {
    group.free();
  }
}

/** Build txs for a market-increase order (opens or adds to a position). */
export function buildOpenPositionTxs(
  args: BuildOrderArgs & {
    /** Collateral to pay, in collateral-token base units. */
    collateralAmount: bigint;
    /** Position size in USD (20 decimals, see `USD_UNIT`). */
    sizeUsd: bigint;
    acceptablePrice?: bigint;
  },
): SerializedTransactionGroup {
  return buildOrder(
    "MarketIncrease",
    args,
    { size: args.sizeUsd, amount: args.collateralAmount, acceptablePrice: args.acceptablePrice },
    { pay_token: args.collateralToken.toBase58() },
  );
}

/** Build txs for a market-decrease order. */
export function buildDecreasePositionTxs(
  args: BuildOrderArgs & {
    /** Size to remove, in USD (20 decimals). */
    sizeUsd: bigint;
    /** Collateral to withdraw, in collateral-token base units. */
    collateralAmount: bigint;
    acceptablePrice?: bigint;
  },
): SerializedTransactionGroup {
  return buildOrder(
    "MarketDecrease",
    args,
    { size: args.sizeUsd, amount: args.collateralAmount, acceptablePrice: args.acceptablePrice },
    { receive_token: args.collateralToken.toBase58() },
  );
}

/** Build txs for a market-decrease order that fully closes `position`. */
export function buildClosePositionTxs(
  args: BuildOrderArgs & { position: PositionInfo; acceptablePrice?: bigint },
): SerializedTransactionGroup {
  return buildDecreasePositionTxs({
    ...args,
    sizeUsd: args.position.sizeUsd,
    collateralAmount: args.position.collateralAmount,
  });
}

/** Merge groups step by step, so several orders go out together (and are signed in one prompt). */
export function mergeTransactionGroups(groups: SerializedTransactionGroup[]): SerializedTransactionGroup {
  const steps = Math.max(0, ...groups.map((g) => g.length));
  return Array.from({ length: steps }, (_, i) => groups.flatMap((g) => g[i] ?? []));
}

/**
 * Sign and send a serialized transaction group.
 * Steps are sent sequentially; transactions within a step are sent in parallel.
 */
export async function sendTransactionGroup(
  connection: Connection,
  signer: WalletSigner,
  group: SerializedTransactionGroup,
): Promise<string[]> {
  // Sign every step at once so the wallet prompts only once.
  const txs = group.flat().map((bytes) => VersionedTransaction.deserialize(Uint8Array.from(bytes)));
  const signedAll = await signer.signAllTransactions(txs);
  const signatures: string[] = [];
  let offset = 0;
  for (const step of group) {
    const signed = signedAll.slice(offset, (offset += step.length));
    const latest = await connection.getLatestBlockhash();
    const sigs = await Promise.all(
      signed.map((tx) => connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 })),
    );
    await Promise.all(
      sigs.map(async (signature) => {
        const res = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
        if (res.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
      }),
    );
    signatures.push(...sigs);
  }
  return signatures;
}

/** Poll until `predicate(position)` holds, e.g. waiting for a keeper to execute an order. */
export async function waitForPosition(
  poll: () => Promise<PositionInfo | null>,
  predicate: (position: PositionInfo | null) => boolean,
  { timeoutMs = 90_000, intervalMs = 4_000 } = {},
): Promise<PositionInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const position = await poll();
    if (predicate(position)) return position;
    if (Date.now() > deadline) throw new Error("Timed out waiting for order execution");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Format a USD value with 20 decimals. */
export function formatUsd(value: bigint, digits = 4): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / USD_UNIT;
  const frac = (abs % USD_UNIT).toString().padStart(USD_DECIMALS, "0").slice(0, digits);
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

const BS58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BS58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
