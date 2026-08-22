package tsbridge

import "os"

// Prepare points the process at app-private cache/home directories before
// StartForward is ever called. On Android, tailscale.com's log-dir
// resolution (and various os.UserCacheDir/os.UserHomeDir lookups deeper in
// tsnet/wgengine) panics if XDG_CACHE_HOME, TMPDIR, and HOME aren't set,
// since the Android runtime doesn't populate the environment the way a
// normal Linux process does. Call this once, from Kotlin, before
// StartForward — e.g. Prepare(context.cacheDir, context.filesDir).
//
// It is harmless (and a no-op beyond the env vars + mkdir) to call on other
// platforms too, so tests and non-Android builds can call it unconditionally
// without a build-tag branch on the Kotlin side.
func Prepare(cacheDir, homeDir string) {
	_ = os.MkdirAll(cacheDir, 0o700)
	_ = os.MkdirAll(homeDir, 0o700)

	// XDG_CACHE_HOME: consulted by os.UserCacheDir and by tailscale's own
	// log-dir resolution (tailscale.com/paths) before falling back to
	// platform defaults that don't exist under the Android app sandbox.
	os.Setenv("XDG_CACHE_HOME", cacheDir)
	// TMPDIR: some dependencies (and Go's own os.TempDir on some platforms)
	// read this rather than assuming /tmp is writable.
	os.Setenv("TMPDIR", cacheDir)
	// HOME: os.UserHomeDir and anything that shells out to code expecting a
	// traditional $HOME.
	os.Setenv("HOME", homeDir)
}
