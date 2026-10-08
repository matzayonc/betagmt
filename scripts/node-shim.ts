// The SDK's wasm-bindgen glue (getrandom) detects Node via `process` and then calls
// `module.require("crypto")`, which doesn't exist in ESM. Provide it. Not needed in browsers.
import { createRequire } from "node:module";

(globalThis as { module?: unknown }).module ??= { require: createRequire(import.meta.url) };
