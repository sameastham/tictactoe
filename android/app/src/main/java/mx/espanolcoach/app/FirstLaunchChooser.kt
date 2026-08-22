package mx.espanolcoach.app

/**
 * Pure decision logic for what MainActivity should do about the tunnel on a
 * fresh `onCreate` — extracted out of Activity/TunnelManager plumbing so it's
 * unit-testable on the plain JVM (no Robolectric/instrumentation needed).
 *
 * Backstory: before this existed, a fresh install with tunnel mode off (the
 * default) silently fell through to Capacitor's own static-`server.url`
 * load, which — with no MacBook/Tailscale set up yet — fails straight into
 * the offline fallback page with no visible path to the embedded-tunnel
 * setup screen (TunnelSetupActivity) other than an undiscoverable long-press.
 * [decide] is the trigger for MainActivity's one-time "¿Cómo te conectas al
 * servidor?" chooser dialog that closes that gap; see MainActivity.kt for how
 * the three inputs are read and how each [Action] is acted on.
 */
object FirstLaunchChooser {
    enum class Action {
        /** Tunnel is on and fully configured — auto-connect through it, as before this feature. */
        AUTO_CONNECT_TUNNEL,

        /**
         * Nothing to auto-connect, but the user has already been asked (or a
         * prior session already left the tunnel half-configured) — leave
         * Capacitor's own static-`server.url` load alone, same as always.
         */
        PROCEED_STATIC,

        /** A genuinely fresh install: nothing configured, nothing chosen yet. Show the one-time chooser. */
        SHOW_CHOOSER,
    }

    /**
     * @param tunnelEnabled [TunnelManager.isEnabled]
     * @param tunnelConfigured [TunnelManager.isConfigured] (a hub address + a stored auth key)
     * @param choiceMade [TunnelManager.hasMadeFirstLaunchChoice] — set once the chooser has been
     *   answered (either option), so it truly only ever shows once per install.
     */
    fun decide(tunnelEnabled: Boolean, tunnelConfigured: Boolean, choiceMade: Boolean): Action = when {
        tunnelEnabled && tunnelConfigured -> Action.AUTO_CONNECT_TUNNEL
        !tunnelEnabled && !tunnelConfigured && !choiceMade -> Action.SHOW_CHOOSER
        else -> Action.PROCEED_STATIC
    }
}
