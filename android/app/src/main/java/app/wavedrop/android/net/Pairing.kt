package app.wavedrop.android.net

import android.net.Uri
import app.wavedrop.android.crypto.Proto
import app.wavedrop.android.data.Pc
import app.wavedrop.android.data.Store
import okhttp3.OkHttpClient
import org.json.JSONObject

/**
 * QR pairing with a PC. The QR (shown by WaveDrop on the PC) is a link like
 * http://192.168.1.10:47480/m/#k=<one-time secret>&p=<PC public key>: both
 * values come from the screen, so the PC's key is authentic, and the secret
 * lets both sides prove they saw the same QR.
 */
object Pairing {
    class Link(val base: String, val secret: ByteArray, val pcPk: ByteArray)

    class PairingException(message: String) : Exception(message)

    fun parse(text: String): Link? = runCatching {
        var raw = text.trim()
        if (raw.startsWith("wavedrop://")) raw = Uri.parse(raw).getQueryParameter("u") ?: return null
        val uri = Uri.parse(raw)
        if (uri.scheme != "http" && uri.scheme != "https") return null
        val params = (uri.encodedFragment ?: return null).split("&").mapNotNull {
            val parts = it.split("=", limit = 2)
            if (parts.size == 2) parts[0] to parts[1] else null
        }.toMap()
        val secret = Proto.unb64url(params["k"] ?: return null)
        val pcPk = Proto.unb64url(params["p"] ?: return null)
        if (secret.size != 16 || pcPk.size != 32) return null
        val port = if (uri.port > 0) ":${uri.port}" else ""
        Link("${uri.scheme}://${uri.host}$port", secret, pcPk)
    }.getOrNull()

    suspend fun pair(http: OkHttpClient, store: Store, link: Link): Pc {
        val me = store.identity
        val res = try {
            http.postJson(
                "${link.base}/m/pair",
                JSONObject()
                    .put("pk", Proto.b64(me.pk))
                    .put("name", store.name)
                    .put("platform", "android")
                    .put("proof", Proto.qrProof(link.secret, "wd-mobile-pair", me.pk, link.pcPk)),
            )
        } catch (e: Exception) {
            throw PairingException("Il PC non risponde. Telefono e PC sono sulla stessa rete Wi-Fi, e WaveDrop è aperto?")
        }
        if (res.code == 410) throw PairingException("Il codice QR è scaduto o è già stato usato. Generane uno nuovo sul PC.")
        if (res.code != 200) throw PairingException("Collegamento non riuscito (errore ${res.code}).")
        val body = res.json
        val pcPk = Proto.unb64(body.getString("pk"))
        val expected = Proto.qrProof(link.secret, "wd-mobile-ok", link.pcPk, me.pk)
        if (!Proto.sameBytes(pcPk, link.pcPk) || body.optString("proof") != expected) {
            throw PairingException("Il PC non ha superato la verifica: collegamento annullato.")
        }
        val pc = Pc(
            id = body.getString("id"),
            pk = Proto.b64(pcPk),
            name = body.optString("name", "PC"),
            platform = body.optString("platform"),
            url = link.base,
            addedAt = System.currentTimeMillis(),
        )
        store.savePc(pc)
        return pc
    }
}
