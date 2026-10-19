package app.wavedrop.android.data

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.wavedrop.android.crypto.KeyPair
import app.wavedrop.android.crypto.Proto
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A PC this phone is paired with (through its QR code). */
data class Pc(
    val id: String,
    val pk: String,
    val name: String,
    val platform: String,
    val url: String, // http://ip:port
    val addedAt: Long,
) {
    val pkBytes: ByteArray get() = Proto.unb64(pk)

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("pk", pk).put("name", name)
        .put("platform", platform).put("url", url).put("addedAt", addedAt)

    companion object {
        fun fromJson(o: JSONObject) = Pc(
            o.getString("id"), o.getString("pk"), o.getString("name"),
            o.optString("platform"), o.getString("url"), o.optLong("addedAt"),
        )
    }
}

/**
 * Identity, paired PCs and preferences. The X25519 private key is wrapped with
 * an AES key that lives in the Android Keystore and never leaves it.
 */
class Store(private val context: Context) {
    private val prefs = context.getSharedPreferences("wavedrop", Context.MODE_PRIVATE)

    val identity: KeyPair by lazy { loadIdentity() }
    val id: String get() = Proto.deviceId(identity.pk)

    var name: String
        get() = prefs.getString("name", null) ?: defaultName()
        set(value) = prefs.edit().putString("name", value.trim().take(40).ifEmpty { defaultName() }).apply()

    var stayReachable: Boolean
        get() = prefs.getBoolean("stayReachable", false)
        set(value) = prefs.edit().putBoolean("stayReachable", value).apply()

    var askedNotifications: Boolean
        get() = prefs.getBoolean("askedNotifications", false)
        set(value) = prefs.edit().putBoolean("askedNotifications", value).apply()

    fun pcs(): List<Pc> {
        val arr = JSONArray(prefs.getString("pcs", "[]"))
        return (0 until arr.length()).map { Pc.fromJson(arr.getJSONObject(it)) }
    }

    fun savePc(pc: Pc) = writePcs(pcs().filter { it.id != pc.id } + pc)

    fun removePc(id: String) = writePcs(pcs().filter { it.id != id })

    private fun writePcs(list: List<Pc>) {
        prefs.edit().putString("pcs", JSONArray(list.map { it.toJson() }).toString()).apply()
    }

    private fun defaultName(): String =
        Settings.Global.getString(context.contentResolver, "device_name")?.takeIf { it.isNotBlank() } ?: Build.MODEL

    // ───────────── identity ─────────────

    private fun loadIdentity(): KeyPair {
        val wrapped = prefs.getString("sk", null)
        if (wrapped != null) {
            runCatching {
                val sk = unwrap(wrapped)
                return KeyPair(sk, Proto.publicKeyOf(sk))
            }
        }
        val pair = Proto.newKeyPair()
        prefs.edit().putString("sk", wrap(pair.sk)).apply()
        return pair
    }

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun wrap(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        return Proto.b64(cipher.iv) + ":" + Proto.b64(cipher.doFinal(plain))
    }

    private fun unwrap(text: String): ByteArray {
        val (iv, data) = text.split(":")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, Proto.unb64(iv)))
        return cipher.doFinal(Proto.unb64(data))
    }

    private companion object {
        const val KEY_ALIAS = "wavedrop.identity"
    }
}
