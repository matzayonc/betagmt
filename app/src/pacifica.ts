import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  bs58Encode,
  findAssociatedTokenAddress,
} from "../../src/gmtrade";
import { PRIORITY_FEE_MICRO_LAMPORTS } from "./config";

/**
 * Pacifica: a Solana perp DEX with an off-chain order book. USDC is deposited on-chain;
 * orders and withdrawals are JSON messages signed by the wallet (no transaction).
 */
const API = "https://api.pacifica.fi/api/v1";
const PROGRAM_ID = new PublicKey("PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH");
const CENTRAL_STATE = new PublicKey("9Gdmhq4Gv1LnNMp7aiS1HSVd7pNnXNMsbuXALCQRmGjY");
const VAULT = new PublicKey("72R843XwZxqWhsJceARQQTTbYtWy6Zw9et2YV4FpRHTa");
const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync([new TextEncoder().encode("__event_authority")], PROGRAM_ID);
/** Anchor discriminator: sha256("global:deposit")[..8]. */
const DEPOSIT_DISCRIMINATOR = [242, 35, 198, 137, 82, 225, 242, 182];

export const PACIFICA_MIN_DEPOSIT = 10;
export const PACIFICA_WITHDRAW_FEE = 1;
export const PACIFICA_SLIPPAGE_PERCENT = "0.5";

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export interface PacificaMarket {
  maxLeverage: number;
  lotSize: number;
  minOrderUsd: number;
}

export interface PacificaPosition {
  side: "bid" | "ask";
  amount: number;
  entryPrice: number;
}

export interface PacificaAccount {
  balance: number;
  availableToSpend: number;
  availableToWithdraw: number;
  takerFee: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  const body = (await res.json()) as { success: boolean; data: T; error: string | null };
  if (!res.ok || !body.success) throw new Error(`Pacifica: ${body.error ?? res.status}`);
  return body.data;
}

export async function loadPacificaMarket(symbol: string): Promise<PacificaMarket> {
  const markets = await get<{ symbol: string; max_leverage: number; lot_size: string; min_order_size: string }[]>("/info");
  const m = markets.find((x) => x.symbol === symbol);
  if (!m) throw new Error(`Pacifica has no ${symbol} market`);
  return { maxLeverage: m.max_leverage, lotSize: Number(m.lot_size), minOrderUsd: Number(m.min_order_size) };
}

export async function loadPacificaPrice(symbol: string): Promise<number | null> {
  const prices = await get<{ symbol: string; mark: string }[]>("/info/prices");
  const p = prices.find((x) => x.symbol === symbol);
  return p ? Number(p.mark) : null;
}

/** Null when the wallet has never used Pacifica. */
export async function loadPacificaAccount(owner: PublicKey): Promise<PacificaAccount | null> {
  try {
    const a = await get<{ balance: string; available_to_spend: string; available_to_withdraw: string; taker_fee: string }>(
      `/account?account=${owner.toBase58()}`,
    );
    return {
      balance: Number(a.balance), availableToSpend: Number(a.available_to_spend),
      availableToWithdraw: Number(a.available_to_withdraw), takerFee: Number(a.taker_fee),
    };
  } catch {
    return null;
  }
}

export async function loadPacificaPositions(owner: PublicKey): Promise<Record<string, PacificaPosition>> {
  const list = await get<{ symbol: string; side: "bid" | "ask"; amount: string; entry_price: string }[]>(
    `/positions?account=${owner.toBase58()}`,
  );
  return Object.fromEntries(list.map((p) => [p.symbol, { side: p.side, amount: Number(p.amount), entryPrice: Number(p.entry_price) }]));
}

/** On-chain USDC deposit into the owner's Pacifica account, as a one-step transaction group. */
export function buildPacificaDepositTx(owner: PublicKey, usdc: number, recentBlockhash: string): number[][][] {
  const data = new Uint8Array(16);
  data.set(DEPOSIT_DISCRIMINATOR);
  new DataView(data.buffer).setBigUint64(8, BigInt(Math.round(usdc * 1e6)), true);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: findAssociatedTokenAddress(owner, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: CENTRAL_STATE, isSigner: false, isWritable: true },
      { pubkey: VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: data as Buffer,
  });
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }), ix],
  }).compileToV0Message();
  return [[Array.from(new VersionedTransaction(message).serialize())]];
}

/** Recursively sort object keys, as Pacifica's signature check expects. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** A request body signed by the wallet: the payload plus account, signature and timing fields. */
async function signRequest(type: string, payload: Record<string, unknown>, owner: PublicKey, sign: SignMessage) {
  const header = { type, timestamp: Date.now(), expiry_window: 120_000 };
  const message = JSON.stringify(sortKeys({ ...header, data: payload }));
  const signature = bs58Encode(await sign(new TextEncoder().encode(message)));
  return { account: owner.toBase58(), signature, timestamp: header.timestamp, expiry_window: header.expiry_window, ...payload };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string };
  if (!res.ok || json.success === false) throw new Error(`Pacifica: ${json.error ?? res.status}`);
  return json.data as T;
}

export interface PacificaOrder {
  symbol: string;
  isLong: boolean;
  /** Base units (index points for SP500, euros for EURUSD), already rounded to the lot size. */
  amount: string;
  reduceOnly: boolean;
}

/**
 * Market orders, executed back to back in one batch. Pacifica signs each order separately,
 * so the wallet prompts once per order.
 */
export async function placePacificaMarketOrders(owner: PublicKey, sign: SignMessage, orders: PacificaOrder[]) {
  const actions = [];
  for (const o of orders) {
    actions.push({
      type: "CreateMarket",
      data: await signRequest("create_market_order", {
        symbol: o.symbol, amount: o.amount, side: o.isLong ? "bid" : "ask",
        slippage_percent: PACIFICA_SLIPPAGE_PERCENT, reduce_only: o.reduceOnly, client_order_id: crypto.randomUUID(),
      }, owner, sign),
    });
  }
  const { results } = await post<{ results: { success: boolean; error: string | null }[] }>("/orders/batch", { actions });
  const failed = results.map((r, i) => (r.success ? null : `${orders[i].symbol}: ${r.error}`)).filter(Boolean);
  if (failed.length) throw new Error(`Pacifica rejected ${failed.join("; ")}`);
}

/** Withdraw USDC to the wallet; Pacifica deducts its fee from `usdc` and pays out asynchronously. */
export async function requestPacificaWithdrawal(owner: PublicKey, sign: SignMessage, usdc: number) {
  const body = await signRequest("withdraw", { amount: (Math.floor(usdc * 1e6) / 1e6).toFixed(6) }, owner, sign);
  return post<{ requested_amount: string; fee_amount: string }>("/account/withdraw", body);
}

/** Round a base amount down to the market's lot size, as a decimal string. */
export function toLots(amount: number, lotSize: number): string {
  const dp = Math.max(0, -Math.floor(Math.log10(lotSize)));
  return (Math.floor(amount / lotSize + 1e-9) * lotSize).toFixed(dp);
}
