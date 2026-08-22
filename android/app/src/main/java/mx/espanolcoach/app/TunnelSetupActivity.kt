package mx.espanolcoach.app

import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
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
 */
class TunnelSetupActivity : AppCompatActivity() {
    private val uiScope = CoroutineScope(Dispatchers.Main + Job())

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

        root.addView(TextView(this).apply {
            text = "Túnel Tailscale integrado"
            textSize = 20f
        })
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
            }
        }
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
