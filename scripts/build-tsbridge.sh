#!/usr/bin/env bash
# Builds tsbridge/ (the in-process tsnet userspace Tailscale node + loopback
# forwarder, see tsbridge/CLAUDE.md-adjacent doc comments) into an Android
# .aar via `gomobile bind`, and drops it at android/app/libs/tsbridge.aar.
#
# The .aar is a BUILD ARTIFACT — android/app/libs/*.aar is gitignored. Only
# the tsbridge/ Go source is committed. Run this script any time tsbridge/
# changes, then `cd android && ./gradlew assembleDebug` picks the new .aar
# up automatically (android/app/build.gradle globs libs/*.aar).
#
# Idempotent: safe to re-run. It installs the Android NDK (via `sdkmanager`)
# and `gomobile`/`gobind` (via `go install`) only if they aren't already
# present, then always re-runs the actual `gomobile bind`.
#
# Env overrides:
#   ANDROID_HOME        Android SDK root. Default: /root/android-sdk (falls
#                        back to $ANDROID_SDK_ROOT, then the existing env).
#   NDK_VERSION          NDK package to install, sdkmanager-style version
#                        string. Default: 27.2.12479018 (NDK r27c) — the most
#                        recent NDK line that was, at time of writing, a
#                        settled non-rc release; check
#                        `sdkmanager --list` for anything newer.
#   TSBRIDGE_TARGETS     gomobile bind -target value. Default: android/arm64
#                        (arm64-only — the only ABI real Android hardware
#                        needs today). Set to "android" to build all 4 ABIs
#                        (arm64-v8a, armeabi-v7a, x86, x86_64) into one fat
#                        .aar instead — useful for the emulator, but note
#                        that a debug APK bundling all 4 ABIs balloons to
#                        roughly 146 MB (each ABI carries its own copy of
#                        the tailscale/wireguard/gvisor native code, which
#                        dominates the APK). For a release build, prefer
#                        Android App Bundle (.aab) with Play's automatic ABI
#                        splits, or build per-ABI APKs
#                        (`-target=android/arm64,android/arm` etc. and ship
#                        matching split APKs) instead of one fat arm64+arm+
#                        x86+x86_64 APK.
#   ANDROID_API_LEVEL    -androidapi value (native minSdk baked into the
#                        .aar's JNI libs). Default: 26, matching
#                        android/variables.gradle's minSdkVersion floor
#                        for this feature (Keystore AES-GCM usage in the
#                        Kotlin side also wants API 23+; 26 is what's
#                        actually requested here per the task spec).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TSBRIDGE_DIR="$REPO_ROOT/tsbridge"
OUT_AAR="$REPO_ROOT/android/app/libs/tsbridge.aar"

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/root/android-sdk}}"
export ANDROID_HOME
NDK_VERSION="${NDK_VERSION:-27.2.12479018}"
TSBRIDGE_TARGETS="${TSBRIDGE_TARGETS:-android/arm64}"
ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-26}"

SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
GOPATH_BIN="$(go env GOPATH)/bin"
export PATH="$GOPATH_BIN:$PATH"

log() { echo "[build-tsbridge] $*" >&2; }

retry_once() {
  # Retries a flaky download once, since the NDK/module downloads here are
  # large enough that a single transient network hiccup shouldn't fail the
  # whole build.
  if "$@"; then
    return 0
  fi
  log "command failed, retrying once: $*"
  "$@"
}

# ---------------------------------------------------------------------------
# 1. NDK (idempotent: skip install if the version dir already exists)
# ---------------------------------------------------------------------------
NDK_DIR="$ANDROID_HOME/ndk/$NDK_VERSION"
if [ -d "$NDK_DIR" ] && [ -x "$NDK_DIR/toolchains/llvm/prebuilt/linux-x86_64/bin/clang" ]; then
  log "NDK $NDK_VERSION already installed at $NDK_DIR"
else
  log "installing NDK $NDK_VERSION via sdkmanager (this is the ~600MB+ step, be patient)"
  retry_once "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "ndk;$NDK_VERSION"
fi
export ANDROID_NDK_HOME="$NDK_DIR"

# ---------------------------------------------------------------------------
# 2. gomobile / gobind (idempotent: skip install if already on GOPATH/bin)
# ---------------------------------------------------------------------------
if command -v gomobile >/dev/null 2>&1; then
  log "gomobile already installed: $(command -v gomobile)"
else
  log "installing golang.org/x/mobile/cmd/gomobile@latest"
  retry_once go install golang.org/x/mobile/cmd/gomobile@latest
fi
if command -v gobind >/dev/null 2>&1; then
  log "gobind already installed: $(command -v gobind)"
else
  log "installing golang.org/x/mobile/cmd/gobind@latest"
  retry_once go install golang.org/x/mobile/cmd/gobind@latest
fi

log "gomobile init (no-op / deprecated on current x/mobile, kept for older toolchains)"
gomobile init || true

# ---------------------------------------------------------------------------
# 3. gomobile bind
# ---------------------------------------------------------------------------
mkdir -p "$REPO_ROOT/android/app/libs"

log "gomobile bind -target=$TSBRIDGE_TARGETS -androidapi=$ANDROID_API_LEVEL -o $OUT_AAR (from $TSBRIDGE_DIR)"
(
  cd "$TSBRIDGE_DIR"
  retry_once gomobile bind \
    -target="$TSBRIDGE_TARGETS" \
    -androidapi "$ANDROID_API_LEVEL" \
    -o "$OUT_AAR" \
    .
)

log "done: $OUT_AAR ($(du -h "$OUT_AAR" | cut -f1))"
