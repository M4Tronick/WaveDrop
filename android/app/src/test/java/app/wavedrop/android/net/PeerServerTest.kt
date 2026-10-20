package app.wavedrop.android.net

import app.wavedrop.android.crypto.KeyPair
import app.wavedrop.android.crypto.Proto
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * The phone-to-phone server, end to end over real HTTP and the real
 * protocol: what a second phone (Android or iPhone) does is played here by a
 * small client written with Proto, the same calls the app's send path makes.
 */
class PeerServerTest {
    private val receiver = Proto.newKeyPair() // the phone running the server
    private val sender = Proto.newKeyPair() // the phone sending
    private val senderId = Proto.deviceId(sender.pk)
    private lateinit var dir: File
    private lateinit var host: FakeHost
    private lateinit var peer: PeerServer<File>
    private lateinit var server: MiniHttpServer
    private lateinit var base: String
    private val http = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()
    private val json = "application/json".toMediaType()
    private val bytes = "application/octet-stream".toMediaType()

    inner class FakeHost : PeerHost<File> {
        override val identity: KeyPair get() = receiver
        val peers = mutableMapOf<String, PeerInfo>()
        val pairedWith = CopyOnWriteArrayList<Pair<PeerInfo, String?>>()
        val requests = CopyOnWriteArrayList<String>()
        val offers = CopyOnWriteArrayList<IncomingOffer>()
        val finished = CompletableFuture<Triple<InStatus, List<File>, String?>>()
        var visible = true
        var onOffer: (IncomingOffer) -> Unit = {}

        override fun name() = "Telefono di Anna"
        override fun platform() = "android"
        override fun port() = server.port
        override fun receiving() = visible
        override fun peer(id: String) = peers[id]
        override fun paired(peer: PeerInfo, url: String?) {
            peers[peer.id] = peer
            pairedWith += peer to url
        }
        override fun pairRequest(id: String, name: String, platform: String, url: String?) {
            requests += "$id $name $platform $url"
        }
        override fun offer(offer: IncomingOffer) {
            offers += offer
            onOffer(offer)
        }
        override fun progress(id: String, received: Long, total: Long) {}
        override fun finished(id: String, status: InStatus, saved: List<File>, note: String?) {
            finished.complete(Triple(status, saved, note))
        }
        override fun sink(name: String, size: Long): FileSink<File> {
            val file = File(dir, name)
            val out = file.outputStream()
            return object : FileSink<File> {
                override val output = out
                override fun finish(size: Long): File {
                    out.close()
                    return file
                }
                override fun discard() {
                    out.close()
                    file.delete()
                }
            }
        }
    }

    @Before fun setUp() {
        dir = createTempDir()
        host = FakeHost()
        peer = PeerServer(host)
        server = MiniHttpServer(peer)
        base = "http://127.0.0.1:${server.start(0)}"
    }

    @After fun tearDown() {
        server.stop()
        peer.close()
        dir.deleteRecursively()
    }

    private fun createTempDir(): File = File.createTempFile("wavedrop", "").let { it.delete(); it.mkdirs(); it }

    private fun post(path: String, body: JSONObject): Pair<Int, JSONObject> =
        http.newCall(Request.Builder().url(base + path).post(body.toString().toRequestBody(json)).build()).execute().use {
            it.code to runCatching { JSONObject(it.body.string()) }.getOrDefault(JSONObject())
        }

    private fun postBytes(path: String, body: ByteArray): Int =
        http.newCall(Request.Builder().url(base + path).post(body.toRequestBody(bytes)).build()).execute().use { it.code }

    private fun pairSender() {
        host.peers[senderId] = PeerInfo(senderId, Proto.b64(sender.pk), "Telefono di Bruno", "ios")
    }

    // ───────────── pairing ─────────────

