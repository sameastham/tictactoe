package mx.espanolcoach.app

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts/decrypts the tsnet auth key at rest using an AES-256-GCM key held
 * in the Android Keystore (hardware-backed where the device supports it) —
 * the key material never leaves the keystore; only ciphertext + IV are
 * persisted, in a private SharedPreferences file.
 *
 * The auth key is only needed for tsnet's FIRST login to the tailnet:
 * afterward, tsnet's own persisted node identity under its state dir
 * (filesDir/tsstate — see TunnelManager) re-authenticates the node on every
 * later StartForward call. So once a connection has succeeded, callers can
 * — and TunnelSetupActivity's UI does — offer to clear the stored auth key
 * without losing connectivity.
 */
object TunnelKeyStore {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "espanolcoach_tunnel_authkey"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128

    private const val PREFS_NAME = "tsbridge_tunnel"
    private const val PREF_CIPHERTEXT = "authkey_ciphertext_b64"
    private const val PREF_IV = "authkey_iv_b64"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    /** Encrypts and persists [authKey], overwriting any previously stored key. */
    fun save(context: Context, authKey: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(authKey.toByteArray(Charsets.UTF_8))
        prefs(context).edit()
            .putString(PREF_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .putString(PREF_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    /** Returns the decrypted auth key, or null if none is stored (or it failed to decrypt). */
    fun load(context: Context): String? {
        val p = prefs(context)
        val ciphertextB64 = p.getString(PREF_CIPHERTEXT, null) ?: return null
        val ivB64 = p.getString(PREF_IV, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(Base64.decode(ciphertextB64, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    fun hasKey(context: Context): Boolean = prefs(context).contains(PREF_CIPHERTEXT)

    /** Clears the stored auth key. Safe to call once tsnet has a persisted node identity (i.e. once connected). */
    fun clear(context: Context) {
        prefs(context).edit().remove(PREF_CIPHERTEXT).remove(PREF_IV).apply()
    }
}
