// Open small market positions on GMTrade, wait for keeper execution, then close them.
//
//   npm run open-close              # live (mainnet, real funds)
//   npm run open-close -- --dry-run # build + simulate txs, send nothing
//   npm run open-close -- --open-only   # open and leave the positions running
//   npm run open-close -- --close-only  # close existing positions for the legs
//
//   LEGS="SPY/USD[USDC-USDC]:long,EUR/USD[USDC-USDC]:long" npm run open-close
import "./node-shim.ts";
import { existsSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import { homedir } from "node:os";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  USDC_MINT,
  USD_UNIT,
  buildClosePositionTxs,
  buildOpenPositionTxs,
  fetchPosition,
  findMarkets,
  type MarketInfo,
  formatUsd,
  sendTransactionGroup,
  waitForPosition,
  type PositionInfo,
  type WalletSigner,
} from "../src/gmtrade.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const KEYPAIR = process.env.KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
const COLLATERAL_USDC = Number(process.env.COLLATERAL_USDC ?? "5");
const SIZE_USD = Number(process.env.SIZE_USD ?? "10");
const MARKET = process.env.MARKET ?? "SOL/USD[WSOL-USDC]";
const IS_LONG = (process.env.IS_LONG ?? "true") !== "false";
/** Comma-separated `market:long|short` legs, opened together; each uses SIZE_USD / COLLATERAL_USDC. Overrides MARKET/IS_LONG. */
const LEGS = parseLegs(process.env.LEGS ?? `${MARKET}:${IS_LONG ? "long" : "short"}`);
const PRIORITY_FEE = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? "50000");
const DRY_RUN = process.argv.includes("--dry-run");
/** Open the legs and leave them running. */
const OPEN_ONLY = process.argv.includes("--open-only");
/** Close existing positions for the legs, without opening anything. */
const CLOSE_ONLY = process.argv.includes("--close-only");

function parseLegs(spec: string): { marketName: string; isLong: boolean }[] {
  return spec.split(",").map((leg) => {
    const i = leg.lastIndexOf(":");
    const side = leg.slice(i + 1).trim().toLowerCase();
    if (i < 0 || (side !== "long" && side !== "short")) throw new Error(`Bad leg "${leg}", expected market:long|short`);
    return { marketName: leg.slice(0, i).trim(), isLong: side === "long" };
  });
}

/** `PRIVATE_KEY` (base58, as exported by Phantom) takes precedence over the `KEYPAIR` JSON file. */
function loadKeypair(): Keypair {
  if (process.env.PRIVATE_KEY) return Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
}

function keypairSigner(keypair: Keypair): WalletSigner {
  return {
    publicKey: keypair.publicKey,
    async signAllTransactions<T extends VersionedTransaction>(txs: T[]) {
      for (const tx of txs) tx.sign([keypair]);
      return txs;
    },
  };
}

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

async function usdcBalance(connection: Connection, owner: PublicKey): Promise<number> {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), USDC_MINT.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!(await connection.getAccountInfo(ata))) return 0;
  return (await connection.getTokenAccountBalance(ata)).value.uiAmount ?? 0;
}

