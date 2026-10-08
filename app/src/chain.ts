import { Connection, PublicKey, LAMPORTS_PER_SOL, type VersionedTransaction } from "@solana/web3.js";
import { USDC_MINT, decodeMarketParams, type MarketInfo, type MarketParams, type WalletSigner } from "../../src/gmtrade";
import marketsJson from "./markets.json";
import { MARKETS, MARKET_KEYS, RPC_URL, type MarketKey } from "./config";

export const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  // web3.js otherwise assumes a local validator when the URL has a port and uses port + 1
  // for websockets (ws://localhost:5174 for the dev proxy). Keep it on the same host/port.
  wsEndpoint: RPC_URL.replace(/^http/, "ws"),
});

export interface AppMarket extends MarketInfo {
  indexDecimals: number;
}

const byName = new Map(marketsJson.map((m) => [m.name, m]));

/** Resolve the configured markets from the markets.json snapshot (see `npm run sync-markets`). */
export const APP_MARKETS = Object.fromEntries(
  MARKET_KEYS.map((key) => {
    const m = byName.get(MARKETS[key].market);
    if (!m || m.indexDecimals === null) throw new Error(`Market ${MARKETS[key].market} missing from markets.json`);
    const market: AppMarket = {
      name: m.name,
      address: new PublicKey(m.address),
      marketToken: new PublicKey(m.marketToken),
      indexToken: new PublicKey(m.indexToken),
      longToken: new PublicKey(m.longToken),
      shortToken: new PublicKey(m.shortToken),
      indexDecimals: m.indexDecimals,
    };
    return [key, market];
  }),
) as Record<MarketKey, AppMarket>;

export async function loadMarketParams(): Promise<Record<MarketKey, MarketParams>> {
  const accounts = await connection.getMultipleAccountsInfo(MARKET_KEYS.map((k) => APP_MARKETS[k].address));
  return Object.fromEntries(
    MARKET_KEYS.map((k, i) => {
      const account = accounts[i];
      if (!account) throw new Error(`Market account for ${k} not found`);
      return [k, decodeMarketParams(account.data)];
    }),
  ) as Record<MarketKey, MarketParams>;
}

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export async function loadBalances(owner: PublicKey): Promise<{ usdc: number; sol: number }> {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), USDC_MINT.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const {
    value: [solInfo, ataInfo],
  } = await connection.getMultipleParsedAccounts([owner, ata]);
  const data = ataInfo?.data;
  const usdc = data && "parsed" in data ? Number(data.parsed.info.tokenAmount.uiAmount ?? 0) : 0;
  return { usdc, sol: (solInfo?.lamports ?? 0) / LAMPORTS_PER_SOL };
}

// --- Wallet (Phantom or any provider injected as window.solana) ---

export interface InjectedWallet {
  publicKey: PublicKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signAllTransactions<T extends VersionedTransaction>(txs: T[]): Promise<T[]>;
}

export function getInjectedWallet(): InjectedWallet | null {
  const w = window as unknown as { phantom?: { solana?: InjectedWallet }; solana?: InjectedWallet };
  return w.phantom?.solana ?? w.solana ?? null;
}

export function walletSigner(wallet: InjectedWallet, publicKey: PublicKey, onSigned?: () => void): WalletSigner {
  return {
    publicKey,
    async signAllTransactions(txs) {
      const signed = await wallet.signAllTransactions(txs);
      onSigned?.();
      return signed;
    },
  };
}
