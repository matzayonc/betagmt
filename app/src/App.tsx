// Port of Strategies.dc.html, wired to GMTrade (mainnet) via src/gmtrade.ts.
import { Component, type CSSProperties, type ChangeEvent } from "react";
import type { PublicKey } from "@solana/web3.js";
import {
  USDC_MINT,
  USD_UNIT,
  buildClosePositionTxs,
  buildDecreasePositionTxs,
  buildOpenPositionTxs,
  fetchPositions,
  mergeTransactionGroups,
  positionEntryPrice,
  sendTransactionGroup,
  type MarketParams,
  type PositionInfo,
} from "../../src/gmtrade";
import { APP_MARKETS, connection, getInjectedWallet, loadBalances, loadMarketParams, walletSigner } from "./chain";
import {
  MARKETS,
  MARKET_KEYS,
  MIN_COLLATERAL_MARGIN,
  PRIORITY_FEE_MICRO_LAMPORTS,
  SOL_PER_LEG,
  STRATEGIES,
  type MarketKey,
  type StrategyDef,
} from "./config";
import { loadPrices } from "./prices";

// --- helpers from the design ---
const UP = "oklch(0.78 0.16 155)", DN = "oklch(0.7 0.18 25)", ACC = "oklch(0.82 0.14 165)";
const n2 = (v: number, dp = 2) => v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtLev = (l: number) => (l < 10 ? l.toFixed(1) : Math.round(l)) + "×";
const num = (s: string) => parseFloat(String(s).replace(/,/g, "")) || 0;
const usd = (v: number, dp = 2) => (v >= 0 ? "+" : "−") + "$" + n2(Math.abs(v), dp);

// Inline style strings from the design → React style objects (cached).
const styleCache = new Map<string, CSSProperties>();
function css(s: string): CSSProperties {
  let out = styleCache.get(s);
  if (!out) {
    out = {};
    for (const decl of s.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      (out as Record<string, string>)[prop] = decl.slice(i + 1).trim();
    }
    styleCache.set(s, out);
  }
  return out;
}

