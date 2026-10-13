# Tilt

**Multi-leg perp strategies on [GMTrade](https://gmtrade.xyz) (GMX-Solana), opened and closed in one click.**

**Live demo:** https://matzayonc.github.io/betagmt/ (Solana mainnet, connect with Phantom)

GMTrade lists crypto, equity, FX and commodity perps side by side, but each position is opened on its own. Tilt packages them into strategies: pick one, choose long or short, set a size and leverage, and every leg goes out in a single wallet prompt.

| Strategy | Legs |
| --- | --- |
| SOL / BTC relative value | long SOL, short BTC (50/50) |
| S&P 500 vs euro | long SPY, short EUR/USD (50/50) |
| ETH beta-neutral | long ETH, short BTC 30%, short SOL 20% |
| Dollar vs gold | long EUR/USD 60%, long XAU 40% |

Shorting a strategy flips every leg. Strategies are defined in `app/src/config.ts`.

## Features

- **One signature per strategy:** each leg's order transactions are merged step by step and signed together, then the app waits for GMTrade's keeper to fill them. Legs that don't fill are reported.
- **Limits from chain:** max leverage, minimum collateral and order fees are decoded from each market account. Size and leverage are checked against them before anything is sent.
- **Live PnL:** entry prices, collateral and unrealized PnL come from the on-chain position accounts. Prices come from GMTrade's tickers, with on-chain Pyth as the fallback for crypto.
- **Market hours:** orders on closed markets (such as SPY outside US trading hours) are blocked up front, because the keeper would cancel them.
- **Shared positions:** GMTrade keeps one position per market and side, so two strategies can share a leg. Tilt records each strategy's share per wallet and closes only that share. It also recognizes strategies from positions opened elsewhere.

## Repository layout

```
app/                 Web app (Vite + React), deployed to GitHub Pages
  src/App.tsx        UI and strategy open/close flow
  src/chain.ts       RPC connection, market params, balances, Phantom wallet
  src/prices.ts      GMTrade tickers, market status, Pyth fallback
  src/config.ts      Markets and strategy definitions
  src/markets.json   Snapshot of GMTrade market addresses
src/gmtrade.ts       Browser-safe GMTrade library (markets, positions, order builders, sending)
scripts/open-close.ts  CLI: open and close positions with a local keypair
scripts/sync-markets.ts  Refresh app/src/markets.json
design/              Original UI design prototype
```

## Running locally

Requires Node 22+.

```bash
npm install
cp .env.example .env   # optional: set RPC_URL to a private RPC
npm run dev            # http://localhost:5173
```

In dev, RPC traffic goes through the Vite proxy (`/rpc`), because public RPCs reject browser origins.

Other scripts:

```bash
npm run typecheck
npm run build          # static build in dist/ (needs VITE_RPC_URL)
npm run sync-markets   # refresh app/src/markets.json
```

### CLI

`scripts/open-close.ts` opens small positions with a local keypair, waits for the keeper, then closes them. It uses real funds on mainnet.

```bash
npm run open-close -- --dry-run     # build and simulate, send nothing
npm run open-close                  # open, then close
npm run open-close -- --open-only   # open and leave running
npm run open-close -- --close-only  # close existing positions for the same LEGS

LEGS="SPY/USD[USDC-USDC]:long,EUR/USD[USDC-USDC]:long" SIZE_USD=5 COLLATERAL_USDC=1.5 npm run open-close
```

Configuration is through env vars (see `.env.example`). The wallet needs USDC for collateral plus about 0.05 SOL for transaction fees, the keeper execution fee and account rent (the rent is refunded). Each market has a minimum collateral (it's $1 for the markets tried so far). Fees are deducted first, so collateral of exactly $1 is rejected.

## How orders work

1. `create_orders("MarketIncrease", …)` from `@gmsol-labs/gmsol-sdk` builds unsigned v0 transactions.
2. The wallet signs and sends them, which creates the order account on-chain.
3. A GMTrade keeper executes the order a few seconds later. The client polls the position PDA until it has the expected size.
4. Closing uses `create_orders("MarketDecrease", …)` with the strategy's share of size and collateral, then polls until the position shrinks or is gone.

## Using `src/gmtrade.ts` in another app

```ts
import { findMarket, buildOpenPositionTxs, sendTransactionGroup, USDC_MINT, USD_UNIT } from "./gmtrade";

const market = await findMarket(connection, "SOL/USD[WSOL-USDC]");
const txs = buildOpenPositionTxs({
  owner: wallet.publicKey, market, isLong: true, collateralToken: USDC_MINT,
  collateralAmount: 5_000_000n, sizeUsd: 10n * USD_UNIT,
  recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
});
await sendTransactionGroup(connection, wallet, txs);
```

It signs through any `WalletSigner`, so `useWallet()` from `@solana/wallet-adapter-react` works. The SDK is a wasm-pack *bundler* build, so the bundler must support WASM ESM imports:

- **Vite:** add `vite-plugin-wasm`.
- **Next.js:** `webpack: (c) => { c.experiments = { ...c.experiments, asyncWebAssembly: true }; return c; }`

`listMarkets` uses `getProgramAccounts`, which browsers should call through a private RPC. You can also cache the market list, as this app does with `markets.json`.

## Deploying

`.github/workflows/pages.yml` typechecks, builds and deploys the app on every push to `main`. One-time setup:

1. **Settings → Pages:** set *Source* to **GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables:** add `VITE_RPC_URL` with an RPC endpoint that accepts browser requests (Helius, QuickNode, Triton, …). The URL ends up in the public bundle, so restrict the key to your Pages domain in the provider's dashboard.

## Notes

- The SDK is pinned to `0.9.0`, because the npm tarball for `0.10.0` contains no build files.
- This is hackathon software that trades with real funds on mainnet. It has not been audited.

## License

[MIT](LICENSE)
