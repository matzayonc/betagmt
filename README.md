# Backdoor

**Multi-leg perp strategies on [GMTrade](https://gmtrade.xyz) (GMX-Solana), opened and closed in one click.**

**Live demo:** https://matzayonc.github.io/betagmt/ (Solana mainnet, connect with Phantom)

GMTrade lists crypto, equity, FX and commodity perps side by side, but each position is opened on its own. Backdoor packages them into strategies: pick one, choose long or short, set a size and leverage, and every leg goes out in a single wallet prompt.

| Strategy | Legs |
| --- | --- |
| S&P 500 vs euro | long SPY, short EUR/USD (50/50) |
| S&P 500 · yield, hedge, leverage | on [Pacifica](https://pacifica.fi) (24/7): half the capital is deposited as margin, backing a long S&P 500 of the same size and an equal long EUR/USD that hedges the dollar (2× on the margin). The other half is held in [ONyc](https://www.onre.finance/), swapped through Jupiter |

Shorting a strategy flips every leg. Strategies are defined in `app/src/config.ts`.

## Features

- **One signature per strategy:** each leg's order transactions are merged step by step and signed together, then the app waits for GMTrade's keeper to fill them. Legs that don't fill are reported.
- **Limits from chain:** max leverage, minimum collateral and order fees are decoded from each market account. Size and leverage are checked against them before anything is sent.
- **Live PnL:** entry prices, collateral and unrealized PnL come from the on-chain position accounts. Prices come from GMTrade's tickers, with on-chain Pyth as the fallback for crypto.
- **Pacifica legs:** the yield, hedge, leverage strategy deposits its margin to Pacifica and buys ONyc in one transaction prompt, then sends both orders as one batch (Pacifica needs a signed message per order). Closing signs the closing orders and a withdrawal (Pacifica charges $1), and sells the ONyc. Each step is recorded, so an interrupted close resumes where it stopped.
- **Market hours:** orders on closed markets (such as SPY outside US trading hours) are blocked up front, because the keeper would cancel them.
- **Shared positions:** GMTrade keeps one position per market and side, so two strategies can share a leg. Backdoor records each strategy's share per wallet and closes only that share. It also recognizes strategies from positions opened elsewhere.

## Repository layout

```
app/                 Web app (Vite + React), deployed to GitHub Pages
  src/App.tsx        UI and strategy open/close flow
  src/chain.ts       RPC connection, market params, balances, Phantom wallet
  src/prices.ts      GMTrade tickers, market status, Pyth fallback
  src/pacifica.ts    Pacifica deposits, signed orders and withdrawals
  src/jupiter.ts     Jupiter swaps and prices for ONyc
  src/config.ts      Markets and strategy definitions
  src/markets.json   Snapshot of GMTrade market addresses
src/gmtrade.ts       Browser-safe GMTrade library (markets, positions, order builders, sending)
scripts/open-close.ts  CLI: open and close positions with a local keypair
scripts/sync-markets.ts  Refresh app/src/markets.json
app/public/          Logo and favicon
design/              Original UI design prototype and logo source
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

## Disclaimer

**Backdoor is experimental, unaudited software provided "as is", without warranty of any kind. It is not ready for production use.** It trades leveraged perpetual futures with real funds on mainnet, and bugs, third-party protocol failures, liquidation or price moves can cost you everything you put in.

- Nothing here is financial, investment, legal or tax advice.
- Backdoor is not affiliated with GMTrade, Pacifica, Jupiter, ONyc or any wallet, and has no control over them.
- It is non-custodial: you sign every transaction yourself and are responsible for reviewing it.
- You are responsible for making sure that using it is legal where you are.
- To the maximum extent permitted by law, the author and contributors accept no responsibility or liability for any loss or damage arising from its use. You use it entirely at your own risk.

The app shows this notice and requires you to accept it before it connects to a wallet.

## License

[MIT](LICENSE). The license also disclaims all warranties and liability.
