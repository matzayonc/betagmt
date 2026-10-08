import { Buffer } from "buffer";
// @solana/web3.js uses Buffer at runtime.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
