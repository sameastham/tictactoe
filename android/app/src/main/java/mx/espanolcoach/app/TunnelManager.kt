package mx.espanolcoach.app

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Mirrors the tunnel's lifecycle for MainActivity/TunnelSetupActivity to observe. */
sealed class TunnelState {
    object Idle : TunnelState()
    object Connecting : TunnelState()
    data class Up(val baseUrl: String) : TunnelState()
    data class Failed(val message: String) : TunnelState()
}

/**
 * Singleton coordinating the embedded tsnet node: reads the saved tunnel
 * config + Keystore-decrypted auth key (TunnelKeyStore), brings the tsnet
 * node + loopback forwarder up through the reflective TsBridge wrapper, and
 * exposes the result as a [StateFlow] for the UI layer to collect.
 *
 * All persisted config (except the auth key itself, which lives in
 * TunnelKeyStore) is plain SharedPreferences — none of it is secret, it's
 * just where to dial and what name to present.
 */
object TunnelManager {
    private const val PREFS_NAME = "tsbridge_tunnel"
    private const val PREF_ENABLED = "enabled"
    private const val PREF_HUB_HOST_PORT = "hub_host_port"
    private const val PREF_HOSTNAME = "hostname"
    private const val PREF_CONTROL_URL = "control_url"

    const val DEFAULT_HOSTNAME = "espanol-coach-phone"

    // SupervisorJob so a failure in one connect() attempt can't poison
    // later ones; Main.immediate keeps state updates cheap to collect from
    // the UI thread without an extra dispatch hop.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _state = MutableStateFlow<TunnelState>(TunnelState.Idle)
    val state: StateFlow<TunnelState> = _state.asStateFlow()

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(PREF_ENABLED, false)

    /** Enough saved (a hub address + a stored auth key) to attempt a connection. */
    fun isConfigured(context: Context): Boolean =
        TunnelKeyStore.hasKey(context) && !hubHostPort(context).isNullOrBlank()

    fun hubHostPort(context: Context): String? = prefs(context).getString(PREF_HUB_HOST_PORT, null)

    fun hostname(context: Context): String =
        prefs(context).getString(PREF_HOSTNAME, DEFAULT_HOSTNAME) ?: DEFAULT_HOSTNAME

    fun controlUrl(context: Context): String = prefs(context).getString(PREF_CONTROL_URL, "") ?: ""

    /**
     * Persists tunnel config. [authKey], if non-blank, is written through to
     * TunnelKeyStore (Keystore-encrypted); pass blank to leave a
     * previously-saved key untouched (e.g. when the user is only editing
     * the hub address). Also marks the tunnel enabled.
     */
    fun saveConfig(
        context: Context,
        authKey: String?,
        hubHostPort: String,
        hostname: String,
        controlUrl: String,
    ) {
        if (!authKey.isNullOrBlank()) {
            TunnelKeyStore.save(context, authKey)
        }
        prefs(context).edit()
            .putBoolean(PREF_ENABLED, true)
            .putString(PREF_HUB_HOST_PORT, hubHostPort)
            .putString(PREF_HOSTNAME, hostname.ifBlank { DEFAULT_HOSTNAME })
            .putString(PREF_CONTROL_URL, controlUrl)
            .apply()
    }

    /** Toggles tunnel mode; disabling also tears down any active tunnel (falls back to static server.url). */
    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(PREF_ENABLED, enabled).apply()
        if (!enabled) {
            disconnect()
        }
    }

    /** Safe to call once connected — tsnet's persisted node identity (stateDir) re-authenticates without it. */
    fun clearAuthKey(context: Context) = TunnelKeyStore.clear(context)

    /**
     * Brings the tunnel up: Prepare() -> StartForward() -> Up(baseUrl).
     * Safe to call repeatedly — e.g. from the fallback page's "Reintentar",
     * or from TunnelSetupActivity's "Guardar y conectar" — since
     * StartForward's double-start guard (tsbridge/bridge.go) means a
     * connect() while one is already up/connecting just re-resolves to the
     * same running forwarder rather than starting a second one.
     */
    fun connect(context: Context) {
        val appContext = context.applicationContext
        scope.launch {
            _state.value = TunnelState.Connecting
            val result = withContext(Dispatchers.IO) {
                runCatching { doConnect(appContext) }
            }
            _state.value = result.fold(
                onSuccess = { TunnelState.Up(it) },
                onFailure = { TunnelState.Failed(it.message ?: it.toString()) },
            )
        }
    }

    private fun doConnect(context: Context): String {
        check(TsBridge.isAvailable) { "tsbridge no está disponible en este build (falta tsbridge.aar)" }
        val hubHostPort = hubHostPort(context)
        check(!hubHostPort.isNullOrBlank()) { "Falta configurar el host:puerto del hub" }
        val authKey = TunnelKeyStore.load(context) ?: ""

        TsBridge.prepare(context.cacheDir.absolutePath, context.filesDir.absolutePath)

        val stateDir = File(context.filesDir, "tsstate").absolutePath
        // NEVER reuse a persisted port — StartForward's return value is the
        // only source of truth, fresh on every call.
        val port = TsBridge.startForward(
            stateDir = stateDir,
            hostname = hostname(context),
            authKey = authKey,
            controlURL = controlUrl(context),
            hubHostPort = hubHostPort,
        )
        return "http://127.0.0.1:$port/"
    }

    /** Tears down the running forwarder (if any) and resets state to Idle. */
    fun disconnect() {
        scope.launch(Dispatchers.IO) {
            runCatching { TsBridge.stop() }
            _state.value = TunnelState.Idle
        }
    }

    /** Raw tsbridge.Status() JSON, or null if tsbridge is unavailable. Mainly for debugging/diagnostics. */
    fun status(): String? = TsBridge.status()
}
