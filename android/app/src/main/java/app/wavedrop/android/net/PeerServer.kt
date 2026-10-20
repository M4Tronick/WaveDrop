package app.wavedrop.android.net

import app.wavedrop.android.crypto.KeyPair
import app.wavedrop.android.crypto.Proto
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Phone-to-phone WaveDrop (Android and iPhone alike). Each phone serves the
 * same transfer protocol as the PC (src/core/transfer.js), so the sending
 * side is the code that already talks to PCs:
 *
 *   GET  /Hello          who this phone is
 *   POST /Pair/Request   "show me your QR": the other phone shows a card
 *   POST /Pair/QR        pairing: proves it scanned this phone's QR code
 *   POST /Ask            sealed request from a paired phone; held open until
 *                        someone accepts or declines on this phone
 *   POST /Chunk          one sealed 1 MiB chunk, in order
 *   POST /Cancel         the sender aborts
 *
 * Pairing uses a QR code instead of the PCs' 6-digit code: the QR carries
 * this phone's public key and a one-time secret, both read off the screen, so
 * the key is authentic and both sides can prove they saw the same QR
 * (qrProof with "wd-peer-pair" / "wd-peer-ok", as the PC's "wd-mobile-*").
 * Phones find each other over Bonjour/DNS-SD (_wavedrop._tcp), see Nearby.kt.
 */

/** Another phone this one is paired with. */
data class PeerInfo(val id: String, val pk: String, val name: String, val platform: String)

/** The QR another phone scans: wavedrop://peer?k=<secret>&p=<public key>&a=<ip:port>&n=<name> */
class PeerLink(val secret: ByteArray, val pk: ByteArray, val address: String?, val name: String?) {
    val id: String get() = Proto.deviceId(pk)
    val base: String? get() = address?.let { "http://$it" }

    fun format(): String = buildString {
        append("wavedrop://peer?k=").append(b64url(secret)).append("&p=").append(b64url(pk))
        if (address != null) append("&a=").append(address)
        if (!name.isNullOrEmpty()) append("&n=").append(URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
    }

    companion object {
        private fun b64url(b: ByteArray) = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)

        fun parse(text: String): PeerLink? = runCatching {
            val raw = text.trim()
            if (!raw.startsWith("wavedrop://peer?", ignoreCase = true)) return null
            val params = raw.substringAfter('?').split('&').mapNotNull {
                val i = it.indexOf('=')
                if (i > 0) it.substring(0, i) to java.net.URLDecoder.decode(it.substring(i + 1), "UTF-8") else null
            }.toMap()
            val secret = Proto.unb64url(params["k"] ?: return null)
            val pk = Proto.unb64url(params["p"] ?: return null)
            if (secret.size != 16 || pk.size != 32) return null
            val address = params["a"]?.takeIf { Regex("^[0-9a-fA-F.:\\[\\]]+:\\d{1,5}$").matches(it) }
            PeerLink(secret, pk, address, params["n"]?.take(40))
        }.getOrNull()
    }
}

/** Where a received file goes; generic so tests can write plain files. */
interface FileSink<S> {
    val output: OutputStream
    fun finish(size: Long): S
    fun discard()
}

enum class InStatus { PENDING, RECEIVING, DONE, DECLINED, CANCELLED, FAILED }

/** An offer from another phone, as the UI sees it. */
class IncomingOffer(
    val id: String,
    val peer: PeerInfo,
    val senderName: String,
    val files: List<Pair<String, Long>>,
    val text: String?,
    val thumbnail: String?,
) {
    val total: Long get() = files.sumOf { it.second }
}

interface PeerHost<S> {
    val identity: KeyPair
    fun name(): String
    fun platform(): String
    /** The port this phone's server listens on (sent along when pairing). */
    fun port(): Int
    /** False when the user hid this phone: nothing is accepted. */
    fun receiving(): Boolean
    fun peer(id: String): PeerInfo?
    /** A phone finished pairing with us through our QR; [url] is where it listens. */
    fun paired(peer: PeerInfo, url: String?)
    fun pairRequest(id: String, name: String, platform: String, url: String?)
    fun offer(offer: IncomingOffer)
    fun progress(id: String, received: Long, total: Long)
    fun finished(id: String, status: InStatus, saved: List<S>, note: String?)
    fun sink(name: String, size: Long): FileSink<S>
}

class PeerServer<S>(private val host: PeerHost<S>) : HttpHandler {
    private class Qr(val secret: ByteArray, val expires: Long, var attempts: Int = 3)

    private inner class Entry(val offer: IncomingOffer, val token: String, val peerPk: ByteArray) {
        @Volatile var status = InStatus.PENDING
        @Volatile var decision: Boolean? = null
        var key: ByteArray? = null
        var received = 0L
        var file = 0
        var next = 0L
        var sink: FileSink<S>? = null
        val saved = mutableListOf<S>()
        @Volatile var lastChunk = System.currentTimeMillis()
    }

    @Volatile private var qr: Qr? = null
    private val entries = ConcurrentHashMap<String, Entry>()
    private val requests = ConcurrentHashMap<String, Long>() // pair requests: id -> time
    private val watchdog = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "wavedrop-peer").apply { isDaemon = true } }

    init {
        watchdog.scheduleWithFixedDelay({ sweep() }, 10, 10, TimeUnit.SECONDS)
    }

    fun close() {
        for (e in entries.values) if (e.status == InStatus.PENDING || e.status == InStatus.RECEIVING) end(e, InStatus.CANCELLED, "Ricezione interrotta")
        watchdog.shutdownNow()
    }

    // ───────────── QR pairing ─────────────

    /** A new one-time QR secret, valid for [ttlMs]; the previous one stops working. */
    fun newQr(ttlMs: Long = QR_TTL_MS): ByteArray {
        val secret = Proto.randomBytes(16)
        qr = Qr(secret, System.currentTimeMillis() + ttlMs)
        return secret
    }

    fun dropQr() {
        qr = null
    }

    // ───────────── decisions from the UI ─────────────

    fun decide(id: String, accept: Boolean) {
        val e = entries[id] ?: return
        if (e.status == InStatus.PENDING) e.decision = accept
    }

    fun cancel(id: String) {
        val e = entries[id] ?: return
        when (e.status) {
            InStatus.PENDING -> e.decision = false
            InStatus.RECEIVING -> end(e, InStatus.CANCELLED, "Ricezione annullata")
            else -> {}
        }
    }

    // ───────────── routes ─────────────

    override fun handle(request: HttpRequest, probe: ClientProbe): HttpResponse? = when ("${request.method} ${request.path}") {
        "GET /Hello" -> hello()
        "POST /Pair/Request" -> pairRequest(request)
        "POST /Pair/QR" -> pairQr(request)
        "POST /Ask" -> ask(request, probe)
        "POST /Chunk" -> chunk(request)
        "POST /Cancel" -> remoteCancel(request)
        else -> HttpResponse.json(404)
    }

    private fun hello(): HttpResponse {
        if (!host.receiving()) return HttpResponse.json(404)
        val me = host.identity
        return HttpResponse.json(
            200,
            JSONObject().put("app", "wavedrop").put("v", Proto.VERSION).put("kind", "hello").put("vis", "everyone")
                .put("id", Proto.deviceId(me.pk)).put("pk", Proto.b64(me.pk)).put("name", host.name())
                .put("platform", host.platform()).put("port", host.port()),
        )
    }

    private fun clean(v: String?, max: Int) = v?.trim()?.take(max).orEmpty()

    private fun urlOf(request: HttpRequest, port: Int): String? {
        if (port !in 1..65535 || request.remoteAddress.isEmpty()) return null
        val ip = request.remoteAddress.removePrefix("::ffff:")
        return if (':' in ip) "http://[$ip]:$port" else "http://$ip:$port"
    }

    private fun pairRequest(request: HttpRequest): HttpResponse {
        val body = request.json ?: return HttpResponse.json(400)
        val id = clean(body.optString("id"), 20)
        if (!Regex("^[0-9a-f]{20}$").matches(id) || id == Proto.deviceId(host.identity.pk)) return HttpResponse.json(400)
        val now = System.currentTimeMillis()
        requests.entries.removeIf { now - it.value > REQUEST_GAP_MS }
        if (requests.containsKey(id) || requests.size >= 5) return HttpResponse.json(429)
        requests[id] = now
        host.pairRequest(id, clean(body.optString("name"), 40).ifEmpty { "Telefono" }, clean(body.optString("platform"), 16), urlOf(request, body.optInt("port")))
        return HttpResponse.json(202)
    }

    private fun pairQr(request: HttpRequest): HttpResponse {
        val body = request.json ?: return HttpResponse.json(400)
        val current = qr
        if (current == null || System.currentTimeMillis() > current.expires) return HttpResponse.json(410, JSONObject().put("reason", "expired"))
        val pk = runCatching { Proto.unb64(body.getString("pk")) }.getOrNull() ?: return HttpResponse.json(400)
        val me = host.identity
        if (pk.size != 32 || Proto.deviceId(pk) != body.optString("id") || Proto.sameBytes(pk, me.pk)) return HttpResponse.json(400)
        val expected = Proto.qrProof(current.secret, "wd-peer-pair", pk, me.pk)
        if (body.optString("proof") != expected) {
            synchronized(current) {
                current.attempts--
                if (current.attempts <= 0 && qr === current) qr = null
            }
            return HttpResponse.json(403, JSONObject().put("reason", "proof"))
        }
        qr = null // one pairing per QR
        val peer = PeerInfo(
            Proto.deviceId(pk),
            Proto.b64(pk),
            clean(body.optString("name"), 40).ifEmpty { "Telefono" },
            clean(body.optString("platform"), 16),
        )
        host.paired(peer, urlOf(request, body.optInt("port")))
        return HttpResponse.json(
            200,
            JSONObject().put("id", Proto.deviceId(me.pk)).put("pk", Proto.b64(me.pk)).put("name", host.name())
                .put("platform", host.platform()).put("port", host.port())
                .put("proof", Proto.qrProof(current.secret, "wd-peer-ok", me.pk, pk)),
        )
    }

    // ───────────── receiving ─────────────

    private fun ask(request: HttpRequest, probe: ClientProbe): HttpResponse? {
        val body = request.json ?: return HttpResponse.json(400)
        val peer = host.peer(body.optString("id")) ?: return HttpResponse.json(401, JSONObject().put("reason", "unpaired"))
        if (!host.receiving()) return HttpResponse.json(403, JSONObject().put("accepted", false).put("reason", "off"))
        val me = host.identity
        val peerPk = Proto.unb64(peer.pk)
        val opened = runCatching { Proto.askOpen(me.sk, me.pk, peerPk, body.getString("e"), body.getString("ct")) }.getOrNull()
            ?: return HttpResponse.json(401, JSONObject().put("reason", "auth"))
        val r = opened.request
        val arr = r.optJSONArray("files") ?: JSONArray()
        if (arr.length() > MAX_FILES) return HttpResponse.json(400)
        val files = (0 until arr.length()).map { i ->
            val f = arr.optJSONObject(i) ?: return HttpResponse.json(400)
            val size = f.optLong("size", -1)
            if (size < 0) return HttpResponse.json(400)
            clean(f.optString("name"), 500).ifEmpty { "file" } to size
        }
        val text = if (r.isNull("text")) null else r.optString("text").takeIf { it.isNotBlank() }?.take(MAX_TEXT)
        if (files.isEmpty() && text == null) return HttpResponse.json(400)
        val thumb = r.optString("thumbnail").takeIf { Regex("^data:image/(png|jpeg);base64,").containsMatchIn(it) && it.length < 400_000 }

        val offer = IncomingOffer(UUID.randomUUID().toString(), peer, clean(r.optString("name"), 40).ifEmpty { peer.name }, files, text, thumb)
        val entry = Entry(offer, Proto.hex(Proto.randomBytes(16)), peerPk)
        entries[offer.id] = entry
        host.offer(offer)

        // Held open until someone answers on this phone.
        val deadline = System.currentTimeMillis() + ASK_TIMEOUT_MS
        while (entry.decision == null) {
            if (System.currentTimeMillis() > deadline) {
                end(entry, InStatus.DECLINED, "Nessuna risposta")
                return HttpResponse.json(403, JSONObject().put("accepted", false).put("reason", "timeout"))
            }
            if (probe.gone(500)) {
                end(entry, InStatus.CANCELLED, "${offer.senderName} ha annullato l'invio")
                return null
            }
        }
        if (entry.decision != true) {
            end(entry, InStatus.DECLINED, "Rifiutato")
            return HttpResponse.json(403, JSONObject().put("accepted", false).put("reason", "declined"))
        }
        val answer = Proto.answerSeal(opened.k1, opened.eA, peerPk, JSONObject().put("accepted", true).put("session", offer.id).put("token", entry.token))
        entry.key = answer.key
        if (files.isEmpty()) {
            end(entry, InStatus.DONE, null)
        } else {
            entry.status = InStatus.RECEIVING
            entry.lastChunk = System.currentTimeMillis()
        }
        return HttpResponse.json(200, JSONObject().put("e", answer.e).put("ct", answer.ct))
    }

    private fun chunk(request: HttpRequest): HttpResponse {
        val entry = entries[request.query["s"]] ?: return HttpResponse.json(401)
        synchronized(entry) {
            if (entry.status != InStatus.RECEIVING) return HttpResponse.json(410, JSONObject().put("reason", entry.status.name.lowercase()))
            val f = request.query["f"]?.toIntOrNull() ?: return HttpResponse.json(400)
            val c = request.query["c"]?.toLongOrNull() ?: return HttpResponse.json(400)
            val last = request.query["last"] == "1"
            val files = entry.offer.files
            if (f != entry.file || f >= files.size || c != entry.next) return HttpResponse.json(409, JSONObject().put("reason", "order"))
            val (name, size) = files[f]
            val count = Proto.chunkCount(size)
            if (last != (c == count - 1)) return HttpResponse.json(400, JSONObject().put("reason", "framing"))
            val expected = if (last) size - c * Proto.CHUNK_SIZE else Proto.CHUNK_SIZE.toLong()
            val plain = runCatching { Proto.openChunk(entry.key!!, entry.offer.id, f, c, last, request.body) }.getOrNull()
            if (plain == null || plain.size.toLong() != expected) {
                end(entry, InStatus.FAILED, "Dati non autentici: ricezione interrotta")
                return HttpResponse.json(400, JSONObject().put("reason", "auth"))
            }
            try {
                val sink = entry.sink ?: host.sink(name, size).also { entry.sink = it }
                sink.output.write(plain)
                entry.received += plain.size
                entry.next++
                entry.lastChunk = System.currentTimeMillis()
                if (last) {
                    entry.saved += sink.finish(size)
                    entry.sink = null
                    entry.file++
                    entry.next = 0
                }
            } catch (e: Exception) {
                end(entry, InStatus.FAILED, e.message ?: "Impossibile salvare il file")
                return HttpResponse.json(500)
            }
            if (entry.file >= files.size) end(entry, InStatus.DONE, null)
            else host.progress(entry.offer.id, entry.received, entry.offer.total)
            return HttpResponse.json(200, JSONObject().put("ok", true))
        }
    }

    private fun remoteCancel(request: HttpRequest): HttpResponse {
        val entry = entries[request.query["s"]] ?: return HttpResponse.json(401)
        if (request.query["t"] != entry.token) return HttpResponse.json(401)
        end(entry, InStatus.CANCELLED, "${entry.offer.senderName} ha annullato l'invio")
        return HttpResponse.json(200, JSONObject().put("ok", true))
    }

    private fun end(entry: Entry, status: InStatus, note: String?) {
        synchronized(entry) {
            if (entry.status != InStatus.PENDING && entry.status != InStatus.RECEIVING) return
            entry.status = status
            if (entry.decision == null) entry.decision = false
            if (status != InStatus.DONE) {
                entry.sink?.discard()
                entry.sink = null
            }
            entry.key = null
        }
        host.finished(entry.offer.id, status, if (status == InStatus.DONE) entry.saved.toList() else emptyList(), note)
        if (watchdog.isShutdown) entries.remove(entry.offer.id)
        else runCatching { watchdog.schedule({ entries.remove(entry.offer.id) }, KEEP_FINISHED_S, TimeUnit.SECONDS) }
    }

    private fun sweep() {
        val now = System.currentTimeMillis()
        for (e in entries.values) {
            if (e.status == InStatus.RECEIVING && now - e.lastChunk > IDLE_MS) end(e, InStatus.FAILED, "Connessione interrotta")
        }
    }

    companion object {
        const val QR_TTL_MS = 5 * 60_000L
        const val ASK_TIMEOUT_MS = 90_000L
        const val IDLE_MS = 60_000L
        const val KEEP_FINISHED_S = 60L
        const val REQUEST_GAP_MS = 10_000L
        const val MAX_FILES = 10_000
        const val MAX_TEXT = 100_000
    }
}