    @Test fun pairsWithTheQrSecretOnce() {
        val secret = peer.newQr()
        val link = PeerLink(secret, receiver.pk, "127.0.0.1:${server.port}", "Telefono di Anna")
        val parsed = PeerLink.parse(link.format())!!
        assertArrayEquals(secret, parsed.secret)
        assertEquals("Telefono di Anna", parsed.name)

        val body = JSONObject().put("id", senderId).put("pk", Proto.b64(sender.pk)).put("name", "Telefono di Bruno")
            .put("platform", "ios").put("port", 47480)
            .put("proof", Proto.qrProof(secret, "wd-peer-pair", sender.pk, receiver.pk))
        val (code, res) = post("/Pair/QR", body)
        assertEquals(200, code)
        assertEquals(Proto.b64(receiver.pk), res.getString("pk"))
        assertEquals(Proto.qrProof(secret, "wd-peer-ok", receiver.pk, sender.pk), res.getString("proof"))
        assertEquals("Telefono di Bruno", host.pairedWith.single().first.name)
        assertEquals("http://127.0.0.1:47480", host.pairedWith.single().second)
        // One pairing per QR.
        assertEquals(410, post("/Pair/QR", body).first)
    }

    @Test fun wrongProofsBurnTheQr() {
        val secret = peer.newQr()
        val bad = JSONObject().put("id", senderId).put("pk", Proto.b64(sender.pk))
            .put("proof", Proto.qrProof(Proto.randomBytes(16), "wd-peer-pair", sender.pk, receiver.pk))
        repeat(3) { assertEquals(403, post("/Pair/QR", bad).first) }
        val good = JSONObject(bad.toString()).put("proof", Proto.qrProof(secret, "wd-peer-pair", sender.pk, receiver.pk))
        assertEquals(410, post("/Pair/QR", good).first)
        assertTrue(host.pairedWith.isEmpty())
    }

    @Test fun refusesAKeyThatIsNotTheId() {
        val secret = peer.newQr()
        val other = Proto.newKeyPair()
        val body = JSONObject().put("id", Proto.deviceId(other.pk)).put("pk", Proto.b64(sender.pk))
            .put("proof", Proto.qrProof(secret, "wd-peer-pair", sender.pk, receiver.pk))
        assertEquals(400, post("/Pair/QR", body).first)
    }

    @Test fun pairRequestsAreRateLimited() {
        val body = JSONObject().put("id", senderId).put("name", "Telefono di Bruno").put("platform", "ios").put("port", 1234)
        assertEquals(202, post("/Pair/Request", body).first)
        assertEquals(429, post("/Pair/Request", body).first)
        assertEquals("$senderId Telefono di Bruno ios http://127.0.0.1:1234", host.requests.single())
        assertEquals(400, post("/Pair/Request", JSONObject().put("id", "not-an-id")).first)
    }

    @Test fun helloSaysWhoThisIs() {
        val res = http.newCall(Request.Builder().url("$base/Hello").build()).execute().use { JSONObject(it.body.string()) }
        assertEquals(Proto.deviceId(receiver.pk), res.getString("id"))
        assertEquals("Telefono di Anna", res.getString("name"))
        assertEquals(server.port, res.getInt("port"))
    }

    // ───────────── transfers ─────────────

    private class Session(val key: ByteArray, val session: String, val token: String)

    private fun ask(files: List<Pair<String, Long>>, text: String? = null): Pair<Int, Any> {
        val request = JSONObject().put("name", "Telefono di Bruno").put("platform", "ios")
            .put("files", JSONArray(files.map { JSONObject().put("name", it.first).put("size", it.second) }))
            .put("text", text ?: JSONObject.NULL).put("thumbnail", JSONObject.NULL)
        val sealed = Proto.askSeal(sender.sk, sender.pk, receiver.pk, request)
        val (code, res) = post("/Ask", JSONObject().put("id", senderId).put("e", sealed.e).put("ct", sealed.ct))
        if (code != 200) return code to res
        val opened = Proto.answerOpen(sealed.k1, sender.sk, sealed.ephemeral, res.getString("e"), res.getString("ct"))
        assertTrue(opened.answer.getBoolean("accepted"))
        return code to Session(opened.key, opened.answer.getString("session"), opened.answer.getString("token"))
    }

    private fun upload(s: Session, f: Int, data: ByteArray): Int {
        val count = Proto.chunkCount(data.size.toLong())
        for (c in 0 until count) {
            val last = c == count - 1
            val from = (c * Proto.CHUNK_SIZE).toInt()
            val part = data.copyOfRange(from, minOf(data.size, from + Proto.CHUNK_SIZE))
            val code = postBytes("/Chunk?s=${s.session}&f=$f&c=$c&last=${if (last) 1 else 0}", Proto.sealChunk(s.key, s.session, f, c, last, part))
            if (code != 200) return code
        }
        return 200
    }