const usdUnits = (v: number) => BigInt(Math.round(v * 1e6)) * (USD_UNIT / 1_000_000n);
const unitsToUsd = (v: bigint) => Number(v) / Number(USD_UNIT);
const legKey = (mkt: MarketKey, isLong: boolean) => `${mkt}:${isLong ? "L" : "S"}`;
const short = (pk: PublicKey) => { const s = pk.toBase58(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
/** `size` is the largest leg's notional; other legs scale by their weight relative to it. */
const legSize = (d: StrategyDef, w: number, size: number) => (size * w) / Math.max(...d.legs.map((l) => l.w));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Side = "long" | "short";

/** A strategy opened from this app. Positions are shared per market/side on-chain, so legs are tracked by size. */
interface OpenRecord {
  side: Side;
  size: number;
  lev: number;
  legs: { mkt: MarketKey; isLong: boolean; sizeUsd: number }[];
  openedAt: number;
}

/** Every market/side the strategies can use; positions for all of them are read on refresh. */
const ALL_LEGS = MARKET_KEYS.flatMap((mkt) => [true, false].map((isLong) => ({ mkt, isLong })));

/**
 * Recognize strategies from on-chain positions (opened elsewhere, or an open whose confirmation
 * was lost). Position size not already claimed by a recorded strategy is assigned, in strategy
 * order, to any strategy whose legs all have a matching position, scaled to its weights.
 */
function adoptFromPositions(
  open: Record<number, OpenRecord>,
  positions: Record<string, PositionInfo | null>,
  skip: Record<number, string>,
): Record<number, OpenRecord> | null {
  const remaining = new Map<string, number>();
  for (const [k, p] of Object.entries(positions)) if (p) remaining.set(k, unitsToUsd(p.sizeUsd));
  for (const rec of Object.values(open)) {
    for (const l of rec.legs) {
      const k = legKey(l.mkt, l.isLong);
      if (remaining.has(k)) remaining.set(k, remaining.get(k)! - l.sizeUsd);
    }
  }
  let next: Record<number, OpenRecord> | null = null;
  for (const d of STRATEGIES) {
    if (open[d.id] || skip[d.id]) continue;
    const maxW = Math.max(...d.legs.map((l) => l.w));
    for (const side of ["long", "short"] as const) {
      const legs = d.legs.map((l) => ({ mkt: l.mkt, isLong: l.dir * (side === "long" ? 1 : -1) > 0, rel: l.w / maxW }));
      const avail = legs.map((l) => remaining.get(legKey(l.mkt, l.isLong)) ?? 0);
      if (avail.some((a) => a < 0.01)) continue;
      // Largest size that fits every leg at the strategy's weights.
      const size = Math.min(...legs.map((l, i) => avail[i] / l.rel));
      let collateral = 0;
      const recLegs = legs.map((l) => {
        const k = legKey(l.mkt, l.isLong), p = positions[k]!, sizeUsd = size * l.rel;
        remaining.set(k, remaining.get(k)! - sizeUsd);
        collateral += (Number(p.collateralAmount) / 1e6) * (sizeUsd / unitsToUsd(p.sizeUsd));
        return { mkt: l.mkt, isLong: l.isLong, sizeUsd };
      });
      const total = recLegs.reduce((a, l) => a + l.sizeUsd, 0);
      next ??= { ...open };
      next[d.id] = { side, size, lev: collateral > 0 ? total / collateral : 1, legs: recLegs, openedAt: Date.now() };
      break;
    }
  }
  return next;
}

const storeKey = (owner: PublicKey) => `tilt.open.${owner.toBase58()}`;
function loadRecords(owner: PublicKey): Record<number, OpenRecord> {
  try { return JSON.parse(localStorage.getItem(storeKey(owner)) ?? "{}"); } catch { return {}; }
}
function saveRecords(owner: PublicKey, records: Record<number, OpenRecord>) {
  try { localStorage.setItem(storeKey(owner), JSON.stringify(records)); } catch { /* storage unavailable */ }
}

interface State {
  owner: PublicKey | null;
  connecting: boolean;
  balances: { usdc: number; sol: number } | null;
  params: Record<MarketKey, MarketParams> | null;
  prices: Partial<Record<MarketKey, number | null>>;
  /** Trading status per market from GMTrade (e.g. SPY outside US hours). */
  marketOpen: Partial<Record<MarketKey, boolean>>;
  positions: Record<string, PositionInfo | null>;
  open: Record<number, OpenRecord>;
  inputs: Record<number, { side: Side; size: string; lev: number }>;
  expanded: Record<number, boolean>;
  /** Strategy id → progress label while an open/close is in flight. */
  busy: Record<number, string>;
  toast: string | null;
  error: string | null;
}

export class App extends Component<object, State> {
  state: State = {
    owner: null,
    connecting: false,
    balances: null,
    params: null,
    prices: {},
    marketOpen: {},
    positions: {},
    open: {},
    inputs: Object.fromEntries(STRATEGIES.map((d) => [d.id, { side: "long", size: "20", lev: 2 }])),
    expanded: { 2: true },
    busy: {},
    toast: null,
    error: null,
  };
  private timers: ReturnType<typeof setInterval>[] = [];
  private toastTimer?: ReturnType<typeof setTimeout>;

  componentDidMount() {
    loadMarketParams().then((params) => this.setState({ params })).catch((e) => this.setState({ error: `Failed to load markets: ${e.message}` }));
    this.refreshPrices();
    this.timers.push(setInterval(this.refreshPrices, 10_000), setInterval(this.refreshAccount, 10_000));
    // Reconnect silently if the wallet already trusts this site.
    getInjectedWallet()?.connect({ onlyIfTrusted: true }).then(({ publicKey }) => this.onConnected(publicKey)).catch(() => {});
  }

  componentWillUnmount() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.toastTimer);
  }

  flash(msg: string, ms = 4000) {
    this.setState({ toast: msg });
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.setState({ toast: null }), ms);
  }

  refreshPrices = async () => {
    try {
      const { prices, isOpen } = await loadPrices();
      // Keep the last good value when a source temporarily has no price.
      this.setState((s) => ({
        prices: Object.fromEntries(MARKET_KEYS.map((k) => [k, prices[k] ?? s.prices[k] ?? null])),
        marketOpen: { ...s.marketOpen, ...isOpen },
      }));
    } catch (e) { console.warn("prices", e); }
  };

  private async readPositions(legs: { mkt: MarketKey; isLong: boolean }[]) {
    const owner = this.state.owner!;
    const res = await fetchPositions(connection, owner, legs.map((l) => ({ market: APP_MARKETS[l.mkt], collateralToken: USDC_MINT, isLong: l.isLong })));
    return Object.fromEntries(legs.map((l, i) => [legKey(l.mkt, l.isLong), res[i]]));
  }

  refreshAccount = async () => {
    const owner = this.state.owner;
    if (!owner) return;
    try {
      const [balances, positions] = await Promise.all([loadBalances(owner), this.readPositions(ALL_LEGS)]);
      this.setState((s) => {
        // Drop strategies whose positions were closed elsewhere (or liquidated).
        const open = { ...s.open };
        let changed = false;
        for (const [id, rec] of Object.entries(open)) {
          if (s.busy[+id]) continue;
          if (rec.legs.every((l) => positions[legKey(l.mkt, l.isLong)] === null)) { delete open[+id]; changed = true; }
        }
        const adopted = adoptFromPositions(open, positions, s.busy);
        if (changed || adopted) saveRecords(owner, adopted ?? open);
        return { balances, positions: { ...s.positions, ...positions }, open: adopted ?? open };
      });
    } catch (e) { console.warn("account", e); }
  };

  onConnected(owner: PublicKey) {
    this.setState({ owner, connecting: false, open: loadRecords(owner) }, this.refreshAccount);
  }

  connect = async () => {
    const wallet = getInjectedWallet();
    if (this.state.owner) {
      await wallet?.disconnect().catch(() => {});
      return this.setState({ owner: null, balances: null, positions: {}, open: {} });
    }
    if (!wallet) return this.flash("No Solana wallet found — install Phantom");
    this.setState({ connecting: true });
    try { this.onConnected((await wallet.connect()).publicKey); } catch { this.setState({ connecting: false }); }
  };

  setIn(id: number, patch: Partial<State["inputs"][number]>) {
    this.setState((s) => ({ inputs: { ...s.inputs, [id]: { ...s.inputs[id], ...patch } } }));
  }

  private setBusy(id: number, label: string | null) {
    this.setState((s) => {
      const busy = { ...s.busy };
      if (label) busy[id] = label; else delete busy[id];
      return { busy };
    });
  }

  /** Poll positions until `done` holds or the keeper takes too long. */
  private async waitForKeeper(legs: { mkt: MarketKey; isLong: boolean }[], done: (p: Record<string, PositionInfo | null>) => boolean) {
    const deadline = Date.now() + 90_000;
    for (;;) {
      await sleep(3_000);
      const positions = await this.readPositions(legs);
      this.setState((s) => ({ positions: { ...s.positions, ...positions } }));
      if (done(positions) || Date.now() > deadline) return positions;
    }
  }

  async openStrategy(d: StrategyDef, side: Side, size: number, lev: number) {
    const owner = this.state.owner!, wallet = getInjectedWallet()!;
    const legs = d.legs.map((l) => ({ mkt: l.mkt, isLong: l.dir * (side === "long" ? 1 : -1) > 0, sizeUsd: legSize(d, l.w, size) }));
    try {
      this.setBusy(d.id, "Preparing…");
      const before = await this.readPositions(legs);
      const { blockhash } = await connection.getLatestBlockhash();
      const group = mergeTransactionGroups(legs.map((l) => buildOpenPositionTxs({
        owner, market: APP_MARKETS[l.mkt], isLong: l.isLong, collateralToken: USDC_MINT,
        recentBlockhash: blockhash, computeUnitPriceMicroLamports: PRIORITY_FEE_MICRO_LAMPORTS,
        collateralAmount: BigInt(Math.floor((l.sizeUsd / lev) * 1e6)), sizeUsd: usdUnits(l.sizeUsd),
      })));
      this.setBusy(d.id, "Confirm in wallet…");
      await sendTransactionGroup(connection, walletSigner(wallet, owner, () => this.setBusy(d.id, "Submitting…")), group);
      this.setBusy(d.id, "Waiting for keeper…");
      const target = (l: (typeof legs)[number]) => (before[legKey(l.mkt, l.isLong)]?.sizeUsd ?? 0n) + (usdUnits(l.sizeUsd) * 99n) / 100n;
      const filledNow = (p: Record<string, PositionInfo | null>) => legs.filter((l) => (p[legKey(l.mkt, l.isLong)]?.sizeUsd ?? 0n) >= target(l));
      const after = await this.waitForKeeper(legs, (p) => filledNow(p).length === legs.length);
      const filled = filledNow(after);
      if (filled.length === 0) {
        this.flash(`${d.name}: orders were not executed (cancelled by keeper or timed out). Collateral is refunded on cancellation.`, 7000);
      } else {
        const record: OpenRecord = { side, size, lev, legs: filled, openedAt: Date.now() };
        this.setState((s) => { const open = { ...s.open, [d.id]: record }; saveRecords(owner, open); return { open }; });
        this.flash(filled.length === legs.length
          ? `${d.name} opened · ${n2(legs.reduce((a, l) => a + l.sizeUsd, 0) / lev)} USDC posted`
          : `${d.name}: only ${filled.length}/${legs.length} legs filled — review and close if needed`, 7000);
      }
    } catch (e) {
      this.flash(/reject|cancel/i.test(String(e))
        ? "Cancelled in wallet"
        : `Couldn't confirm the order (${(e as Error).message}). If it went through, the strategy will show up here once filled.`, 8000);
    } finally {
      this.setBusy(d.id, null);
      this.refreshAccount();
    }
  }

  async closeStrategy(d: StrategyDef, rec: OpenRecord, pnl: number | null) {
    const owner = this.state.owner!, wallet = getInjectedWallet()!;
    try {
      this.setBusy(d.id, "Preparing…");
      const current = await this.readPositions(rec.legs);
      const { blockhash } = await connection.getLatestBlockhash();
      const common = (l: OpenRecord["legs"][number]) => ({
        owner, market: APP_MARKETS[l.mkt], isLong: l.isLong, collateralToken: USDC_MINT,
        recentBlockhash: blockhash, computeUnitPriceMicroLamports: PRIORITY_FEE_MICRO_LAMPORTS,
      });
      const legs = rec.legs.filter((l) => current[legKey(l.mkt, l.isLong)]);
      const groups = legs.map((l) => {
        const p = current[legKey(l.mkt, l.isLong)]!, legUnits = usdUnits(l.sizeUsd);
        // Another strategy may share this position; only remove this strategy's share.
        if (legUnits * 1000n >= p.sizeUsd * 999n) return buildClosePositionTxs({ ...common(l), position: p });
        return buildDecreasePositionTxs({ ...common(l), sizeUsd: legUnits, collateralAmount: (p.collateralAmount * legUnits) / p.sizeUsd });
      });
      if (groups.length) {
        this.setBusy(d.id, "Confirm in wallet…");
        await sendTransactionGroup(connection, walletSigner(wallet, owner, () => this.setBusy(d.id, "Submitting…")), mergeTransactionGroups(groups));
        this.setBusy(d.id, "Waiting for keeper…");
        const left = (l: (typeof legs)[number]) => current[legKey(l.mkt, l.isLong)]!.sizeUsd - (usdUnits(l.sizeUsd) * 99n) / 100n;
        const after = await this.waitForKeeper(legs, (p) => legs.every((l) => (p[legKey(l.mkt, l.isLong)]?.sizeUsd ?? 0n) <= left(l)));
        if (!legs.every((l) => (after[legKey(l.mkt, l.isLong)]?.sizeUsd ?? 0n) <= left(l))) {
          return this.flash(`${d.name}: close not executed yet — check positions and retry`, 7000);
        }
      }
      this.setState((s) => { const open = { ...s.open }; delete open[d.id]; saveRecords(owner, open); return { open }; });
      this.flash(`Closed ${d.name}${pnl === null ? "" : ` · ${usd(pnl)} est. realized`}`);
    } catch (e) {
      this.flash(/reject|cancel/i.test(String(e)) ? "Cancelled in wallet" : `Close failed: ${(e as Error).message}`, 6000);
    } finally {
      this.setBusy(d.id, null);
      this.refreshAccount();
    }
  }

  renderVals() {
    const s = this.state, P = s.prices;
    const connected = !!s.owner;
    let used = 0, totalPnl = 0, pnlKnown = true;
    const anyBusy = Object.keys(s.busy).length > 0;

    const strategies = STRATEGIES.map((d) => {
      const exp = !!s.expanded[d.id], rec = s.open[d.id], isOpen = !!rec, inp = s.inputs[d.id], busy = s.busy[d.id];
      const params = s.params;
      const max = params ? Math.floor(Math.min(...d.legs.map((l) => params[l.mkt].maxLeverage))) : 0;
      const side = isOpen ? rec.side : inp.side, size = isOpen ? rec.size : num(inp.size), lev = isOpen ? rec.lev : Math.min(inp.lev, max || inp.lev), long = side === "long";
      // Total notional: from the recorded legs once open, otherwise from the inputs.
      const total = isOpen ? rec.legs.reduce((a, l) => a + l.sizeUsd, 0) : d.legs.reduce((a, l) => a + legSize(d, l.w, size), 0);
      const coll = total / lev;
      const fee = params ? d.legs.reduce((a, l) => a + legSize(d, l.w, size) * params[l.mkt].orderFeeFactor, 0) : 0;
      const feeRate = total ? (fee / total) * 100 : 0;

      let pnl: number | null = isOpen ? 0 : null, collUsed = 0;
      const recLegSize = (l: (typeof d.legs)[number]) =>
        rec?.legs.find((x) => x.mkt === l.mkt && x.isLong === l.dir * (long ? 1 : -1) > 0)?.sizeUsd;
      const legs = d.legs.map((l) => {
        const m = MARKETS[l.mkt], am = APP_MARKETS[l.mkt], dir = l.dir * (long ? 1 : -1), ls = recLegSize(l) ?? legSize(d, l.w, size), mark = P[l.mkt] ?? null;
        const recLeg = rec?.legs.find((x) => x.mkt === l.mkt && x.isLong === dir > 0);
        const pos = recLeg ? s.positions[legKey(l.mkt, recLeg.isLong)] : undefined;
        let entry = mark, lp: number | null = null, legColl = ls / lev;
        if (isOpen) {
          entry = pos ? positionEntryPrice(pos, am.indexDecimals) : null;
          if (pos && recLeg) {
            const share = Math.min(1, usdUnits(recLeg.sizeUsd) >= pos.sizeUsd ? 1 : recLeg.sizeUsd / unitsToUsd(pos.sizeUsd));
            legColl = (Number(pos.collateralAmount) / 1e6) * share;
            collUsed += legColl;
            if (mark !== null && entry) lp = dir * (mark - entry) * (recLeg.sizeUsd / entry);
          }
          if (lp === null) pnl = null; else if (pnl !== null) pnl += lp;
        }
        const liq = entry ? (dir > 0 ? entry * (1 - 0.9 / lev) : entry * (1 + 0.9 / lev)) : null;
        const legMax = params ? Math.floor(params[l.mkt].maxLeverage) : null;
        return {
          sym: m.sym, sideLabel: dir > 0 ? "Long" : "Short", sideColor: dir > 0 ? UP : DN, w: Math.round(l.w * 100) + "%",
          sizeFmt: "$" + n2(ls, ls < 100 ? 2 : 0), collFmt: n2(legColl), entryFmt: entry ? n2(entry, m.dp) : "—",
          liqFmt: size && liq ? n2(liq, m.dp) : "—",
          lastFmt: isOpen ? (lp === null ? "—" : usd(lp)) : legMax ? n2(legMax, 0) + "×" : "—",
          lastColor: isOpen ? (lp === null ? "#a4aca9" : lp >= 0 ? UP : DN) : "#a4aca9",
        };
      });
      if (isOpen) {
        used += collUsed;
        if (pnl === null) pnlKnown = false; else totalPnl += pnl;
      }

      // Validation against on-chain limits.
      const minColl = params ? Math.max(...d.legs.map((l) => params[l.mkt].minCollateralUsd)) * MIN_COLLATERAL_MARGIN : 0;
      // Smallest typed size that gives every leg enough collateral.
      const minSize = Math.ceil(Math.max(...d.legs.map((l) => (minColl * lev) / legSize(d, l.w, 1))) * 100) / 100;
      const solNeeded = SOL_PER_LEG * d.legs.length;

      // Orders on a closed market get cancelled by the keeper, so block them up front.
      const closedLegs = d.legs.filter((l) => s.marketOpen[l.mkt] === false).map((l) => MARKETS[l.mkt].sym);
      const closedLabel = `Market closed · ${closedLegs.join(", ")}`;

      let cta: string, ok = false, act: () => void;
      if (isOpen) {
        if (busy) cta = busy;
        else if (closedLegs.length) cta = closedLabel;
        else { cta = "Close strategy"; ok = true; }
        act = () => { if (ok && !anyBusy) this.closeStrategy(d, rec, pnl); };
      } else {
        if (!connected) cta = s.connecting ? "Connecting…" : "Connect wallet";
        else if (busy) cta = busy;
        else if (!params || !s.balances) cta = "Loading…";
        else if (closedLegs.length) cta = closedLabel;
        else if (size < minSize) cta = `Min size $${n2(minSize)}`;
        else if (coll + fee > s.balances.usdc) cta = "Insufficient USDC";
        else if (s.balances.sol < solNeeded) cta = `Need ~${solNeeded} SOL for fees`;
        else { cta = `Open ${long ? "Long" : "Short"} · ${d.legs.length} legs`; ok = !anyBusy; }
        act = () => { if (!connected) return void this.connect(); if (ok) this.openStrategy(d, side, size, lev); };
      }
      const live = ok || (!isOpen && !connected);
      const presets = max ? [2, 5, 10, 25].filter((x) => x < max).concat([max]).map((x) => {
        const on = Math.abs(lev - x) < 0.05;
        return { label: x === max ? "Max" : x + "×", onPick: () => this.setIn(d.id, { lev: x }), bd: on ? ACC : "#262b2e", fg: on ? ACC : "#a4aca9" };
      }) : [];
      const sliderMax = max || 2;
      return {
        id: d.id, name: d.name, desc: d.desc, expanded: exp, isOpen, isDraft: !isOpen, legs, presets, rot: exp ? 180 : 0, rowBg: exp ? "#111517" : "transparent",
        onToggle: () => this.setState((x) => ({ expanded: { ...x.expanded, [d.id]: !x.expanded[d.id] } })),
        chips: d.legs.map((l) => { const dir = l.dir * (long ? 1 : -1); return { side: dir > 0 ? "L" : "S", color: dir > 0 ? UP : DN, sym: l.mkt, w: Math.round(l.w * 100) + "%" }; }),
        maxFmt: max ? max + "×" : "—", rowSize: isOpen ? "$" + n2(total, total < 100 ? 2 : 0) : "—", rowColl: isOpen ? n2(collUsed) : "—", valColor: isOpen ? "#eef1f0" : "#5d6764",
        pnlFmt: isOpen && pnl !== null ? usd(pnl) : "—", pnlColor: isOpen && pnl !== null ? (pnl >= 0 ? UP : DN) : "#5d6764",
        status: busy ? "Pending" : isOpen ? "Open" : "—",
        statusBg: busy ? "oklch(0.82 0.14 85 / 0.14)" : isOpen ? "oklch(0.78 0.16 155 / 0.14)" : "transparent",
        statusFg: busy ? "oklch(0.85 0.14 85)" : isOpen ? UP : "#5d6764",
        size: inp.size, levFmt: fmtLev(lev), levSlider: Math.round((1000 * Math.log(lev / 1.1)) / Math.log(sliderMax / 1.1)),
        onSize: (e: ChangeEvent<HTMLInputElement>) => { const raw = e.target.value.replace(/[^0-9.]/g, ""); const [a, dd] = raw.split("."); const f = a ? Number(a).toLocaleString("en-US") : ""; this.setIn(d.id, { size: dd !== undefined ? f + "." + dd.slice(0, 2) : f }); },
        onLev: (e: ChangeEvent<HTMLInputElement>) => { const raw = 1.1 * Math.pow(sliderMax / 1.1, +e.target.value / 1000); this.setIn(d.id, { lev: Math.min(sliderMax, Math.max(1.1, raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw))) }); },
        longBg: long ? UP : "transparent", longFg: long ? "#0b0d0e" : "#7d8784", shortBg: long ? "transparent" : DN, shortFg: long ? "#7d8784" : "#0b0d0e",
        setLong: () => this.setIn(d.id, { side: "long" }), setShort: () => this.setIn(d.id, { side: "short" }),
        colEntry: isOpen ? "Entry" : "Price", colLiq: "Est. liq.", colLast: isOpen ? "PnL" : "Max lev.",
        collFmt: n2(isOpen ? collUsed : coll), feeLabel: `${isOpen ? "Close" : "Open"} fee · ${n2(feeRate, 3)}%`, feeFmt: "$" + n2(fee, fee < 1 ? 4 : 2),
        ctaLabel: cta, onCta: act, ctaBg: isOpen ? "transparent" : live ? ACC : "#1d2124", ctaFg: isOpen ? "#eef1f0" : live ? "#0b0d0e" : "#5d6764", ctaBd: isOpen ? "1px solid #2f3538" : "none",
      };
    });
    return {
      strategies, connected, disconnected: !connected, connectLabel: s.connecting ? "Connecting…" : "Connect wallet",
      addr: s.owner ? short(s.owner) : "", availFmt: s.balances ? n2(s.balances.usdc) : "—", usedFmt: n2(used) + " USDC",
      openCount: String(Object.keys(s.open).length),
      totalPnlFmt: pnlKnown ? usd(totalPnl) : "—", totalPnlColor: !pnlKnown ? "#5d6764" : totalPnl >= 0 ? UP : DN,
      hasToast: !!s.toast, toast: s.toast, error: s.error,
    };
  }

  render() {
    const v = this.renderVals();
    const grid = "display:grid;grid-template-columns:minmax(0,2.6fr) minmax(0,.8fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 72px 20px;gap:16px";
    const legGrid = "display:grid;grid-template-columns:1.3fr .7fr .7fr 1fr 1fr 1fr 1fr 1fr;gap:10px";
    return (
      <div style={css("min-height:100vh;background:#0b0d0e;color:#eef1f0;position:relative")}>
        <div style={css("display:flex;align-items:center;justify-content:space-between;gap:16px;height:64px;padding:0 24px;border-bottom:1px solid #1d2124")}>
          <div style={css("display:flex;align-items:center;gap:9px;font-weight:600;font-size:17px;letter-spacing:-0.02em")}><div style={css("width:16px;height:16px;border-radius:4px;background:oklch(0.82 0.14 165)")} />Tilt</div>
          <div style={css("display:flex;align-items:center;gap:10px")}>
            <div style={css("display:flex;align-items:center;gap:7px;height:36px;padding:0 12px;border:1px solid #22272a;border-radius:9px;font-size:13px;color:#a4aca9")}><div style={css("width:7px;height:7px;border-radius:50%;background:oklch(0.78 0.16 155)")} />Solana</div>
            {v.connected && (
              <button onClick={this.connect} title="Disconnect" style={css("display:flex;align-items:center;gap:10px;height:36px;padding:0 14px;background:#151819;border:1px solid #22272a;border-radius:9px;color:#eef1f0;font:500 13px Geist,sans-serif;cursor:pointer")}><span style={css("font-family:'Geist Mono',monospace;color:#a4aca9")}>{v.availFmt} USDC</span><span>{v.addr}</span></button>
            )}
            {v.disconnected && (
              <button onClick={this.connect} style={css("height:36px;padding:0 16px;background:#eef1f0;border:none;border-radius:9px;color:#0b0d0e;font:600 13px Geist,sans-serif;cursor:pointer")}>{v.connectLabel}</button>
            )}
          </div>
        </div>

        <div style={css("max-width:1080px;margin:0 auto;padding:40px 24px 80px;display:flex;flex-direction:column;gap:24px")}>
          <div style={css("display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap")}>
            <div style={css("display:flex;flex-direction:column;gap:8px")}>
              <h1 style={css("margin:0;font-size:30px;font-weight:600;letter-spacing:-0.03em")}>Strategies</h1>
              <div style={css("font-size:14px;color:#7d8784")}>Multi-leg perp strategies on GMTrade. Size is per leg — weighted legs scale from the largest one.</div>
            </div>
            <div style={css("display:flex;gap:28px;font-size:12px;color:#7d8784")}>
              <div style={css("display:flex;flex-direction:column;gap:4px")}>Open<span style={css("font:500 15px 'Geist Mono',monospace;color:#eef1f0")}>{v.openCount}</span></div>
              <div style={css("display:flex;flex-direction:column;gap:4px")}>Collateral in use<span style={css("font:500 15px 'Geist Mono',monospace;color:#eef1f0")}>{v.usedFmt}</span></div>
              <div style={css("display:flex;flex-direction:column;gap:4px")}>Unrealized PnL<span style={css(`font:500 15px 'Geist Mono',monospace;color:${v.totalPnlColor}`)}>{v.totalPnlFmt}</span></div>
            </div>
          </div>

          {v.error && <div style={css("padding:12px 16px;border:1px solid oklch(0.7 0.18 25 / 0.4);border-radius:10px;color:oklch(0.8 0.12 25);font-size:13px")}>{v.error}</div>}

          <div style={css("display:flex;flex-direction:column;border:1px solid #1d2124;border-radius:14px;background:#0f1213;overflow:hidden")}>
            <div style={css(`${grid};padding:12px 20px;font-size:12px;color:#7d8784;border-bottom:1px solid #1d2124`)}>
              <span>Strategy</span><span>Max lev.</span><span>Size</span><span>Collateral</span><span>PnL</span><span>Status</span><span />
            </div>

            {v.strategies.map((st) => (
              <div key={st.id} style={css(`display:flex;flex-direction:column;border-bottom:1px solid #1d2124;background:${st.rowBg}`)}>
                <div onClick={st.onToggle} style={css(`${grid};align-items:center;padding:18px 20px;cursor:pointer`)}>
                  <div style={css("display:flex;flex-direction:column;gap:8px;min-width:0")}>
                    <span style={css("font-size:15px;font-weight:600;letter-spacing:-0.01em")}>{st.name}</span>
                    <div style={css("display:flex;gap:6px;flex-wrap:wrap")}>
                      {st.chips.map((c) => (
                        <span key={c.sym} style={css("display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;background:#151819;font:500 12px 'Geist Mono',monospace;color:#cfd5d3")}><span style={css(`color:${c.color}`)}>{c.side}</span>{c.sym}<span style={css("color:#7d8784")}>{c.w}</span></span>
                      ))}
                    </div>
                  </div>
                  <span style={css("font:500 14px 'Geist Mono',monospace;color:#a4aca9")}>{st.maxFmt}</span>
                  <span style={css(`font:500 14px 'Geist Mono',monospace;color:${st.valColor}`)}>{st.rowSize}</span>
                  <span style={css(`font:500 14px 'Geist Mono',monospace;color:${st.valColor}`)}>{st.rowColl}</span>
                  <span style={css(`font:500 14px 'Geist Mono',monospace;color:${st.pnlColor}`)}>{st.pnlFmt}</span>
                  <span style={css(`justify-self:start;padding:4px 9px;border-radius:6px;font-size:12px;font-weight:500;background:${st.statusBg};color:${st.statusFg}`)}>{st.status}</span>
                  <span style={css(`display:flex;justify-content:center;color:#7d8784;font-size:12px;transform:rotate(${st.rot}deg);transition:transform .15s`)}>▾</span>
                </div>

                {st.expanded && (
                  <div style={css("display:flex;flex-direction:column;gap:18px;padding:0 20px 22px")}>
                    <div style={css("font-size:13px;line-height:1.5;color:#a4aca9;max-width:640px;text-wrap:pretty")}>{st.desc}</div>

                    {st.isDraft && (
                      <div style={css("display:flex;flex-wrap:wrap;align-items:flex-start;gap:18px;padding:16px;border:1px solid #1d2124;border-radius:12px;background:#0b0d0e")}>
                        <div style={css("flex:0 1 170px;display:flex;flex-direction:column;gap:8px")}>
                          <span style={css("font-size:12px;color:#7d8784")}>Direction</span>
                          <div style={css("display:grid;grid-template-columns:1fr 1fr;gap:3px;height:46px;padding:3px;box-sizing:border-box;background:#151819;border-radius:10px")}>
                            <button onClick={st.setLong} style={css(`border:none;border-radius:7px;background:${st.longBg};color:${st.longFg};font:600 13px Geist,sans-serif;cursor:pointer`)}>Long</button>
                            <button onClick={st.setShort} style={css(`border:none;border-radius:7px;background:${st.shortBg};color:${st.shortFg};font:600 13px Geist,sans-serif;cursor:pointer`)}>Short</button>
                          </div>
                        </div>
                        <div style={css("flex:1 1 200px;display:flex;flex-direction:column;gap:8px")}>
                          <span style={css("font-size:12px;color:#7d8784")}>Size per leg</span>
                          <div style={css("display:flex;align-items:center;gap:6px;height:46px;padding:0 12px;box-sizing:border-box;border:1px solid #262b2e;border-radius:10px;background:#0f1213")}><span style={css("font:500 17px 'Geist Mono',monospace;color:#5d6764")}>$</span><input value={st.size} onChange={st.onSize} inputMode="decimal" style={css("flex:1;min-width:0;background:none;border:none;outline:none;font:500 17px 'Geist Mono',monospace")} /><span style={css("font-size:12px;color:#7d8784")}>USD</span></div>
                        </div>
                        <div style={css("flex:2 1 300px;display:flex;flex-direction:column;gap:8px")}>
                          <div style={css("display:flex;justify-content:space-between;font-size:12px;color:#7d8784")}><span>Leverage</span><span style={css("font:600 15px 'Geist Mono',monospace;color:#eef1f0")}>{st.levFmt}</span></div>
                          <div style={css("display:flex;align-items:center;height:22px")}><input type="range" min="0" max="1000" step="1" value={st.levSlider} onChange={st.onLev} style={css("width:100%;margin:0;accent-color:oklch(0.82 0.14 165)")} /></div>
                          <div style={css("display:flex;gap:6px")}>
                            {st.presets.map((pr) => (
                              <button key={pr.label} onClick={pr.onPick} style={css(`flex:1;height:26px;border:1px solid ${pr.bd};border-radius:7px;background:none;color:${pr.fg};font:500 12px 'Geist Mono',monospace;cursor:pointer`)}>{pr.label}</button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    <div style={css("display:flex;flex-direction:column;border:1px solid #1d2124;border-radius:12px;overflow:hidden")}>
                      <div style={css(`${legGrid};padding:10px 14px;font-size:12px;color:#7d8784;background:#0b0d0e`)}><span>Leg</span><span>Side</span><span>Weight</span><span>Size</span><span>Collateral</span><span>{st.colEntry}</span><span>{st.colLiq}</span><span>{st.colLast}</span></div>
                      {st.legs.map((lg) => (
                        <div key={lg.sym} style={css(`${legGrid};align-items:center;padding:12px 14px;border-top:1px solid #16191b;font:400 13px 'Geist Mono',monospace`)}>
                          <span style={css("font-family:Geist,sans-serif;font-weight:500")}>{lg.sym}</span>
                          <span style={css(`color:${lg.sideColor}`)}>{lg.sideLabel}</span>
                          <span style={css("color:#a4aca9")}>{lg.w}</span>
                          <span>{lg.sizeFmt}</span><span>{lg.collFmt}</span><span>{lg.entryFmt}</span><span style={css("color:#a4aca9")}>{lg.liqFmt}</span>
                          <span style={css(`color:${lg.lastColor}`)}>{lg.lastFmt}</span>
                        </div>
                      ))}
                    </div>

                    <div style={css("display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap")}>
                      <div style={css("display:flex;gap:28px;flex-wrap:wrap;font-size:12px;color:#7d8784")}>
                        <div style={css("display:flex;flex-direction:column;gap:4px")}>Collateral · size ÷ leverage<span style={css("font:600 18px 'Geist Mono',monospace;color:#eef1f0")}>{st.collFmt} <span style={css("font-size:12px;color:#7d8784")}>USDC</span></span></div>
                        <div style={css("display:flex;flex-direction:column;gap:4px")}>{st.feeLabel}<span style={css("font:500 15px 'Geist Mono',monospace;color:#cfd5d3")}>{st.feeFmt}</span></div>
                      </div>
                      <button onClick={st.onCta} style={css(`height:46px;min-width:200px;padding:0 22px;border:${st.ctaBd};border-radius:11px;background:${st.ctaBg};color:${st.ctaFg};font:600 14px Geist,sans-serif;cursor:pointer`)}>{st.ctaLabel}</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {v.hasToast && <div style={css("position:fixed;right:24px;bottom:24px;z-index:20;max-width:420px;padding:12px 16px;border-radius:10px;background:#eef1f0;color:#0b0d0e;font-size:13px;font-weight:500;box-shadow:0 10px 30px rgba(0,0,0,.4)")}>{v.toast}</div>}
      </div>
    );
  }
}
