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
- Tailscale installed and signed in on both the MacBook and the phone.

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

## Note

`legacy/` holds this repository's previous, unrelated project: a tic-tac-toe game. It is kept for reference and is not part of the Español Coach app.
