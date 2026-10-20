package app.wavedrop.android.net

import android.content.Context
import android.net.Uri
import app.wavedrop.android.Notifier
import app.wavedrop.android.crypto.KeyPair
import app.wavedrop.android.crypto.Proto
import app.wavedrop.android.data.Pc
import app.wavedrop.android.data.Phone
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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
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
import java.io.OutputStream
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
    val peerId: String, // a PC or a phone
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

data class PhoneState(val phone: Phone, val online: Boolean)

/** Another phone asked this one to show its QR code. */
data class PairRequest(val id: String, val name: String, val platform: String, val time: Long)

/** This phone's pairing QR while it is on screen; [pairedWith] once someone scanned it. */
data class ShownQr(val text: String, val expires: Long, val pairedWith: String? = null)

/** Somewhere to send: a PC or a paired phone. */
data class Target(val id: String, val name: String, val isPhone: Boolean, val platform: String, val online: Boolean)

data class UiState(
    val pcs: List<PcState> = emptyList(),
    val phones: List<PhoneState> = emptyList(),
    val nearby: List<NearbyPhone> = emptyList(), // phones heard nearby, not paired yet
    val requests: List<PairRequest> = emptyList(),
    val qr: ShownQr? = null,
    val transfers: List<Transfer> = emptyList(),
) {
    val targets: List<Target>
        get() = pcs.map { Target(it.pc.id, it.pc.name, false, it.pc.platform, it.online) } +
            phones.map { Target(it.phone.id, it.phone.name, true, it.phone.platform, it.online) }
}

class RemoteCancelled(note: String = "Annullato sul PC") : IOException(note)

/** «foto.jpg», la cartella «Foto», 3 elementi, un testo — same wording as the PC. */
fun describe(names: List<String>, text: String?): String {
    if (names.isEmpty() && text != null) return "un testo"
    val tops = names.map { it.substringBefore('/') }.distinct()
    if (tops.size == 1) return if (names.any { '/' in it }) "la cartella «${tops[0]}»" else "«${tops[0]}»"
    return "${tops.size} elementi"
}

private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

/** The wording for each kind of receiver, so PC and phone sends share one code path. */
private class Receiver(val name: String, val isPhone: Boolean) {
    val waiting get() = if (isPhone) "In attesa che $name accetti…" else "In attesa di conferma sul PC…"
    val unreachable get() = if (isPhone) "$name non è raggiungibile: avete WaveDrop aperto sulla stessa rete Wi-Fi?" else "PC non raggiungibile: WaveDrop è aperto e siete sulla stessa rete?"
    val unpaired get() = if (isPhone) "$name non riconosce più questo telefono: abbinatevi di nuovo con il QR." else "Il PC non riconosce più questo telefono: ricollegalo con un nuovo QR."
    val cancelled get() = if (isPhone) "Annullato su $name" else "Annullato sul PC"

    fun declined(reason: String) = when (reason) {
        "off" -> if (isPhone) "$name non sta ricevendo file" else "Il PC non sta ricevendo file"
        "timeout" -> if (isPhone) "Nessuna risposta da $name" else "Nessuna risposta dal PC"
        else -> if (isPhone) "$name ha rifiutato" else "Il PC ha rifiutato"
    }
}

