# GMTrade open/close script

Opens a small market position on [GMTrade](https://gmtrade.xyz) (GMX-Solana, mainnet), waits for a keeper to execute it, then closes it.

- `src/gmtrade.ts`: a browser-safe library (market lookup, position fetch, order tx builders, a send helper). It signs through any `WalletSigner`, so `useWallet()` from `@solana/wallet-adapter-react` works.
- `scripts/open-close.ts`: a Node CLI that uses a local keypair.

## Run

```bash
npm install
npm run open-close -- --dry-run   # builds + simulates, sends nothing
npm run open-close                # REAL FUNDS: opens then closes
npm run open-close -- --open-only  # open and leave running
npm run open-close -- --close-only # close existing positions for the same LEGS
```

Several legs at once, e.g. S&P long with the USD hedged against EUR:

```bash
LEGS="SPY/USD[USDC-USDC]:long,EUR/USD[USDC-USDC]:long" SIZE_USD=5 COLLATERAL_USDC=1.5 npm run open-close
```

Each market has a minimum collateral (it's $1 for the markets tried so far). Because fees are deducted first, collateral of exactly $1 gets rejected.

Configure the run through env vars (see `.env.example`). Defaults: `SOL/USD[WSOL-USDC]`, a long, 5 USDC collateral, $10 size.
The wallet needs USDC (collateral) plus about 0.05 SOL for tx fees, the keeper execution fee and account rent (the rent is refunded).

## How it works

1. `create_orders("MarketIncrease", …)` from `@gmsol-labs/gmsol-sdk` builds unsigned v0 transactions.
2. The wallet signs and sends them. The order account is created on-chain.
3. A GMTrade keeper executes the order a few seconds later. The script polls the position PDA until it has a size.
4. `create_orders("MarketDecrease", …)` uses the full size and collateral, then the script polls until the position is gone.

## Web app (Strategies)

`app/` is the `Strategies.dc.html` design, ported to Vite + React and wired to GMTrade mainnet. You connect with Phantom.

```bash
npm run dev            # http://localhost:5173
npm run sync-markets   # refresh app/src/markets.json (market addresses)
npm run build          # static build in dist/ (needs VITE_RPC_URL)
```

- **On-chain data:** max leverage, minimum collateral and fees come from each market's account. Positions, entry prices and PnL come from the position accounts.
- **Opening a strategy:** it builds one order per leg, all signed in a single wallet prompt. The app then waits for the keeper to fill them. Legs that don't fill are reported.
- **Strategy tracking:** strategies are tracked in `localStorage` per wallet, because on-chain positions are per market/side, not per strategy. When two strategies share a market leg, closing one removes only its share.
- **Prices:** from GMTrade's keeper API (`keeper-prod-api.gmtrade.xyz`), the same prices orders execute at. It also reports whether each market is open, and the app blocks orders on closed markets (for example SPY outside US hours). If the API is down, crypto prices fall back to on-chain Pyth.
- **RPC in dev:** RPC traffic goes through the Vite proxy (`/rpc`), because public RPCs reject browser origins.

### Deploying to GitHub Pages

`.github/workflows/pages.yml` builds and deploys the app on every push to `main`. One-time setup:

1. **Settings → Pages:** set *Source* to **GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables:** add `VITE_RPC_URL` with an RPC endpoint that accepts browser requests (Helius, QuickNode, Triton, …). The URL ends up in the public bundle, so restrict the key to your Pages domain in the provider's dashboard.

## Using it in a website

```ts
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { findMarket, buildOpenPositionTxs, sendTransactionGroup, USDC_MINT, USD_UNIT } from "./gmtrade";

const market = await findMarket(connection, "SOL/USD[WSOL-USDC]");
const txs = buildOpenPositionTxs({
  owner: wallet.publicKey, market, isLong: true, collateralToken: USDC_MINT,
  collateralAmount: 5_000_000n, sizeUsd: 10n * USD_UNIT,
  recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
});
await sendTransactionGroup(connection, wallet, txs);
```

The SDK is a wasm-pack *bundler* build, so the bundler must support WASM ESM imports:
- **Vite:** add `vite-plugin-wasm` and `vite-plugin-top-level-await`.
- **Next.js:** `webpack: (c) => { c.experiments = { ...c.experiments, asyncWebAssembly: true }; return c; }`
- `listMarkets` uses `getProgramAccounts`, which browsers should call through a private RPC. You can also cache the market list or hardcode `MarketInfo`.

## Notes
- The SDK is pinned to `0.9.0`, because the npm tarball for `0.10.0` contains no build files.
- Node needs `--experimental-wasm-modules` (the npm script sets it) plus `scripts/node-shim.ts`.
- `acceptable_price` is left unset, which means **no slippage protection**. Set `acceptablePrice` (unit price, 20 decimals) for real use.
