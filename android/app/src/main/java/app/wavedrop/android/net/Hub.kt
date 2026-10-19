package app.wavedrop.android.net

import android.content.Context
import android.net.Uri
import app.wavedrop.android.Notifier
import app.wavedrop.android.crypto.Proto
import app.wavedrop.android.data.Pc
import app.wavedrop.android.data.Store
import app.wavedrop.android.files.Files
import app.wavedrop.android.files.Item
import app.wavedrop.android.files.SavedFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

enum class Dir { IN, OUT }

enum class Status {
    PREPARING, WAITING, OFFER, SENDING, RECEIVING, DONE, DECLINED, CANCELLED, FAILED;

    val active get() = this in setOf(PREPARING, WAITING, OFFER, SENDING, RECEIVING)
}

data class Transfer(
    val id: String,
    val pcId: String,
    val peer: String,
    val dir: Dir,
    val what: String,
    val size: Long,
    val status: Status,
    val progress: Float = 0f,
    val note: String? = null,
    val text: String? = null,
    val thumbnail: String? = null,
    val saved: List<SavedFile> = emptyList(),
    val time: Long = System.currentTimeMillis(),
)

data class PcState(val pc: Pc, val online: Boolean)

data class UiState(val pcs: List<PcState> = emptyList(), val transfers: List<Transfer> = emptyList())

class RemoteCancelled : IOException("Annullato sul PC")

/** «foto.jpg», la cartella «Foto», 3 elementi, un testo — same wording as the PC. */
fun describe(names: List<String>, text: String?): String {
    if (names.isEmpty() && text != null) return "un testo"
    val tops = names.map { it.substringBefore('/') }.distinct()
    if (tops.size == 1) return if (names.any { '/' in it }) "la cartella «${tops[0]}»" else "«${tops[0]}»"
    return "${tops.size} elementi"
}

private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

private fun declineNote(reason: String) = when (reason) {
    "off" -> "Il PC non sta ricevendo file"
    "timeout" -> "Nessuna risposta dal PC"
    else -> "Il PC ha rifiutato"
}