function describeGroup(group: number[][][]): string {
  return group.map((step, i) => `step ${i}: ${step.length} tx (${step.map((t) => t.length).join(", ")} bytes)`).join("; ");
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const keypair = loadKeypair();
  const signer = keypairSigner(keypair);
  const owner = signer.publicKey;

  console.log(`Wallet: ${owner.toBase58()}`);
  console.log(`SOL:    ${(await connection.getBalance(owner)) / LAMPORTS_PER_SOL}`);
  console.log(`USDC:   ${await usdcBalance(connection, owner)}`);

  const markets = await findMarkets(connection, LEGS.map((l) => l.marketName));
  const legs = LEGS.map((l, i) => ({ ...l, market: markets[i] }));
  type Leg = (typeof legs)[number];
  const label = (leg: Leg) => `${leg.isLong ? "LONG" : "SHORT"} ${leg.market.name}`;
  console.log(CLOSE_ONLY ? "Legs to close:" : `Legs (each $${SIZE_USD} with ${COLLATERAL_USDC} USDC collateral):`);
  for (const leg of legs) console.log(`  ${label(leg)}  ${leg.market.address.toBase58()}`);

  const common = (leg: Leg) => ({
    owner,
    market: leg.market as MarketInfo,
    isLong: leg.isLong,
    collateralToken: USDC_MINT,
    computeUnitPriceMicroLamports: PRIORITY_FEE,
  });
  const poll = (leg: Leg) => () => fetchPosition(connection, common(leg));

  async function closePositions(positions: { leg: Leg; position: PositionInfo }[]) {
    for (const { leg, position } of positions) {
      const closeTxs = buildClosePositionTxs({
        ...common(leg),
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        position,
      });
      const sigs = await sendTransactionGroup(connection, signer, closeTxs);
      console.log(`Close ${label(leg)} order created: ${sigs.join(", ")}`);
    }
    if (positions.length) {
      console.log("Waiting for keeper to execute...");
      for (const { leg } of positions) await waitForPosition(poll(leg), (p) => p === null);
      console.log("All positions closed.");
    }
    console.log(`USDC:   ${await usdcBalance(connection, owner)}`);
  }

  if (CLOSE_ONLY) {
    const existing: { leg: Leg; position: PositionInfo }[] = [];
    for (const leg of legs) {
      const position = await poll(leg)();
      if (position) existing.push({ leg, position });
      else console.log(`No ${label(leg)} position to close.`);
    }
    await closePositions(existing);
    return;
  }

  for (const leg of legs) {
    if (await poll(leg)()) throw new Error(`A ${label(leg)} position already exists; close it first.`);
  }

  // --- Open ---
  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const openTxs = legs.map((leg) =>
    buildOpenPositionTxs({
      ...common(leg),
      recentBlockhash,
      collateralAmount: BigInt(Math.round(COLLATERAL_USDC * 1e6)),
      sizeUsd: BigInt(Math.round(SIZE_USD * 100)) * (USD_UNIT / 100n),
    }),
  );
  legs.forEach((leg, i) => console.log(`Open ${label(leg)} txs: ${describeGroup(openTxs[i])}`));

  if (DRY_RUN) {
    for (const [i, leg] of legs.entries()) {
      const tx = VersionedTransaction.deserialize(Uint8Array.from(openTxs[i][0][0]));
      const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      console.log(`Simulated open ${label(leg)}: ${sim.value.err ? `error ${JSON.stringify(sim.value.err)}` : "ok"}`);
      if (sim.value.err) for (const line of sim.value.logs?.slice(-5) ?? []) console.log(`  ${line}`);
    }
    console.log("Dry run: nothing sent.");
    return;
  }

  for (const [i, leg] of legs.entries()) {
    const sigs = await sendTransactionGroup(connection, signer, openTxs[i]);
    console.log(`Open ${label(leg)} order created: ${sigs.join(", ")}`);
  }
  console.log("Waiting for keeper to execute...");
  const opened: { leg: Leg; position: PositionInfo }[] = [];
  for (const leg of legs) {
    // Sequential polling keeps the public RPC under its rate limit.
    try {
      const p = (await waitForPosition(poll(leg), (p) => p !== null))!;
      opened.push({ leg, position: p });
      console.log(
        `${label(leg)} opened: ${p.address.toBase58()} size ${formatUsd(p.sizeUsd)}, ` +
          `collateral ${Number(p.collateralAmount) / 1e6} USDC`,
      );
    } catch {
      console.error(`${label(leg)} did not open (order cancelled or not executed in time).`);
    }
  }

  if (OPEN_ONLY) {
    console.log("Leaving positions open. Close them with --close-only and the same LEGS.");
    console.log(`USDC:   ${await usdcBalance(connection, owner)}`);
  } else {
    // Close whatever actually opened.
    await closePositions(opened);
  }
  if (opened.length < legs.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
