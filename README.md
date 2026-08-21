# Español Coach

A personal Mexican-Spanish B2→C1 trainer: it captures chunks (words, collocations, idioms) from real content you consume, prompts you to produce them yourself, judges your output against a naturalness ladder, and keeps an append-only event log of everything so your progress is fully auditable over time.

## Getting started

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run seed
npm run dev
```

## Listen surface: speech-to-text and URL ingestion

Dictation transcription (`src/server/stt/`) and YouTube/podcast URL ingestion
(`src/server/mediafetch/`) both run out of the same local Python venv, `.venv-stt/`, which isn't
checked in. Create it once and install both:

```bash
python3 -m venv .venv-stt
.venv-stt/bin/pip install faster-whisper
.venv-stt/bin/pip install yt-dlp
```

Neither is required for `npm run dev`/`npm test`/`npm run e2e` — those default to (or force, for
e2e) the deterministic `fixture` STT provider and never shell out to yt-dlp — but both are needed
for a real end-to-end Listen surface on the MacBook (see CLAUDE.md Sec.6: `faster-whisper`, not
`mlx-whisper`, since the deployment target has no Apple Silicon).

## Android app

The Android app is a thin [Capacitor](https://capacitorjs.com) WebView shell — it has no
bundled UI of its own beyond an offline fallback page. It points straight at the Next.js dev
server running on your MacBook (`npm run dev`) and reaches it over
[Tailscale](https://tailscale.com), so the phone and the MacBook must be on the same tailnet.

### Prerequisites

- [Android Studio](https://developer.android.com/studio) (recommended — bundles the Android SDK
  and JDK), **or** a standalone Android SDK (`cmdline-tools` + `platform-tools` +
  `platforms;android-36` + `build-tools;36.0.0`, matching `android/variables.gradle`) plus a JDK
  21.
- Tailscale installed and signed in on both the MacBook and the phone — **unless** you're using
  the embedded-tunnel mode below, in which case the phone needs no separate Tailscale app.
- Only if building the optional embedded-Tailscale tunnel (see below): Go 1.24+, and enough disk
  space for the Android NDK (~2 GB installed).

### Point it at your MacBook

The server URL is baked into the app at `npx cap sync android` time — the phone doesn't read it
at runtime, so you must re-sync after changing it. Either:

- set the `CAP_SERVER_URL` environment variable before syncing, e.g.
  ```bash
  CAP_SERVER_URL=http://your-mac-name.your-tailnet.ts.net:3000 npx cap sync android
  ```
- or edit the fallback default directly in `capacitor.config.ts` (`SERVER_URL`).

Find the exact Tailscale MagicDNS name with `tailscale status` on the MacBook (prefer the
`*.ts.net` hostname over a `100.x.x.x` IP — it doesn't change when the device reconnects).

### Build the APK

From `android/`:

- **Android Studio**: open the `android/` folder as a project and run/build from there (it will
  prompt to install any missing SDK components).
- **Command line**:
  ```bash
  cd android
  ./gradlew assembleDebug
  ```
  The debug APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

### Install on the phone

The APK is unsigned/debug, so it has to be sideloaded:

1. Copy `app-debug.apk` to the phone (e.g. `adb install app-debug.apk` over USB, or share it any
   other way).
2. On the phone, allow installing from the source you used (Settings → Apps → Special access →
   Install unknown apps).
3. Open the APK to install, then launch "Español Coach".

The app only works while the phone is on the same tailnet as the MacBook **and the MacBook is
awake and running `npm run dev`** — if it can't reach the server, it shows an offline page with a
"Reintentar" button.

### Embedded-Tailscale tunnel mode (no separate Tailscale app on the phone)

The steps above (a Tailscale MagicDNS hostname baked into `server.url`) require the phone to have
its own Tailscale app installed and signed in. As an alternative, the app can embed a userspace
Tailscale node directly (`tsbridge/`, a Go module using `tailscale.com/tsnet`, compiled to an
Android `.aar` by `scripts/build-tsbridge.sh`) and forward a `127.0.0.1` port to the MacBook over
it — the phone never needs the Tailscale app, and the MacBook stays off the public internet. This
is opt-in and additive: with no `.aar` present, or with tunnel mode left off, the app behaves
exactly as described above (the static `server.url` is the fallback either way).

**Build the tunnel into the APK:**

```bash
./scripts/build-tsbridge.sh   # produces android/app/libs/tsbridge.aar
cd android && ./gradlew assembleDebug
```

`android/app/libs/*.aar` is gitignored — it's a build artifact, not something to commit; only the
`tsbridge/` Go source is checked in. The script installs the Android NDK and `gomobile`/`gobind`
idempotently (skipping anything already present) the first time it runs. By default it builds
**arm64 only** (`TSBRIDGE_TARGETS=android/arm64`, real phone hardware); set
`TSBRIDGE_TARGETS=android` to build all 4 ABIs (arm64-v8a, armeabi-v7a, x86, x86_64) into one `.aar`
instead — useful for the emulator, but note that an all-ABI debug APK balloons to roughly 146 MB
(each ABI carries its own copy of the tailscale/wireguard/gvisor native code, which dominates the
APK). For a release build, prefer an Android App Bundle (`.aab`) with Play's automatic ABI splits,
or build and ship per-ABI APKs, rather than one fat multi-ABI APK.

Bundling `tsbridge.aar` raises the app's `minSdkVersion` floor to 26 (Android 8.0) — the `.aar`'s
own manifest declares that floor, and the manifest merger hard-fails the build otherwise. The app
still builds and runs fine with the `.aar` absent (`TsBridge.kt` binds to it reflectively at
runtime — see that file's doc comment — so its absence just makes tunnel mode unavailable, not a
build failure), but once it's present the whole app's floor moves with it.

**Create a Tailscale auth key for the phone**, at the [admin console's Keys
page](https://login.tailscale.com/admin/settings/keys) (or your Headscale equivalent):

- **Reusable: No** — this key is only for the phone's first login; once connected, `tsnet`'s own
  persisted node identity (stored under the app's private `filesDir/tsstate`) re-authenticates on
  every later launch, so the key doesn't need to be reused.
- **Ephemeral: No** — an ephemeral node is removed the moment it disconnects, which would mean
  re-authenticating (and needing a fresh key) every time the phone's Wi-Fi drops. This node should
  persist like any other tailnet device.
- **Pre-authorized: Yes** — so the phone doesn't sit in an "awaiting approval" state in the admin
  console after first connecting.
- **Tags: `tag:espanol-phone`** (or your own tag name) — lets you scope this device down with an
  ACL (below) instead of leaving it with default tailnet-wide access.
- **Short expiry** (e.g. 1 hour) — it's a one-time bootstrap credential; a short window limits the
  blast radius if it leaks in transit before you paste it into the app.

**Scope the tag with an ACL** so the phone can reach the MacBook's port 3000 and nothing else on
the tailnet. In the admin console's ACL editor (or your Headscale `acl.hujson`), something like:

```json
{
  "tagOwners": {
    "tag:espanol-phone": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:espanol-phone"],
      "dst": ["<hub-tailnet-ip-or-host>:3000"]
    }
  ]
}
```

Replace `<hub-tailnet-ip-or-host>` with the MacBook's Tailscale IP or MagicDNS name (`tailscale
status` on the MacBook).

**First-launch flow, on the phone:**

1. Install the APK (same sideload steps as above) and launch it.
2. Long-press anywhere on the app's screen (or use the "Túnel" item in the options menu, on
   devices with a menu key) to open the tunnel settings screen.
3. Paste the auth key, enter the MacBook's `host:port` (its Tailscale MagicDNS name or IP, plus
   `:3000`), and tap "Guardar y conectar". Leave hostname/Control URL on their defaults unless
   you're running Headscale (below).
4. The app shows "Conectando…" (the same offline fallback page, `capacitor-web/index.html`, now
   doubling as a connecting screen) while the embedded node joins the tailnet and dials the
   MacBook, then loads the real app once it's up.
5. Once connected, reopen the tunnel screen and tap "Borrar clave" to remove the stored auth key
   — the persisted node identity means it's no longer needed, so there's no reason to keep even
   the Keystore-encrypted copy around longer than necessary.

**Headscale**: set the "Control URL (Headscale)" field in the tunnel settings screen to your
Headscale server's URL (e.g. `https://headscale.example.com`) before connecting — this maps to
`tsnet.Server.ControlURL`. Leave it blank to use Tailscale's own coordination server.

**The static `server.url` path (the "Point it at your MacBook" section above) remains the
no-tunnel fallback** — turning tunnel mode off (the switch on the tunnel settings screen) falls
back to it immediately, unchanged.

**Troubleshooting** (the fallback/offline page covers three states — see its `?state=` query
param in `capacitor-web/index.html`):

- **"Conectando…"**, no hints, no Reintentar button: the tunnel is still joining the tailnet /
  dialing the MacBook. Normal during the first few seconds after connecting; if it never
  progresses, the auth key or hub `host:port` is likely wrong — reopen the tunnel settings screen
  (long-press) to check them.
- **"No se pudo conectar por el túnel: …"** with a message and tunnel-specific hints: the tsnet
  node came up but couldn't reach the hub, or the connect attempt failed outright. Tapping
  "Reintentar" here calls back into `TunnelManager.connect()` (via a JS interface,
  `AndroidTunnel.retry()` — see `MainActivity.kt`) rather than just reloading, so it actually
  retries the tsnet login/dial, not just the page.
- **"No se pudo conectar al servidor."** with the original MacBook/Tailscale hints: tunnel mode is
  off (or unconfigured) and the static `server.url` load failed — this is the original,
  pre-tunnel behavior, and "Reintentar" here is a plain page reload that re-attempts that URL.

## Note

`legacy/` holds this repository's previous, unrelated project: a tic-tac-toe game. It is kept for reference and is not part of the Español Coach app.
