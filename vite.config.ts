import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig(({ mode }) => {
  // Server-side env (not exposed to the browser): the CLI's RPC_URL is reused for the dev proxy.
  const env = loadEnv(mode, "..", "");
  const rpc = env.RPC_URL || "https://api.mainnet-beta.solana.com";

  return {
    root: "app",
    // Relative asset URLs, so the build works under any path (e.g. GitHub Pages' /<repo>/).
    base: "./",
    // Read VITE_* vars from the project's .env. Only VITE_-prefixed vars reach the
    // browser bundle, so PRIVATE_KEY (used by the CLI) is never exposed.
    envDir: "..",
    plugins: [react(), wasm()],
    // @solana/web3.js expects Node's Buffer.
    resolve: { alias: { buffer: "buffer/" } },
    define: { "global": "globalThis" },
    build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
    esbuild: { target: "es2022" },
    optimizeDeps: { exclude: ["@gmsol-labs/gmsol-sdk"], include: ["buffer"] },
    server: {
      proxy: {
        // Public RPCs reject browser origins; in dev, relay through Vite (HTTP + websocket).
        "/rpc": {
          target: rpc,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/rpc/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (req) => req.removeHeader("origin"));
            proxy.on("proxyReqWs", (req) => req.removeHeader("origin"));
          },
        },
      },
    },
  };
});
