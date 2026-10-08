// Snapshot all GMTrade markets into app/src/markets.json so the browser app
// doesn't need a full getProgramAccounts scan (often rate-limited from browsers).
//
//   npm run sync-markets
import "./node-shim.ts";
import { existsSync, writeFileSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { listMarkets } from "../src/gmtrade.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const markets = await listMarkets(connection);

// Index token decimals are needed to turn `size_in_tokens` into an entry price.
const decimals = new Map<string, number>();
const indexTokens = [...new Set(markets.map((m) => m.indexToken.toBase58()))];
for (let i = 0; i < indexTokens.length; i += 100) {
  const chunk = indexTokens.slice(i, i + 100);
  const infos = await connection.getMultipleParsedAccounts(chunk.map((a) => markets.find((m) => m.indexToken.toBase58() === a)!.indexToken));
  infos.value.forEach((info, j) => {
    const parsed = info && "parsed" in info.data ? info.data.parsed : null;
    if (parsed?.info?.decimals !== undefined) decimals.set(chunk[j], parsed.info.decimals);
  });
}

const out = markets
  .map((m) => ({
    name: m.name,
    address: m.address.toBase58(),
    marketToken: m.marketToken.toBase58(),
    indexToken: m.indexToken.toBase58(),
    longToken: m.longToken.toBase58(),
    shortToken: m.shortToken.toBase58(),
    indexDecimals: decimals.get(m.indexToken.toBase58()) ?? null,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync("app/src/markets.json", JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${out.length} markets to app/src/markets.json`);