    @Test fun receivesFilesOnceAccepted() {
        pairSender()
        host.onOffer = { o -> peer.decide(o.id, true) }
        val big = ByteArray(2 * Proto.CHUNK_SIZE + 12345) { (it * 31).toByte() }
        val (code, s) = ask(listOf("foto.jpg" to big.size.toLong(), "vuoto.txt" to 0L))
        assertEquals(200, code)
        s as Session
        assertEquals("Telefono di Bruno", host.offers.single().senderName)
        assertEquals(big.size.toLong(), host.offers.single().total)
        assertEquals(200, upload(s, 0, big))
        assertFalse(host.finished.isDone)
        assertEquals(200, upload(s, 1, ByteArray(0)))
        val (status, saved, _) = host.finished.get(5, TimeUnit.SECONDS)
        assertEquals(InStatus.DONE, status)
        assertEquals(listOf("foto.jpg", "vuoto.txt"), saved.map { it.name })
        assertArrayEquals(big, saved[0].readBytes())
        assertEquals(0L, saved[1].length())
        // Finished: further chunks are refused.
        assertEquals(410, postBytes("/Chunk?s=${s.session}&f=0&c=0&last=0", ByteArray(32)))
    }

    @Test fun textNeedsOnlyTheAnswer() {
        pairSender()
        host.onOffer = { o -> peer.decide(o.id, true) }
        val (code, _) = ask(emptyList(), text = "https://example.com/")
        assertEquals(200, code)
        assertEquals("https://example.com/", host.offers.single().text)
        assertEquals(InStatus.DONE, host.finished.get(5, TimeUnit.SECONDS).first)
    }

    @Test fun declinedOffersSayWhy() {
        pairSender()
        host.onOffer = { o -> peer.decide(o.id, false) }
        val (code, res) = ask(listOf("a.txt" to 1L))
        assertEquals(403, code)
        assertEquals("declined", (res as JSONObject).getString("reason"))
        assertEquals(InStatus.DECLINED, host.finished.get(5, TimeUnit.SECONDS).first)
    }

    @Test fun strangersAndHiddenPhonesGetNothing() {
        assertEquals(401, ask(listOf("a.txt" to 1L)).first)
        pairSender()
        host.visible = false
        assertEquals(403, ask(listOf("a.txt" to 1L)).first)
        assertTrue(host.offers.isEmpty())
    }

    @Test fun aRequestSealedForSomeoneElseIsRefused() {
        pairSender()
        val stranger = Proto.newKeyPair() // claims the paired phone's id, holds another key
        val sealed = Proto.askSeal(stranger.sk, stranger.pk, receiver.pk, JSONObject().put("files", JSONArray()).put("text", "ciao"))
        val (code, res) = post("/Ask", JSONObject().put("id", senderId).put("e", sealed.e).put("ct", sealed.ct))
        assertEquals(401, code)
        assertEquals("auth", res.getString("reason"))
    }

    @Test fun aTamperedChunkStopsTheTransfer() {
        pairSender()
        host.onOffer = { o -> peer.decide(o.id, true) }
        val s = ask(listOf("a.bin" to 100L)).second as Session
        val sealed = Proto.sealChunk(s.key, s.session, 0, 0, true, ByteArray(100))
        sealed[5] = (sealed[5].toInt() xor 1).toByte()
        assertEquals(400, postBytes("/Chunk?s=${s.session}&f=0&c=0&last=1", sealed))
        val (status, saved, _) = host.finished.get(5, TimeUnit.SECONDS)
        assertEquals(InStatus.FAILED, status)
        assertTrue(saved.isEmpty())
        assertTrue(dir.listFiles()!!.isEmpty())
    }

    @Test fun chunksMustComeInOrder() {
        pairSender()
        host.onOffer = { o -> peer.decide(o.id, true) }
        val s = ask(listOf("a.bin" to (Proto.CHUNK_SIZE + 1L))).second as Session
        val second = Proto.sealChunk(s.key, s.session, 0, 1, true, ByteArray(1))
        assertEquals(409, postBytes("/Chunk?s=${s.session}&f=0&c=1&last=1", second))
        // Wrong "last" flag for the first chunk.
        val first = Proto.sealChunk(s.key, s.session, 0, 0, true, ByteArray(Proto.CHUNK_SIZE))
        assertEquals(400, postBytes("/Chunk?s=${s.session}&f=0&c=0&last=1", first))
    }

