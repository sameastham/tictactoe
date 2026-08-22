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
    // ---------------------------------------------------------------------
    // allowNavigation — fixes internal links opening the system browser
    // instead of navigating in-WebView (Android, tunnel mode).
    //
    // Capacitor's Bridge.launchIntent() (android BridgeWebViewClient's
    // shouldOverrideUrlLoading -> Bridge.launchIntent, in
    // node_modules/@capacitor/android/.../com/getcapacitor/Bridge.java)
    // treats a tapped link as external (fires an ACTION_VIEW intent to the
    // system browser) unless EITHER:
    //   (a) its host+scheme equal the app's fixed `appUrl` (this SERVER_URL,
    //       resolved once at Bridge-init time), OR
    //   (b) its host matches `server.allowNavigation` (parsed once into a
    //       HostMask — see util/HostMask.java — before the WebView loads
    //       anything).
    // `appUrl` is NEVER updated after Bridge init. In tunnel mode
    // (TunnelManager.kt), MainActivity later calls
    // `bridge.webView.loadUrl("http://127.0.0.1:<port>/")` directly — this
    // repoints the WebView but NOT Capacitor's own `appUrl`, which stays
    // SERVER_URL's host. So every relative link the Next.js app renders
    // (Leer content cards included) then resolves to 127.0.0.1, fails the
    // (a) equality check against the stale SERVER_URL host, and — absent
    // this entry — also fails (b), so it gets shipped out to the system
    // browser instead of navigating in-WebView. Listing the loopback host
    // here satisfies (b) directly.
    //
    // "localhost" is included alongside the literal "127.0.0.1" as a
    // harmless synonym/defensive alias — nothing in this codebase currently
    // dials the tunnel via that hostname (TunnelManager.doConnect always
    // returns the literal IP), but WebView/Android loopback resolution
    // quirks are cheap to hedge against and HostMask does per-label exact
    // matching (no implicit aliasing between the two forms).
    //
    // Deliberately NOT listed here: the tailnet host itself (e.g.
    // "*.ts.net" or SERVER_URL's own host). Static mode needs no entry —
    // path (a) above already keeps it in-app since the WebView is loaded
    // directly from `appUrl` (verified: when server.url is set, Bridge
    // derives `appUrl`'s scheme/host straight from that URL, not from
    // `androidScheme`, so there's no scheme/host mismatch to patch there).
    // A tailnet-host entry would only matter for a page loaded from
    // somewhere else (e.g. the 127.0.0.1 tunnel) that then linked back to
    // the tailnet host absolutely — nothing in src/ builds such an absolute
    // internal URL (grepped for NEXT_PUBLIC_*/process.env.*URL/window.location
    // assignment — none). And a literal "*.ts.net" mask would not even match
    // real Tailscale MagicDNS names anyway: HostMask.Simple requires the
    // mask and host to have the same number of dot-separated labels once the
    // mask has more than one part (util/HostMask.java), and MagicDNS names
    // are 4 labels (`device.tailnet-name.ts.net`) against "*.ts.net"'s 3 —
    // so it would silently never match. Shipping it would be a dead pattern
    // that fixes nothing while looking like coverage. If a future feature
    // needs the tunnel to see the tailnet host as in-app, add the *exact*
    // configured SERVER_URL host as a literal entry here instead of a guessed
    // wildcard.
    allowNavigation: ["127.0.0.1", "localhost"],
  },
};

export default config;