/** Owns the connections to every paired PC and the list of transfers. */
class Hub(private val context: Context, val store: Store) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // /Ask waits until someone at the PC accepts, hence the long read timeout.
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(100, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()
    val sse: OkHttpClient = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).build()

    private val _state = MutableStateFlow(UiState(pcs = store.pcs().map { PcState(it, false) }))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val links = ConcurrentHashMap<String, PcLink>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val users = mutableSetOf<String>()
    private var idle: Job? = null

    // ───────────── presence ─────────────

    /** Something visible (an activity, the background service) wants live connections. */
    @Synchronized
    fun attach(who: String) {
        users += who
        idle?.cancel()
        for (pc in store.pcs()) link(pc).connect()
    }

    @Synchronized
    fun detach(who: String) {
        users -= who
        if (users.isNotEmpty()) return
        idle = scope.launch {
            delay(30_000) // survive quick app switches
            synchronized(this@Hub) { if (users.isEmpty()) links.values.forEach { it.disconnect() } }
        }
    }

    private fun link(pc: Pc): PcLink = links.getOrPut(pc.id) { PcLink(this, context, pc) }

    internal fun setOnline(pcId: String, online: Boolean) = _state.update { s ->
        s.copy(pcs = s.pcs.map { if (it.pc.id == pcId) it.copy(online = online) else it })
    }

    internal fun renamePc(pc: Pc) {
        store.savePc(pc)
        refreshPcs()
    }

    fun refreshPcs() = _state.update { s ->
        s.copy(pcs = store.pcs().map { pc -> PcState(pc, links[pc.id]?.online == true) })
    }

    suspend fun pair(text: String): Pc {
        val link = Pairing.parse(text) ?: throw Pairing.PairingException("Questo non è un codice QR di WaveDrop.")
        val pc = Pairing.pair(http, store, link)
        links.remove(pc.id)?.disconnect()
        refreshPcs()
        synchronized(this) { if (users.isNotEmpty()) link(pc).connect() }
        return pc
    }

    fun removePc(id: String) {
        links.remove(id)?.disconnect()
        store.removePc(id)
        refreshPcs()
    }

    // ───────────── transfers ─────────────

    internal fun add(t: Transfer) = _state.update { it.copy(transfers = listOf(t) + it.transfers.take(49)) }

    internal fun update(id: String, f: (Transfer) -> Transfer) = _state.update { s ->
        s.copy(transfers = s.transfers.map { if (it.id == id) f(it) else it })
    }

    fun transfer(id: String) = _state.value.transfers.find { it.id == id }

    fun dismiss(id: String) = _state.update { s -> s.copy(transfers = s.transfers.filter { it.id != id }) }

    fun sendFiles(pcId: String, uris: List<Uri>): String? =
        startSend(pcId, if (uris.size == 1) "un file" else "${uris.size} elementi") { uris.map { Files.describe(context, it) } to null }

    fun sendText(pcId: String, text: String): String? =
        startSend(pcId, "un testo") { emptyList<Item>() to text.take(100_000) }

    private fun startSend(pcId: String, label: String, prepare: suspend () -> Pair<List<Item>, String?>): String? {
        val pc = store.pcs().find { it.id == pcId } ?: return null
        val id = UUID.randomUUID().toString()
        add(Transfer(id, pc.id, pc.name, Dir.OUT, label, 0, Status.PREPARING, note = "Preparazione…"))
        run(id) {
            val (items, text) = prepare()
            link(pc).send(id, items, text)
        }
        return id
    }

    fun accept(id: String) {
        val t = transfer(id) ?: return
        val pc = store.pcs().find { it.id == t.pcId } ?: return
        update(id) { it.copy(status = Status.RECEIVING, note = "Connessione…") }
        run(id) { link(pc).accept(id) }
    }

    fun decline(id: String) {
        val t = transfer(id) ?: return
        val pc = store.pcs().find { it.id == t.pcId } ?: return
        scope.launch { link(pc).decline(id) }
    }

    fun cancel(id: String) {
        val t = transfer(id) ?: return
        if (t.status == Status.OFFER) return decline(id)
        update(id) { it.copy(status = Status.CANCELLED, note = if (it.dir == Dir.OUT) "Invio annullato" else "Ricezione annullata") }
        jobs[id]?.cancel()
    }

    internal fun remoteCancel(id: String) {
        val t = transfer(id) ?: return
        if (!t.status.active) return
        update(id) { it.copy(status = Status.CANCELLED, note = "Annullato sul PC") }
        jobs[id]?.cancel()
    }

    private fun run(id: String, block: suspend () -> Unit) {
        jobs[id] = scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                // status already set by cancel()/remoteCancel()
            } catch (e: RemoteCancelled) {
                update(id) { it.copy(status = Status.CANCELLED, note = "Annullato sul PC") }
            } catch (e: SecurityException) {
                update(id) { it.copy(status = Status.FAILED, note = "WaveDrop non ha il permesso di leggere questo file") }
            } catch (e: Exception) {
                update(id) { if (it.status.active) it.copy(status = Status.FAILED, note = e.message ?: "Non riuscito") else it }
            } finally {
                jobs.remove(id)
            }
        }
    }
}

/** One paired PC: live event stream, sending, receiving. */
class PcLink(private val hub: Hub, private val context: Context, @Volatile var pc: Pc) {
    @Volatile
    var online = false
        private set

    @Volatile
    private var active = false
    private var source: EventSource? = null
    private var retry: Job? = null
    private val offers = ConcurrentHashMap<String, Offer>()

    private class Offer(val opened: Proto.Opened, val files: List<Pair<String, Long>>, val text: String?)

    private val store get() = hub.store
    private val pcPk get() = pc.pkBytes

    // ───────────── event stream ─────────────

    fun connect() {
        if (active) return
        active = true
        open()
    }

    fun disconnect() {
        active = false
        retry?.cancel()
        source?.cancel()
        source = null
        setOnline(false)
    }

    private fun setOnline(value: Boolean) {
        if (online == value) return
        online = value
        hub.setOnline(pc.id, value)
    }

    private fun open() {
        val me = store.identity
        val t = System.currentTimeMillis().toString()
        val sig = Proto.b64(Proto.mac(Proto.pairKey(me.sk, me.pk, pcPk, "link"), Proto.lv("wd-events", t)))
        val url = "${pc.url}/m/events?id=${store.id}&t=$t&sig=${enc(sig)}"
        source = EventSources.createFactory(hub.sse).newEventSource(Request.Builder().url(url).build(), listener)
    }