    @Test fun theSenderCanCancel() {
        pairSender()
        host.onOffer = { o -> peer.decide(o.id, true) }
        val s = ask(listOf("a.bin" to (Proto.CHUNK_SIZE + 1L))).second as Session
        assertEquals(200, postBytes("/Chunk?s=${s.session}&f=0&c=0&last=0", Proto.sealChunk(s.key, s.session, 0, 0, false, ByteArray(Proto.CHUNK_SIZE))))
        assertEquals(401, post("/Cancel?s=${s.session}&t=wrong", JSONObject()).first)
        assertEquals(200, post("/Cancel?s=${s.session}&t=${s.token}", JSONObject()).first)
        val (status, _, note) = host.finished.get(5, TimeUnit.SECONDS)
        assertEquals(InStatus.CANCELLED, status)
        assertEquals("Telefono di Bruno ha annullato l'invio", note)
        assertEquals(410, postBytes("/Chunk?s=${s.session}&f=0&c=1&last=1", Proto.sealChunk(s.key, s.session, 0, 1, true, ByteArray(1))))
        assertTrue(dir.listFiles()!!.isEmpty()) // the partial file is gone
    }

    @Test fun theReceiverCanCancelMidway() {
        pairSender()
        host.onOffer = { o -> peer.decide(o.id, true) }
        val s = ask(listOf("a.bin" to (Proto.CHUNK_SIZE + 1L))).second as Session
        assertEquals(200, postBytes("/Chunk?s=${s.session}&f=0&c=0&last=0", Proto.sealChunk(s.key, s.session, 0, 0, false, ByteArray(Proto.CHUNK_SIZE))))
        peer.cancel(s.session)
        assertEquals(InStatus.CANCELLED, host.finished.get(5, TimeUnit.SECONDS).first)
        assertEquals(410, postBytes("/Chunk?s=${s.session}&f=0&c=1&last=1", Proto.sealChunk(s.key, s.session, 0, 1, true, ByteArray(1))))
    }

    @Test fun aSenderThatHangsUpWithdrawsTheOffer() {
        pairSender()
        val offered = CompletableFuture<IncomingOffer>()
        host.onOffer = { offered.complete(it) }
        val sealed = Proto.askSeal(sender.sk, sender.pk, receiver.pk, JSONObject().put("files", JSONArray()).put("text", "ciao"))
        val call = http.newCall(
            Request.Builder().url("$base/Ask")
                .post(JSONObject().put("id", senderId).put("e", sealed.e).put("ct", sealed.ct).toString().toRequestBody(json)).build(),
        )
        val response = CompletableFuture.supplyAsync { runCatching { call.execute().use { it.code } }.getOrNull() }
        assertNotNull(offered.get(5, TimeUnit.SECONDS))
        call.cancel()
        assertNull(response.get(5, TimeUnit.SECONDS))
        val (status, _, note) = host.finished.get(5, TimeUnit.SECONDS)
        assertEquals(InStatus.CANCELLED, status)
        assertEquals("Telefono di Bruno ha annullato l'invio", note)
    }

    @Test fun keepAliveServesSeveralRequestsOnOneConnection() {
        val out = ByteArrayOutputStream()
        java.net.Socket("127.0.0.1", server.port).use { socket ->
            val req = "GET /Hello HTTP/1.1\r\nHost: x\r\n\r\nGET /Nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
            socket.getOutputStream().write(req.toByteArray())
            try {
                socket.getInputStream().copyTo(out)
            } catch (e: IOException) {
            }
        }
        val text = out.toString(Charsets.UTF_8)
        assertTrue(text.startsWith("HTTP/1.1 200 OK"))
        assertTrue(text.contains("HTTP/1.1 404 Not Found"))
    }

    @Test fun peerLinksRejectJunk() {
        assertNull(PeerLink.parse("http://192.168.1.2:47480/m/#k=abc&p=def")) // a PC's QR is not a phone's
        assertNull(PeerLink.parse("wavedrop://peer?k=AAAA&p=BBBB"))
        val link = PeerLink(Proto.randomBytes(16), Proto.newKeyPair().pk, "10.0.0.5:47480; rm -rf", null)
        assertNull(PeerLink.parse(link.format())!!.address)
    }
}