/** Owns the connections to every paired PC and phone, this phone's server, and the list of transfers. */
class Hub(private val context: Context, val store: Store) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // /Ask waits until someone at the other end accepts, hence the long read timeout.
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(100, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()
    val sse: OkHttpClient = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).build()

    private val _state = MutableStateFlow(
        UiState(pcs = store.pcs().map { PcState(it, false) }, phones = store.phones().map { PhoneState(it, false) }),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** One-line messages for the snackbar ("Abbinato con …"). */
    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val notices: SharedFlow<String> = _notices

    private val links = ConcurrentHashMap<String, PcLink>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val users = mutableSetOf<String>()
    private var idle: Job? = null

    // ───────────── this phone's server (phone ↔ phone) ─────────────

    private val peerHost: PeerHost<SavedFile> = object : PeerHost<SavedFile> {
        override val identity: KeyPair get() = store.identity
        override fun name() = store.name
        override fun platform() = "android"
        override fun port() = httpServer.port
        override fun receiving() = store.visibleToPhones
        override fun peer(id: String) = store.phones().find { it.id == id }?.let { PeerInfo(it.id, it.pk, it.name, it.platform) }
        override fun paired(peer: PeerInfo, url: String?) = onPaired(peer, url)
        override fun pairRequest(id: String, name: String, platform: String, url: String?) = onPairRequest(id, name, platform)
        override fun offer(offer: IncomingOffer) = onPhoneOffer(offer)
        override fun progress(id: String, received: Long, total: Long) =
            update(id) { it.copy(status = Status.RECEIVING, progress = if (total > 0) received.toFloat() / total else 1f, note = null) }
        override fun finished(id: String, status: InStatus, saved: List<SavedFile>, note: String?) = onPhoneFinished(id, status, saved, note)
        override fun sink(name: String, size: Long): FileSink<SavedFile> {
            val pending = Files.create(context, name)
            return object : FileSink<SavedFile> {
                override val output: OutputStream get() = pending.output
                override fun finish(size: Long) = Files.finish(context, pending, size)
                override fun discard() = Files.discard(context, pending)
            }
        }
    }
    private val peerServer: PeerServer<SavedFile> = PeerServer(peerHost)
    private val httpServer: MiniHttpServer = MiniHttpServer(peerServer)
    private val discovered = ConcurrentHashMap<String, NearbyPhone>() // id -> heard over Bonjour
    private val nearby = Nearby(context) { list ->
        discovered.clear()
        list.forEach { discovered[it.id] = it }
        refreshPhones()
    }

    // ───────────── presence ─────────────

    /** Something visible (an activity, the background service) wants live connections. */
    @Synchronized
    fun attach(who: String) {
        users += who
        idle?.cancel()
        for (pc in store.pcs()) link(pc).connect()
        startPeer()
    }

    @Synchronized
    fun detach(who: String) {
        users -= who
        if (users.isNotEmpty()) return
        idle = scope.launch {
            delay(30_000) // survive quick app switches
            synchronized(this@Hub) {
                if (users.isEmpty()) {
                    links.values.forEach { it.disconnect() }
                    stopPeer()
                }
            }
        }
    }

    private fun startPeer() {
        val port = runCatching { httpServer.start(PEER_PORT) }.getOrElse { return }
        nearby.start(store.id, store.name, port, store.visibleToPhones)
    }

    private fun stopPeer() {
        nearby.stop()
        httpServer.stop()
        hideQr()
    }

    /** The name or the visibility changed: announce again. */
    fun announce() {
        if (httpServer.port > 0) nearby.update(store.id, store.name, httpServer.port, store.visibleToPhones)
    }

    var visibleToPhones: Boolean
        get() = store.visibleToPhones
        set(value) {
            store.visibleToPhones = value
            announce()
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

    /** Paired phones are online while Bonjour hears them; the others are "nearby". */
    private fun refreshPhones() {
        for (phone in store.phones()) {
            val heard = discovered[phone.id] ?: continue
            if (heard.url != phone.url || heard.name != phone.name) store.savePhone(phone.copy(url = heard.url, name = heard.name))
        }
        val paired = store.phones()
        val ids = paired.map { it.id }.toSet()
        _state.update { s ->
            s.copy(
                phones = paired.map { PhoneState(it, discovered.containsKey(it.id)) },
                nearby = discovered.values.filter { it.id !in ids }.sortedBy { it.name },
            )
        }
    }

    /** Pairs with a PC (its QR) or with another phone (its QR); returns the other side's name. */
    suspend fun pair(text: String): String {
        PeerLink.parse(text)?.let { return pairPhone(it).name }
        val link = Pairing.parse(text) ?: throw Pairing.PairingException("Questo non è un codice QR di WaveDrop.")
        val pc = Pairing.pair(http, store, link)
        links.remove(pc.id)?.disconnect()
        refreshPcs()
        synchronized(this) { if (users.isNotEmpty()) link(pc).connect() }
        return pc.name
    }

    fun removePc(id: String) {
        links.remove(id)?.disconnect()
        store.removePc(id)
        refreshPcs()
    }

    // ───────────── pairing with phones ─────────────

    /** Shows this phone's QR (valid 5 minutes, once). */
    fun showQr() {
        startPeer()
        val secret = peerServer.newQr()
        val ip = Nearby.localIpv4()
        val port = httpServer.port
        val text = PeerLink(secret, store.identity.pk, if (ip != null && port > 0) "$ip:$port" else null, store.name).format()
        _state.update { it.copy(qr = ShownQr(text, System.currentTimeMillis() + PeerServer.QR_TTL_MS)) }
    }

    fun hideQr() {
        peerServer.dropQr()
        _state.update { it.copy(qr = null) }
    }

    /** Scanned another phone's QR: prove it and exchange keys. */
    private suspend fun pairPhone(link: PeerLink): Phone {
        val me = store.identity
        if (Proto.sameBytes(link.pk, me.pk)) throw Pairing.PairingException("Questo è il codice QR di questo telefono: inquadra quello dell'altro.")
        val urls = listOfNotNull(link.base, discovered[link.id]?.url).distinct()
        if (urls.isEmpty()) throw Pairing.PairingException("Non trovo l'altro telefono: siete sulla stessa rete Wi-Fi?")
        val body = JSONObject()
            .put("id", store.id).put("pk", Proto.b64(me.pk)).put("name", store.name).put("platform", "android")
            .put("port", httpServer.port)
            .put("proof", Proto.qrProof(link.secret, "wd-peer-pair", me.pk, link.pk))
        var lastError: Exception? = null
        for (url in urls) {
            val res = try {
                http.postJson("$url/Pair/QR", body)
            } catch (e: IOException) {
                lastError = e
                continue
            }
            if (res.code == 410) throw Pairing.PairingException("Il codice QR è scaduto o è già stato usato: mostrane uno nuovo sull'altro telefono.")
            if (res.code != 200) throw Pairing.PairingException("Abbinamento non riuscito (errore ${res.code}).")
            val j = res.json
            val pk = runCatching { Proto.unb64(j.getString("pk")) }.getOrNull()
            if (pk == null || !Proto.sameBytes(pk, link.pk) || j.optString("proof") != Proto.qrProof(link.secret, "wd-peer-ok", link.pk, me.pk)) {
                throw Pairing.PairingException("L'altro telefono non ha superato la verifica: abbinamento annullato.")
            }
            val phone = Phone(link.id, Proto.b64(pk), j.optString("name").trim().take(40).ifEmpty { link.name ?: "Telefono" }, j.optString("platform").take(16), url, System.currentTimeMillis())
            store.savePhone(phone)
            _state.update { s -> s.copy(requests = s.requests.filter { it.id != phone.id }) }
            refreshPhones()
            return phone
        }
        throw Pairing.PairingException(
            if (lastError != null) "L'altro telefono non risponde: tenete WaveDrop aperto, sulla stessa rete Wi-Fi." else "Abbinamento non riuscito.",
        )
    }

    /** Asks a nearby phone to show its QR code, so this one can scan it. */
    fun requestPair(phone: NearbyPhone) {
        scope.launch {
            runCatching {
                http.postJson(
                    "${phone.url}/Pair/Request",
                    JSONObject().put("id", store.id).put("name", store.name).put("platform", "android").put("port", httpServer.port),
                )
            }
        }
    }

    fun dismissRequest(id: String) {
        Notifier.clear(context, "pair:$id")
        _state.update { s -> s.copy(requests = s.requests.filter { it.id != id }) }
    }

    private fun onPairRequest(id: String, name: String, platform: String) {
        _state.update { s -> s.copy(requests = s.requests.filter { it.id != id } + PairRequest(id, name, platform, System.currentTimeMillis())) }
        Notifier.offer(context, "pair:$id", name, "Vuole abbinarsi: mostragli il tuo codice QR")
    }

    private fun onPaired(peer: PeerInfo, url: String?) {
        val heard = discovered[peer.id]?.url
        store.savePhone(Phone(peer.id, peer.pk, peer.name, peer.platform, heard ?: url.orEmpty(), System.currentTimeMillis()))
        Notifier.clear(context, "pair:${peer.id}")
        _state.update { s -> s.copy(qr = s.qr?.copy(pairedWith = peer.name), requests = s.requests.filter { it.id != peer.id }) }
        refreshPhones()
        _notices.tryEmit("Abbinato con ${peer.name} ✓")
    }

    fun removePhone(id: String) {
        store.removePhone(id)
        refreshPhones()
    }

    // ───────────── transfers ─────────────

    internal fun add(t: Transfer) = _state.update { it.copy(transfers = listOf(t) + it.transfers.take(49)) }

    internal fun update(id: String, f: (Transfer) -> Transfer) = _state.update { s ->
        s.copy(transfers = s.transfers.map { if (it.id == id) f(it) else it })
    }

    fun transfer(id: String) = _state.value.transfers.find { it.id == id }

    fun dismiss(id: String) = _state.update { s -> s.copy(transfers = s.transfers.filter { it.id != id }) }

    fun sendFiles(targetId: String, uris: List<Uri>): String? =
        startSend(targetId, if (uris.size == 1) "un file" else "${uris.size} elementi") { uris.map { Files.describe(context, it) } to null }

    fun sendText(targetId: String, text: String): String? =
        startSend(targetId, "un testo") { emptyList<Item>() to text.take(100_000) }

    private fun startSend(targetId: String, label: String, prepare: suspend () -> Pair<List<Item>, String?>): String? {
        val pc = store.pcs().find { it.id == targetId }
        val phone = if (pc == null) store.phones().find { it.id == targetId } ?: return null else null
        val name = pc?.name ?: phone!!.name
        val id = UUID.randomUUID().toString()
        add(Transfer(id, targetId, name, Dir.OUT, label, 0, Status.PREPARING, note = "Preparazione…"))
        run(id) {
            val (items, text) = prepare()
            if (pc != null) {
                sendSealed(id, pc.url, pc.pkBytes, Receiver(pc.name, false), items, text)
            } else {
                val url = discovered[phone!!.id]?.url ?: phone.url
                if (url.isEmpty()) throw IOException(Receiver(phone.name, true).unreachable)
                sendSealed(id, url, phone.pkBytes, Receiver(phone.name, true), items, text)
            }
        }
        return id
    }

    /** Phone → PC or phone → phone: the same sealed /Ask and /Chunk exchange. */
    private suspend fun sendSealed(id: String, url: String, peerPk: ByteArray, to: Receiver, items: List<Item>, text: String?) {
        val me = store.identity
        val total = items.sumOf { it.size }
        val thumbnail = items.firstOrNull()?.let { Files.thumbnail(context, it) }
        update(id) {
            it.copy(what = describe(items.map { i -> i.name }, text), size = total, status = Status.WAITING, note = to.waiting, thumbnail = thumbnail)
        }
        val request = JSONObject()
            .put("name", store.name)
            .put("platform", "android")
            .put("files", JSONArray(items.map { JSONObject().put("name", it.name).put("size", it.size) }))
            .put("text", text ?: JSONObject.NULL)
            .put("thumbnail", thumbnail ?: JSONObject.NULL)
        val sealed = Proto.askSeal(me.sk, me.pk, peerPk, request)
        val res = try {
            http.postJson("$url/Ask", JSONObject().put("id", store.id).put("e", sealed.e).put("ct", sealed.ct))
        } catch (e: IOException) {
            throw IOException(to.unreachable)
        }
        if (res.code == 401) throw IOException(to.unpaired)
        if (res.code != 200) {
            update(id) { it.copy(status = Status.DECLINED, note = to.declined(res.json.optString("reason"))) }
            return
        }
        val answer = Proto.answerOpen(sealed.k1, me.sk, sealed.ephemeral, res.json.getString("e"), res.json.getString("ct"))
        val session = answer.answer.getString("session")
        val token = answer.answer.getString("token")
        if (items.isEmpty()) {
            update(id) { it.copy(status = Status.DONE, progress = 1f, note = "Testo inviato") }
            return
        }

        update(id) { it.copy(status = Status.SENDING, note = null) }
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
                        val r = http.postBytes("$url/Chunk?s=${enc(session)}&f=$f&c=$c&last=${if (last) 1 else 0}", body)
                        if (r.code == 410) throw RemoteCancelled(to.cancelled)
                        if (r.code != 200) throw IOException("Invio interrotto (errore ${r.code})")
                        sent += len
                        update(id) { it.copy(progress = if (total > 0) sent.toFloat() / total else 1f) }
                    }
                }
            }
            update(id) { it.copy(status = Status.DONE, progress = 1f, note = null) }
        } catch (e: CancellationException) {
            scope.launch { runCatching { http.postJson("$url/Cancel?s=${enc(session)}&t=${enc(token)}", JSONObject()) } }
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

    private fun isPhoneOffer(t: Transfer) = t.dir == Dir.IN && store.pcs().none { it.id == t.peerId }

    fun accept(id: String) {
        val t = transfer(id) ?: return
        update(id) { it.copy(status = Status.RECEIVING, note = "Connessione…") }
        if (isPhoneOffer(t)) {
            Notifier.clear(context, id)
            peerServer.decide(id, true)
            return
        }
        val pc = store.pcs().find { it.id == t.peerId } ?: return
        run(id) { link(pc).accept(id) }
    }

    fun decline(id: String) {
        val t = transfer(id) ?: return
        if (isPhoneOffer(t)) {
            Notifier.clear(context, id)
            peerServer.decide(id, false)
            return
        }
        val pc = store.pcs().find { it.id == t.peerId } ?: return
        scope.launch { link(pc).decline(id) }
    }

    fun cancel(id: String) {
        val t = transfer(id) ?: return
        if (t.status == Status.OFFER) return decline(id)
        update(id) { it.copy(status = Status.CANCELLED, note = if (it.dir == Dir.OUT) "Invio annullato" else "Ricezione annullata") }
        if (isPhoneOffer(t)) peerServer.cancel(id) else jobs[id]?.cancel()
    }

    internal fun remoteCancel(id: String) {
        val t = transfer(id) ?: return
        if (!t.status.active) return
        update(id) { it.copy(status = Status.CANCELLED, note = "Annullato sul PC") }
        jobs[id]?.cancel()
    }

    private fun onPhoneOffer(o: IncomingOffer) {
        val what = describe(o.files.map { it.first }, o.text)
        add(Transfer(o.id, o.peer.id, o.senderName, Dir.IN, what, o.total, Status.OFFER, thumbnail = o.thumbnail, text = o.text))
        Notifier.offer(context, o.id, o.senderName, "Vuole inviarti $what")
    }

    private fun onPhoneFinished(id: String, status: InStatus, saved: List<SavedFile>, note: String?) {
        Notifier.clear(context, id)
        update(id) {
            when (status) {
                InStatus.DONE -> it.copy(status = Status.DONE, progress = 1f, saved = saved, note = if (it.size == 0L) "Ricevuto" else null)
                InStatus.DECLINED -> it.copy(status = Status.DECLINED, note = note ?: "Rifiutato")
                InStatus.CANCELLED -> if (it.status == Status.CANCELLED) it else it.copy(status = Status.CANCELLED, note = note)
                InStatus.FAILED -> it.copy(status = Status.FAILED, note = note ?: "Non riuscito")
                else -> it
            }
        }
    }

    private fun run(id: String, block: suspend () -> Unit) {
        jobs[id] = scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                // status already set by cancel()/remoteCancel()
            } catch (e: RemoteCancelled) {
                update(id) { it.copy(status = Status.CANCELLED, note = e.message) }
            } catch (e: SecurityException) {
                update(id) { it.copy(status = Status.FAILED, note = "WaveDrop non ha il permesso di leggere questo file") }
            } catch (e: Exception) {
                update(id) { if (it.status.active) it.copy(status = Status.FAILED, note = e.message ?: "Non riuscito") else it }
            } finally {
                jobs.remove(id)
            }
        }
    }

    companion object {
        /** Preferred port of this phone's server (any free one otherwise; Bonjour says which). */
        const val PEER_PORT = 47480
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
