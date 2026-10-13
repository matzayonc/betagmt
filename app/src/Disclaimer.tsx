import { Component } from "react";
import { css } from "./style";

/** Bump when the text changes materially, so everyone has to accept it again. */
const VERSION = "2026-10-13";
const KEY = "backdoor.disclaimer";

export function disclaimerAccepted(): boolean {
  try { return localStorage.getItem(KEY) === VERSION; } catch { return false; }
}
function storeAcceptance() {
  try { localStorage.setItem(KEY, VERSION); } catch { /* storage unavailable: asked again next visit */ }
}

const SECTIONS: [string, string][] = [
  ["Provided as is", "Backdoor is free, open-source software provided \"as is\" and \"as available\", without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, availability or security."],
  ["Not ready for production", "This is an experimental hobby project. It has not been audited, reviewed or tested for production use. It may contain bugs that build wrong transactions, open the wrong size, side or leverage, miscalculate prices, collateral, fees or PnL, or fail partway through a multi-step open or close and leave positions, deposits or swaps behind."],
  ["You may lose everything", "Leveraged perpetual futures are high-risk. Positions can be liquidated and you can lose all funds you commit, quickly. Swaps can incur slippage. Prices, funding and fees shown here may be stale, delayed or wrong. Past or displayed performance says nothing about future results."],
  ["No advice", "Nothing in this app is financial, investment, legal or tax advice, or a recommendation to buy, sell or hold anything. Strategy names and descriptions are illustrative only."],
  ["Third-party protocols", "Trades execute on third-party protocols and services, including GMTrade, Pacifica, Jupiter, ONyc, Solana RPC providers and your wallet. Backdoor is not affiliated with, endorsed by or responsible for any of them, and has no control over their contracts, order books, keepers, oracles, fees, outages, insolvency, freezes or withdrawal delays."],
  ["Non-custodial, your responsibility", "Backdoor never holds your funds or keys and cannot reverse, cancel or recover any transaction. You alone sign every transaction and message in your wallet, and you are responsible for reviewing it before you approve. Records of open strategies are kept only in your browser and may be lost."],
  ["No liability", "To the maximum extent permitted by applicable law, the author and contributors are not liable for any loss or damage of any kind, direct, indirect, incidental, special, consequential or punitive, including loss of funds, profits, data or opportunity, arising from or related to your use of, or inability to use, this software, however caused and under any theory of liability, even if advised of the possibility. You use it entirely at your own risk and agree to hold the author and contributors harmless from any claims arising from your use."],
  ["Your jurisdiction", "You are solely responsible for making sure that using this software and trading derivatives is legal where you live and for any taxes you owe. Do not use it if you are a resident of, or located in, a jurisdiction where it is prohibited, or if you are subject to sanctions."],
  ["Other terms", "The source code is licensed under the MIT License, which also disclaims all warranties and liability. If any part of this notice is held unenforceable, the rest remains in effect."],
];

interface Props {
  /** True when re-opened for reading after the notice was already accepted. */
  readOnly: boolean;
  onAccept: () => void;
  onClose: () => void;
}

export class Disclaimer extends Component<Props, { read: boolean; risk: boolean }> {
  state = { read: false, risk: false };

  accept = () => {
    if (!this.state.read || !this.state.risk) return;
    storeAcceptance();
    this.props.onAccept();
  };

  render() {
    const { readOnly, onClose } = this.props;
    const ok = this.state.read && this.state.risk;
    const check = "display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;color:#cfd5d3;cursor:pointer";
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="disclaimer-title" style={css("position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(5,6,7,.82);backdrop-filter:blur(4px)")}>
        <div style={css("width:100%;max-width:620px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;border:1px solid #22272a;border-radius:14px;background:#0f1213;box-shadow:0 20px 60px rgba(0,0,0,.5)")}>
          <div style={css("padding:22px 24px 14px;border-bottom:1px solid #1d2124")}>
            <h2 id="disclaimer-title" style={css("margin:0;font-size:20px;font-weight:600;letter-spacing:-0.02em")}>Before you continue</h2>
            <div style={css("margin-top:6px;font-size:13px;color:#7d8784")}>Experimental software. Read this in full — it limits what you can claim if something goes wrong.</div>
          </div>
          <div style={css("overflow-y:auto;padding:16px 24px;display:flex;flex-direction:column;gap:14px")}>
            {SECTIONS.map(([title, body]) => (
              <div key={title} style={css("display:flex;flex-direction:column;gap:4px")}>
                <span style={css("font-size:13px;font-weight:600;color:#eef1f0")}>{title}</span>
                <span style={css("font-size:13px;line-height:1.5;color:#a4aca9;text-wrap:pretty")}>{body}</span>
              </div>
            ))}
          </div>
          <div style={css("padding:16px 24px 20px;border-top:1px solid #1d2124;display:flex;flex-direction:column;gap:12px")}>
            {readOnly ? (
              <button onClick={onClose} style={css("align-self:flex-end;height:42px;padding:0 22px;border:1px solid #2f3538;border-radius:10px;background:none;color:#eef1f0;font:600 14px Geist,sans-serif;cursor:pointer")}>Close</button>
            ) : (
              <>
                <label style={css(check)}><input type="checkbox" checked={this.state.read} onChange={(e) => this.setState({ read: e.target.checked })} style={css("margin-top:2px;accent-color:oklch(0.82 0.14 165)")} />I have read and agree to this notice, and I am legally allowed to use this software where I am.</label>
                <label style={css(check)}><input type="checkbox" checked={this.state.risk} onChange={(e) => this.setState({ risk: e.target.checked })} style={css("margin-top:2px;accent-color:oklch(0.82 0.14 165)")} />I understand this software is not production-ready, that I can lose all funds I use with it, and that the author takes no responsibility for any loss.</label>
                <button onClick={this.accept} disabled={!ok} style={css(`align-self:flex-end;height:42px;padding:0 22px;border:none;border-radius:10px;background:${ok ? "oklch(0.82 0.14 165)" : "#1d2124"};color:${ok ? "#0b0d0e" : "#5d6764"};font:600 14px Geist,sans-serif`)}>Accept and continue</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
}
