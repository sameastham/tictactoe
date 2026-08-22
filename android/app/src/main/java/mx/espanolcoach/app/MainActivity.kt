package mx.espanolcoach.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.webkit.JavascriptInterface
import androidx.appcompat.app.AlertDialog
import com.getcapacitor.BridgeActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Thin WebView shell for Español Coach.
 *
 * With tunnel mode off (the default/original behavior), this class does
 * nothing extra: Capacitor's BridgeActivity loads the static `server.url`
 * baked in at `npx cap sync android` time (capacitor.config.ts) and falls
 * back to the bundled offline page (capacitor-web/index.html) on its own if
 * that's unreachable.
 *
 * With the embedded-Tailscale tunnel (TunnelManager) configured and
 * enabled, this activity instead:
 *  1. immediately shows the bundled fallback page as a "Conectando…" screen
 *     — overriding whatever Capacitor's own static-`server.url` attempt is
 *     doing, since that URL is not expected to be reachable without the
 *     tunnel;
 *  2. collects [TunnelManager.state];
 *  3. on `Up(baseUrl)`, loads the WebView at baseUrl on the main thread —
 *     the ONLY moment the WebView is pointed at the real app;
 *  4. on `Failed`, re-shows the fallback page in its error state.
 *
 * The connect flow always waits for `Up` before loading any app URL — the
 * stale static `server.url` baked into the build is never dialed while the
 * tunnel is enabled.
 *
 * The tunnel state collector ([observeTunnel]) is always active, not just in
 * the tunnel-enabled branch above — so that a connect triggered from
 * elsewhere (TunnelSetupActivity's "Guardar y conectar", reached via the
 * first-launch chooser or the fallback page's "Configurar túnel" button)
 * also lands its `Up(baseUrl)` here and loads the WebView, even though this
 * activity's own `onCreate` took the "leave the static URL alone" path.
 *
 * First-launch UX: a genuinely fresh install (tunnel off, nothing
 * configured) would otherwise silently attempt the static `server.url`,
 * fail, and land on the offline fallback page with no visible way to
 * discover the embedded-tunnel option other than an undiscoverable
 * long-press. [FirstLaunchChooser] decides when that's the case; when it is,
 * `onCreate` shows a one-time native dialog ("¿Cómo te conectas al
 * servidor?") instead of silently falling through. See
 * [TunnelManager.hasMadeFirstLaunchChoice] for how "one-time" is enforced.
 */
class MainActivity : BridgeActivity() {
    private val uiScope = CoroutineScope(Dispatchers.Main + Job())

    companion object {
        private const val FALLBACK_URL = "file:///android_asset/public/index.html"
        private const val MENU_ID_TUNNEL_SETTINGS = 1
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // "Túnel" affordance: always available, even before the tunnel is
        // configured, so a first-time setup doesn't need any other entry
        // point. A long-press on the WebView is the simplest option that
        // doesn't require adding a visible toolbar/action bar to an
        // otherwise chrome-less WebView shell; the standard options menu
        // (reachable via a hardware/software menu key where the device has
        // one) is wired up as a second path for devices where a long-press
        // over web content gets intercepted (e.g. text selection). Neither
        // of these auto-returns to the app on connect — see
        // [openTunnelSetup]'s `autoFinishOnConnect` doc.
        bridge.webView.setOnLongClickListener {
            openTunnelSetup(autoFinishOnConnect = false)
            true
        }

        // Installed unconditionally (not just once tunnel mode is on) so the
        // fallback page's "Configurar túnel" button works even on the very
        // first offline error a fresh install hits, before anything tunnel
        // related has ever been configured. Same for the state collector:
        // it needs to be live so a connect kicked off from
        // TunnelSetupActivity (reached via the chooser below, or that
        // button) still lands its result here. See the class doc comment.
        installTunnelJsBridge()
        observeTunnel()

        when (
            FirstLaunchChooser.decide(
                tunnelEnabled = TunnelManager.isEnabled(this),
                tunnelConfigured = TunnelManager.isConfigured(this),
                choiceMade = TunnelManager.hasMadeFirstLaunchChoice(this),
            )
        ) {
            FirstLaunchChooser.Action.AUTO_CONNECT_TUNNEL -> {
                showFallback(state = "connecting")
                TunnelManager.connect(this)
            }
            FirstLaunchChooser.Action.SHOW_CHOOSER -> showFirstLaunchChooser()
            FirstLaunchChooser.Action.PROCEED_STATIC -> Unit
            // tunnel disabled/unconfigured and either already asked once, or
            // not a fresh install (e.g. was configured, then turned off) —
            // leave Capacitor's own static-server.url load (and its
            // built-in errorPath fallback) alone; the "Túnel" affordance
            // above and the fallback page's button are still how the user
            // gets to TunnelSetupActivity.
        }
    }

    /**
     * The one-time "¿Cómo te conectas al servidor?" dialog a fresh install
     * sees instead of silently attempting (and failing into an unexplained
     * error page from) the static `server.url`. Not cancelable — it's two
     * clear options, either of which is a valid and permanent-enough choice
     * (the direct option can always be revisited later via the "Túnel"
     * affordance), so there's no good "cancel" behavior to fall back to.
     */
    private fun showFirstLaunchChooser() {
        AlertDialog.Builder(this)
            .setTitle("¿Cómo te conectas al servidor?")
            .setCancelable(false)
            .setPositiveButton("Configurar túnel Tailscale (recomendado)") { _, _ ->
                TunnelManager.markFirstLaunchChoiceMade(this)
                openTunnelSetup(autoFinishOnConnect = true)
            }
            .setNegativeButton("Ya tengo Tailscale instalado — conectar directo") { _, _ ->
                TunnelManager.markFirstLaunchChoiceMade(this)
                // Nothing else to do: Capacitor's own static-server.url load
                // (kicked off by super.onCreate() above, same as always) and
                // its built-in errorPath fallback proceed untouched.
            }
            .show()
    }

    private fun observeTunnel() {
        uiScope.launch {
            TunnelManager.state.collect { state ->
                when (state) {
                    is TunnelState.Up -> loadApp(state.baseUrl)
                    is TunnelState.Failed -> showFallback(state = "error", message = state.message)
                    TunnelState.Connecting -> showFallback(state = "connecting")
                    TunnelState.Idle -> Unit // nothing to show until connect() runs
                }
            }
        }
    }

    private fun loadApp(baseUrl: String) {
        runOnUiThread { bridge.webView.loadUrl(baseUrl) }
    }

    private fun showFallback(state: String, message: String? = null) {
        val url = buildString {
            append(FALLBACK_URL)
            append("?state=").append(state)
            if (!message.isNullOrBlank()) {
                append("&message=").append(Uri.encode(message))
            }
        }
        runOnUiThread { bridge.webView.loadUrl(url) }
    }

    /**
     * Two JS-reachable entry points for the bundled fallback page
     * (`capacitor-web/index.html`), installed unconditionally (see
     * `onCreate`'s comment) so both work from the very first offline error a
     * fresh install can hit, before anything tunnel-related exists yet:
     *
     *  - `retry()`: the "Reintentar" button normally just does
     *    `location.reload()`, which is enough in the no-tunnel case (it
     *    re-attempts the static `server.url`). In tunnel mode a plain reload
     *    of a `file://` asset wouldn't re-invoke [TunnelManager.connect] on
     *    its own, so the page calls this instead when the tunnel attempt
     *    itself is what needs retrying. Degrades safely (plain reload) for
     *    anyone loading the fallback page without this interface installed.
     *  - `openSetup()`: the "Configurar túnel" button — opens
     *    TunnelSetupActivity so a first-time user who's hit the error page
     *    has a visible, one-tap path to it instead of needing to discover
     *    the long-press affordance.
     */
    private fun installTunnelJsBridge() {
        bridge.webView.addJavascriptInterface(TunnelJsInterface(), "AndroidTunnel")
    }

    inner class TunnelJsInterface {
        @JavascriptInterface
        fun retry() {
            TunnelManager.connect(this@MainActivity)
        }

        @JavascriptInterface
        fun openSetup() {
            // JS interface callbacks run on a WebView background thread, not
            // the UI thread — startActivity should be dispatched to the main
            // thread rather than called directly from here.
            runOnUiThread { openTunnelSetup(autoFinishOnConnect = true) }
        }
    }

    /**
     * @param autoFinishOnConnect When true, TunnelSetupActivity finishes
     *   itself back to this activity the moment the tunnel reaches
     *   `TunnelState.Up` (see TunnelSetupActivity), so a user who arrived via
     *   the first-launch chooser or the fallback page's error-recovery
     *   button lands straight in the app instead of on a settings screen
     *   they never asked to linger on. The manual "Túnel" entry points
     *   (long-press, options menu) pass false — someone who deliberately
     *   opened settings to review/edit them (or to hit "Borrar clave" after
     *   connecting, per the README) shouldn't get bounced out from under
     *   them the instant a connection succeeds.
     */
    private fun openTunnelSetup(autoFinishOnConnect: Boolean) {
        val intent = Intent(this, TunnelSetupActivity::class.java)
        intent.putExtra(TunnelSetupActivity.EXTRA_AUTO_FINISH_ON_CONNECT, autoFinishOnConnect)
        startActivity(intent)
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_ID_TUNNEL_SETTINGS, 0, "Túnel")
        return super.onCreateOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == MENU_ID_TUNNEL_SETTINGS) {
            openTunnelSetup(autoFinishOnConnect = false)
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }
}
