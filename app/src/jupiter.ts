import type { PublicKey } from "@solana/web3.js";
import { PRIORITY_FEE_MICRO_LAMPORTS } from "./config";

/** Jupiter's free API (no key): swap routing for reserve tokens, and their USD prices. */
const JUPITER_API = "https://lite-api.jup.ag";
export const SWAP_SLIPPAGE_BPS = 50;

/** Build an unsigned Jupiter swap of `amount` raw units, as a one-step transaction group. */
export async function buildSwapTx(owner: PublicKey, inputMint: PublicKey, outputMint: PublicKey, amount: bigint) {
  const q = new URLSearchParams({
    inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), amount: amount.toString(), slippageBps: String(SWAP_SLIPPAGE_BPS),
  });
  const quoteRes = await fetch(`${JUPITER_API}/swap/v1/quote?${q}`);
  if (!quoteRes.ok) throw new Error(`Jupiter quote ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as { outAmount: string; otherAmountThreshold: string };
  const swapRes = await fetch(`${JUPITER_API}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote, userPublicKey: owner.toBase58(), dynamicComputeUnitLimit: true,
      computeUnitPriceMicroLamports: PRIORITY_FEE_MICRO_LAMPORTS,
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap ${swapRes.status}`);
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
  const bytes = Array.from(atob(swapTransaction), (c) => c.charCodeAt(0));
  return { group: [[bytes]], outAmount: BigInt(quote.outAmount), minOut: BigInt(quote.otherAmountThreshold) };
}

/** USD prices by mint. */
export async function loadTokenPrices(mints: PublicKey[]): Promise<Record<string, number | null>> {
  const ids = mints.map((m) => m.toBase58());
  const res = await fetch(`${JUPITER_API}/price/v3?ids=${ids.join(",")}`);
  if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
  const body = (await res.json()) as Record<string, { usdPrice: number } | undefined>;
  return Object.fromEntries(ids.map((id) => [id, body[id]?.usdPrice ?? null]));
}
