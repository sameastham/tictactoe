import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3/jsdom: native/DOM-shimming deps that must not be bundled.
  // tesseract.js: resolves its worker-thread script and WASM core relative
  // to its own package dir (`__dirname`-based) and dynamically `require()`s
  // tesseract.js-core — bundling breaks both. @napi-rs/canvas: native addon
  // (napi-rs, loads a platform .node binary) used by unpdf's
  // `renderPageAsImage` to rasterize PDF pages for OCR — see
  // src/server/pdf.ts. Verified under both `next dev` and `next build` +
  // `npm start`.
  serverExternalPackages: ["better-sqlite3", "jsdom", "tesseract.js", "@napi-rs/canvas"],
  // Next 16 serves /_next/* dev resources only to `localhost` by default and
  // 403s every other origin, which leaves pages stuck on their server-rendered
  // state (e.g. Read's "Preparando…") because the client bundle never loads.
  // The phone reaches `next dev` over Tailscale (README "Android app"), so the
  // MacBook's tailnet identities have to be allowed here, not just 127.0.0.1.
  allowedDevOrigins: [
    "127.0.0.1",
    "100.103.193.110", // this MacBook's Tailscale IP
    "sams-macbook-pro.tailec5b43.ts.net", // its MagicDNS name (what the APK bakes in)
  ],
};

export default nextConfig;
