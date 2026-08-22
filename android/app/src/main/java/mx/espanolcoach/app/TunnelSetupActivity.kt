package mx.espanolcoach.app

import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Settings screen for the embedded-Tailscale tunnel (Option B: userspace
 * tsnet node in-process + loopback TCP forward — see tsbridge/, README's
 * Android section). Reachable from MainActivity via a long-press on the
 * WebView or the "Túnel" options-menu item.
 *
 * Built programmatically (no layout XML) — it's a small, secondary settings
 * screen, so keeping it self-contained in one file avoids growing the
 * res/layout and res/values surface for something this size.
 *
 * The pasted auth key is only needed for tsnet's FIRST login: it's written
 * straight to TunnelKeyStore (Android Keystore AES-256-GCM, never held in
 * plaintext once saved) and never re-displayed. Once connected, tsnet's own
 * persisted node identity (under filesDir/tsstate) re-authenticates on
 * every later launch, so this screen offers "Borrar clave" to clear it.
 *
 * When launched with [EXTRA_AUTO_FINISH_ON_CONNECT] true (MainActivity sets
 * this for the first-launch chooser and the fallback page's "Configurar
 * túnel" button — both error-recovery entry points, not a deliberate visit
 * to settings), this screen finishes itself the moment the tunnel reaches
 * `TunnelState.Up`, handing control straight back to MainActivity, which is
 * independently collecting the same [TunnelManager.state] and loads the app
 * at that point (see MainActivity's class doc comment).
 */
class TunnelSetupActivity : AppCompatActivity() {
    private val uiScope = CoroutineScope(Dispatchers.Main + Job())
    private var autoFinishOnConnect = false

    companion object {
        const val EXTRA_AUTO_FINISH_ON_CONNECT = "auto_finish_on_connect"
    }

    private lateinit var enabledSwitch: Switch
    private lateinit var authKeyField: EditText
    private lateinit var hubHostPortField: EditText
    private lateinit var hostnameField: EditText
    private lateinit var controlUrlField: EditText
    private lateinit var statusText: TextView
    private lateinit var clearKeyButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Túnel"
        autoFinishOnConnect = intent.getBooleanExtra(EXTRA_AUTO_FINISH_ON_CONNECT, false)
        setContentView(buildUi())
        loadExisting()
        observeState()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }

        fun sectionLabel(text: String) = TextView(this).apply {
            this.text = text
            setPadding(0, dp(20), 0, dp(4))
        }

        val titleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        titleRow.addView(TextView(this).apply {
            text = "Túnel Tailscale integrado"
            textSize = 20f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        titleRow.addView(Button(this).apply {
            text = "?"
            contentDescription = "Ayuda: cómo configurar el túnel"
            minWidth = 0
            minimumWidth = 0
            setPadding(dp(14), dp(4), dp(14), dp(4))
            setOnClickListener { showHelp() }
        })
        root.addView(titleRow)
        root.addView(TextView(this).apply {
            text = "Conecta esta app directamente a la MacBook por Tailscale, " +
                "sin instalar la app de Tailscale por separado."
            setPadding(0, dp(4), 0, 0)
        })

        enabledSwitch = Switch(this).apply {
            text = "Activar túnel"
        }
        root.addView(enabledSwitch)

        root.addView(sectionLabel("Clave de autenticación (auth key)"))
        authKeyField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "tskey-auth-..."
        }
        root.addView(authKeyField)

        root.addView(sectionLabel("Host:puerto del hub"))
        hubHostPortField = EditText(this).apply {
            hint = "mbp-2019.tailnet-name.ts.net:3000"
        }
        root.addView(hubHostPortField)

        root.addView(sectionLabel("Avanzado"))

        root.addView(TextView(this).apply {
            text = "Hostname de este teléfono"
            setPadding(0, dp(8), 0, 0)
        })
        hostnameField = EditText(this).apply {
            hint = TunnelManager.DEFAULT_HOSTNAME
        }
        root.addView(hostnameField)

        root.addView(TextView(this).apply {
            text = "Control URL (Headscale, opcional — vacío = servidor de Tailscale por defecto)"
            setPadding(0, dp(8), 0, 0)
        })
        controlUrlField = EditText(this).apply {
            hint = "https://headscale.example.com"
        }
        root.addView(controlUrlField)

        root.addView(Button(this).apply {
            text = "Guardar y conectar"
            setPadding(0, dp(20), 0, 0)
            setOnClickListener { onSaveClicked() }
        })

        clearKeyButton = Button(this).apply {
            text = "Borrar clave (guardada — solo tras conectar)"
            isEnabled = false
            setOnClickListener { onClearKeyClicked() }
        }
        root.addView(clearKeyButton)

        statusText = TextView(this).apply {
            setPadding(0, dp(20), 0, 0)
        }
        root.addView(statusText)

        return ScrollView(this).apply { addView(root) }
    }

    private fun loadExisting() {
        enabledSwitch.isChecked = TunnelManager.isEnabled(this)
        hubHostPortField.setText(TunnelManager.hubHostPort(this) ?: "")
        hostnameField.setText(TunnelManager.hostname(this))
        controlUrlField.setText(TunnelManager.controlUrl(this))

        // The auth key is never re-displayed once saved — only whether one
        // is currently stored is surfaced, via the hint text.
        if (TunnelKeyStore.hasKey(this)) {
            authKeyField.hint = "(clave guardada — deja en blanco para no cambiarla)"
        }

        enabledSwitch.setOnCheckedChangeListener { _, checked ->
            TunnelManager.setEnabled(this, checked)
            if (!checked) {
                statusText.text = "Túnel desactivado. La app usará la URL fija del servidor."
            }
        }
    }

    private fun observeState() {
        uiScope.launch {
            TunnelManager.state.collect { state ->
                clearKeyButton.isEnabled = state is TunnelState.Up
                statusText.text = when (state) {
                    TunnelState.Idle -> ""
                    TunnelState.Connecting -> "Conectando…"
                    is TunnelState.Up -> "Conectado: ${state.baseUrl}"
                    is TunnelState.Failed -> "Error: ${state.message}"
                }
                // See EXTRA_AUTO_FINISH_ON_CONNECT's doc comment above: only
                // the error-recovery entry points ask for this, so a
                // deliberate visit to settings (long-press/options menu)
                // isn't yanked away the instant a connection succeeds.
                if (autoFinishOnConnect && state is TunnelState.Up) {
                    finish()
                }
            }
        }
    }

    /**
     * Terse, Spanish, operator-facing recap of what's needed to fill in the
     * two required fields above — mirrors README.md's "Embedded-Tailscale
     * tunnel mode" section (auth-key requirements, hub host:port, the
     * server having to be running) without duplicating its full detail.
     */
    private fun showHelp() {
        AlertDialog.Builder(this)
            .setTitle("Cómo configurar")
            .setMessage(
                "• Clave de autenticación: créala en la consola de Tailscale " +
                    "(Ajustes → Keys). Debe ser \"Pre-authorized: Sí\" y llevar una " +
                    "etiqueta (tag), p. ej. tag:espanol-phone — así no queda con " +
                    "acceso a todo el tailnet.\n\n" +
                    "• Host:puerto del hub: el nombre MagicDNS de la MacBook más " +
                    "\":3000\" (ej. mbp-2019.tailnet-name.ts.net:3000). Consíguelo con " +
                    "\"tailscale status\" en la MacBook.\n\n" +
                    "• El servidor debe estar corriendo en la MacBook (\"npm run dev\") " +
                    "para que el túnel tenga algo a lo cual conectarse."
            )
            .setPositiveButton("Entendido", null)
            .show()
    }

    private fun onSaveClicked() {
        val hubHostPort = hubHostPortField.text.toString().trim()
        if (hubHostPort.isEmpty()) {
            Toast.makeText(this, "Falta el host:puerto del hub", Toast.LENGTH_SHORT).show()
            return
        }
        val typedKey = authKeyField.text.toString().trim()
        if (typedKey.isEmpty() && !TunnelKeyStore.hasKey(this)) {
            Toast.makeText(this, "Falta la clave de autenticación", Toast.LENGTH_SHORT).show()
            return
        }

        TunnelManager.saveConfig(
            context = this,
            authKey = typedKey.ifEmpty { null },
            hubHostPort = hubHostPort,
            hostname = hostnameField.text.toString().trim(),
            controlUrl = controlUrlField.text.toString().trim(),
        )
        enabledSwitch.isChecked = true
        authKeyField.text.clear()
        if (TunnelKeyStore.hasKey(this)) {
            authKeyField.hint = "(clave guardada — deja en blanco para no cambiarla)"
        }
        TunnelManager.connect(this)
    }

    private fun onClearKeyClicked() {
        TunnelManager.clearAuthKey(this)
        authKeyField.hint = "tskey-auth-..."
        Toast.makeText(
            this,
            "Clave borrada. El nodo sigue registrado con su identidad guardada.",
            Toast.LENGTH_LONG,
        ).show()
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }
}
