import type { CapacitorConfig } from "@capacitor/cli";

// ---------------------------------------------------------------------------
// SERVER_URL — READ THIS BEFORE BUILDING THE APP
//
// This app is a thin WebView shell. It has no bundled UI (beyond the offline
// fallback page in capacitor-web/) — it points straight at the Next.js
// server running on the learner's MacBook and reaches it over Tailscale.
//
// You MUST set this to the MacBook's Tailscale MagicDNS name before building
// for a real device, e.g.:
//
//   http://mbp-2019.tailnet-name.ts.net:3000
//
// Find the exact name with `tailscale status` (or the Tailscale admin
// console) on the MacBook. Do NOT use a Tailscale IP (100.x.x.x) unless you
// know it's stable — MagicDNS names don't change when the device re-joins.
//
// This value is baked into the native app at `npx cap sync android` time —
// it is NOT read at runtime on the phone. Every time you change
// CAP_SERVER_URL (or edit the fallback default below), you must re-run:
//
//   npx cap sync android
//
// for the change to take effect in the built APK.
// ---------------------------------------------------------------------------
const SERVER_URL = process.env.CAP_SERVER_URL ?? "http://mbp.tailnet:3000";

const config: CapacitorConfig = {
  appId: "mx.espanolcoach.app",
  appName: "Español Coach",
  webDir: "capacitor-web",
  server: {
    url: SERVER_URL,
    // The tailnet serves plain HTTP (no public HTTPS origin to hang a cert
    // off of), so cleartext traffic must stay allowed. Never enable this for
    // an app that talks to the public internet.
    cleartext: true,
    // Shown (loaded from webDir, i.e. capacitor-web/) when the WebView can't
    // reach SERVER_URL — MacBook asleep, phone off the tailnet, wrong
    // hostname, etc. On Android this page has no access to Capacitor plugins.
    errorPath: "index.html",
  },
};

export default config;