    private val listener = object : EventSourceListener() {
        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            if (eventSource !== source) return
            when (type) {
                "hello" -> {
                    setOnline(true)
                    val name = JSONObject(data).optString("name")
                    if (name.isNotEmpty() && name != pc.name) {
                        pc = pc.copy(name = name)
                        hub.renamePc(pc)
                    }
                }
                "offer" -> onOffer(JSONObject(data))
                "cancel" -> {
                    val offer = JSONObject(data).optString("offer")
                    offers.remove(offer)
                    Notifier.clear(context, offer)
                    hub.remoteCancel(offer)
                }
            }
        }

        override fun onClosed(eventSource: EventSource) = lost(eventSource)

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) = lost(eventSource)
    }

    private fun lost(eventSource: EventSource) {
        if (eventSource !== source) return
        setOnline(false)
        if (!active) return
        retry?.cancel()
        retry = hub.scope.launch {
            delay(3000)
            if (active) open()
        }
    }

    // ───────────── phone → PC ─────────────

    suspend fun send(id: String, items: List<Item>, text: String?) {
        val me = store.identity
        val total = items.sumOf { it.size }
        val thumbnail = items.firstOrNull()?.let { Files.thumbnail(context, it) }
        hub.update(id) {
            it.copy(what = describe(items.map { i -> i.name }, text), size = total, status = Status.WAITING, note = "In attesa di conferma sul PC…", thumbnail = thumbnail)
        }
        val request = JSONObject()
            .put("name", store.name)
            .put("platform", "android")
            .put("files", JSONArray(items.map { JSONObject().put("name", it.name).put("size", it.size) }))
            .put("text", text ?: JSONObject.NULL)
            .put("thumbnail", thumbnail ?: JSONObject.NULL)
        val sealed = Proto.askSeal(me.sk, me.pk, pcPk, request)
        val res = try {
            hub.http.postJson("${pc.url}/Ask", JSONObject().put("id", store.id).put("e", sealed.e).put("ct", sealed.ct))
        } catch (e: IOException) {
            throw IOException("PC non raggiungibile: WaveDrop è aperto e siete sulla stessa rete?")
        }
        if (res.code == 401) throw IOException("Il PC non riconosce più questo telefono: ricollegalo con un nuovo QR.")
        if (res.code != 200) {
            hub.update(id) { it.copy(status = Status.DECLINED, note = declineNote(res.json.optString("reason"))) }
            return
        }
        val answer = Proto.answerOpen(sealed.k1, me.sk, sealed.ephemeral, res.json.getString("e"), res.json.getString("ct"))
        val session = answer.answer.getString("session")
        val token = answer.answer.getString("token")
        if (items.isEmpty()) {
            hub.update(id) { it.copy(status = Status.DONE, progress = 1f, note = "Testo inviato") }
            return
        }

        hub.update(id) { it.copy(status = Status.SENDING, note = null) }
        try {
            var sent = 0L
            val buf = ByteArray(Proto.CHUNK_SIZE)
            items.forEachIndexed { f, item ->
                context.contentResolver.openInputStream(item.uri)!!.use { input ->
                    val count = Proto.chunkCount(item.size)
                    for (c in 0 until count) {
                        val last = c == count - 1
                        val len = if (last) (item.size - c * Proto.CHUNK_SIZE).toInt() else Proto.CHUNK_SIZE
                        readFully(input, buf, len)
                        val body = Proto.sealChunk(answer.key, session, f, c, last, buf, len)
                        val r = hub.http.postBytes("${pc.url}/Chunk?s=${enc(session)}&f=$f&c=$c&last=${if (last) 1 else 0}", body)
                        if (r.code == 410) throw RemoteCancelled()
                        if (r.code != 200) throw IOException("Invio interrotto (errore ${r.code})")
                        sent += len
                        hub.update(id) { it.copy(progress = if (total > 0) sent.toFloat() / total else 1f) }
                    }
                }
            }
            hub.update(id) { it.copy(status = Status.DONE, progress = 1f, note = null) }
        } catch (e: CancellationException) {
            hub.scope.launch { runCatching { hub.http.postJson("${pc.url}/Cancel?s=${enc(session)}&t=${enc(token)}", JSONObject()) } }
            throw e
        }
    }

    private fun readFully(input: InputStream, buf: ByteArray, len: Int) {
        var off = 0
        while (off < len) {
            val n = input.read(buf, off, len - off)
            if (n < 0) throw IOException("Il file è cambiato durante l'invio")
            off += n
        }
    }

    // ───────────── PC → phone ─────────────

    private fun onOffer(ev: JSONObject) {
        val offerId = ev.optString("offer")
        if (offerId.isEmpty() || offers.containsKey(offerId) || hub.transfer(offerId) != null) return
        val me = store.identity
        val opened = runCatching { Proto.askOpen(me.sk, me.pk, pcPk, ev.getString("e"), ev.getString("ct")) }.getOrNull() ?: return
        val req = opened.request
        val arr = req.optJSONArray("files") ?: JSONArray()
        val files = (0 until arr.length()).map { i -> arr.getJSONObject(i).let { it.getString("name") to it.getLong("size") } }
        val text = if (req.isNull("text")) null else req.optString("text").takeIf { it.isNotEmpty() }
        offers[offerId] = Offer(opened, files, text)
        val from = req.optString("name").ifEmpty { pc.name }
        val what = describe(files.map { it.first }, text)
        val thumb = req.optString("thumbnail").takeIf { it.startsWith("data:image/") }
        hub.add(Transfer(offerId, pc.id, from, Dir.IN, what, files.sumOf { it.second }, Status.OFFER, thumbnail = thumb, text = text))
        Notifier.offer(context, offerId, from, "Vuole inviarti $what")
    }

    suspend fun accept(id: String) {
        val offer = offers[id] ?: throw IOException("L'offerta non è più valida.")
        Notifier.clear(context, id)
        val answer = Proto.answerSeal(offer.opened.k1, offer.opened.eA, pcPk, JSONObject().put("accepted", true))
        val r = hub.http.postJson("${pc.url}/m/answer", JSONObject().put("offer", id).put("e", answer.e).put("ct", answer.ct))
        if (r.code != 200) throw IOException("L'offerta non è più valida.")
        if (offer.files.isEmpty()) {
            offers.remove(id)
            hub.update(id) { it.copy(status = Status.DONE, progress = 1f, note = "Ricevuto") }
            return
        }

        hub.update(id) { it.copy(status = Status.RECEIVING, progress = 0f, note = null) }
        val total = offer.files.sumOf { it.second }
        val saved = mutableListOf<SavedFile>()
        var got = 0L
        var pending: Files.Pending? = null
        try {
            for ((f, file) in offer.files.withIndex()) {
                val (name, size) = file
                val p = Files.create(context, name).also { pending = it }
                val count = Proto.chunkCount(size)
                for (c in 0 until count) {
                    val last = c == count - 1
                    val res = hub.http.get("${pc.url}/m/chunk?o=${enc(id)}&f=$f&c=$c")
                    if (res.code == 410) throw RemoteCancelled()
                    if (res.code != 200) throw IOException("Download interrotto (errore ${res.code})")
                    val plain = Proto.openChunk(answer.key, id, f, c, last, res.bytes)
                    p.output.write(plain)
                    got += plain.size
                    hub.update(id) { it.copy(progress = if (total > 0) got.toFloat() / total else 1f) }
                }
                saved += Files.finish(context, p, size)
                pending = null
            }
            hub.update(id) { it.copy(status = Status.DONE, progress = 1f, saved = saved.toList()) }
        } catch (e: CancellationException) {
            pending?.let { Files.discard(context, it) }
            val mac = Proto.b64(Proto.mac(answer.key, Proto.lv("wd-cancel", id)))
            hub.scope.launch { runCatching { hub.http.postJson("${pc.url}/m/cancel", JSONObject().put("offer", id).put("mac", mac)) } }
            throw e
        } catch (e: Exception) {
            pending?.let { Files.discard(context, it) }
            throw e
        } finally {
            offers.remove(id)
        }
    }

    suspend fun decline(id: String) {
        val offer = offers.remove(id) ?: return
        Notifier.clear(context, id)
        hub.update(id) { it.copy(status = Status.DECLINED, note = "Rifiutato") }
        val answer = Proto.answerSeal(offer.opened.k1, offer.opened.eA, pcPk, JSONObject().put("accepted", false))
        runCatching { hub.http.postJson("${pc.url}/m/answer", JSONObject().put("offer", id).put("e", answer.e).put("ct", answer.ct)) }
    }
}
