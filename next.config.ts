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
};

export default nextConfig;
