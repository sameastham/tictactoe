package mx.espanolcoach.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.webkit.JavascriptInterface
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
        // over web content gets intercepted (e.g. text selection).
        bridge.webView.setOnLongClickListener {
            openTunnelSetup()
            true
        }

        if (TunnelManager.isEnabled(this) && TunnelManager.isConfigured(this)) {
            installRetryJsBridge()
            showFallback(state = "connecting")
            observeTunnel()
            TunnelManager.connect(this)
        }
        // else: tunnel disabled or unconfigured — leave Capacitor's own
        // static-server.url load (and its built-in errorPath fallback)
        // alone; the "Túnel" affordance above is still how the user gets
        // to TunnelSetupActivity to configure it the first time.
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
     * The fallback page's "Reintentar" button normally just does
     * `location.reload()`, which is enough in the no-tunnel case (it
     * re-attempts the static `server.url`). In tunnel mode a plain reload
     * of a `file://` asset wouldn't re-invoke [TunnelManager.connect] on
     * its own, so the page also checks for this JS interface and calls
     * `retry()` on it instead when present. This — rather than relaunching
     * the whole Activity — is the simplest robust way to make "reload"
     * actually retrigger a reconnect attempt: no Activity recreation, no
     * extra Intent plumbing, and it degrades safely (plain reload) for
     * anyone loading the fallback page without this interface installed.
     */
    private fun installRetryJsBridge() {
        bridge.webView.addJavascriptInterface(RetryJsInterface(), "AndroidTunnel")
    }

    inner class RetryJsInterface {
        @JavascriptInterface
        fun retry() {
            TunnelManager.connect(this@MainActivity)
        }
    }

    private fun openTunnelSetup() {
        startActivity(Intent(this, TunnelSetupActivity::class.java))
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_ID_TUNNEL_SETTINGS, 0, "Túnel")
        return super.onCreateOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == MENU_ID_TUNNEL_SETTINGS) {
            openTunnelSetup()
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }
}
