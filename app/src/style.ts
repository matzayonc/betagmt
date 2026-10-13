import type { CSSProperties } from "react";

// Inline style strings from the design → React style objects (cached).
const styleCache = new Map<string, CSSProperties>();
export function css(s: string): CSSProperties {
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
