package app.wavedrop.android.crypto

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.math.ec.rfc7748.X25519
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64
import kotlin.math.max

/**
 * Kotlin port of src/shared/protocol.js (WaveDrop protocol v2), byte for byte.
 * The phone side only needs QR pairing and the transfer handshake; CPace pairing
 * between PCs is not used here.
 */
class KeyPair(val sk: ByteArray, val pk: ByteArray)

object Proto {
    const val VERSION = 2
    const val CHUNK_SIZE = 1024 * 1024
    const val TAG_SIZE = 16

    private val random = SecureRandom()
    private val ZERO_NONCE = ByteArray(12)

    // ───────────── encoding ─────────────

    fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }
    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun unb64(text: String): ByteArray = Base64.getDecoder().decode(text)
    fun unb64url(text: String): ByteArray = Base64.getUrlDecoder().decode(text.padEnd((text.length + 3) / 4 * 4, '='))
    fun utf8(text: String) = text.toByteArray(Charsets.UTF_8)
    fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun u32(n: Int) = byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
    fun u64(n: Long) = ByteArray(8) { i -> (n ushr (56 - 8 * i)).toByte() }

    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var at = 0
        for (p in parts) {
            p.copyInto(out, at)
            at += p.size
        }
        return out
    }

    /** Length-prefixed concatenation (strings are UTF-8), as in protocol.js `lv`. */
    fun lv(vararg parts: Any): ByteArray = concat(*parts.flatMap { part ->
        val bytes = when (part) {
            is String -> utf8(part)
            is ByteArray -> part
            else -> error("lv: unsupported ${part::class}")
        }
        listOf(u32(bytes.size), bytes)
    }.toTypedArray())

    fun sameBytes(a: ByteArray?, b: ByteArray?): Boolean {
        if (a == null || b == null || a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }

    // ───────────── primitives ─────────────

    fun sha256(vararg parts: ByteArray): ByteArray {
        val d = SHA256Digest()
        for (p in parts) d.update(p, 0, p.size)
        return ByteArray(32).also { d.doFinal(it, 0) }
    }

    fun mac(key: ByteArray, data: ByteArray): ByteArray {
        val h = HMac(SHA256Digest())
        h.init(KeyParameter(key))
        h.update(data, 0, data.size)
        return ByteArray(32).also { h.doFinal(it, 0) }
    }

    fun kdf(ikm: ByteArray, salt: ByteArray, info: String, length: Int = 32): ByteArray {
        val g = HKDFBytesGenerator(SHA256Digest())
        g.init(HKDFParameters(ikm, salt, utf8(info)))
        return ByteArray(length).also { g.generateBytes(it, 0, length) }
    }

    private fun aead(encrypt: Boolean, key: ByteArray, nonce: ByteArray, input: ByteArray, len: Int, aad: ByteArray): ByteArray {
        val c = ChaCha20Poly1305()
        c.init(encrypt, AEADParameters(KeyParameter(key), TAG_SIZE * 8, nonce, aad))
        val out = ByteArray(c.getOutputSize(len))
        var n = c.processBytes(input, 0, len, out, 0)
        n += c.doFinal(out, n) // throws InvalidCipherTextException when tampered
        return if (n == out.size) out else out.copyOf(n)
    }

    fun seal(key: ByteArray, nonce: ByteArray, plain: ByteArray, aad: ByteArray, len: Int = plain.size) =
        aead(true, key, nonce, plain, len, aad)

    fun open(key: ByteArray, nonce: ByteArray, sealed: ByteArray, aad: ByteArray) =
        aead(false, key, nonce, sealed, sealed.size, aad)

    fun sealJson(key: ByteArray, label: String, value: JSONObject): String =
        b64(seal(key, ZERO_NONCE, utf8(value.toString()), utf8(label)))

    fun openJson(key: ByteArray, label: String, data: String): JSONObject =
        JSONObject(String(open(key, ZERO_NONCE, unb64(data), utf8(label)), Charsets.UTF_8))

    // ───────────── identity ─────────────

    fun publicKeyOf(sk: ByteArray) = ByteArray(32).also { X25519.scalarMultBase(sk, 0, it, 0) }

    fun newKeyPair(): KeyPair {
        val sk = randomBytes(32)
        return KeyPair(sk, publicKeyOf(sk))
    }

    fun dh(sk: ByteArray, pk: ByteArray): ByteArray {
        val out = ByteArray(32)
        require(pk.size == 32 && X25519.calculateAgreement(sk, 0, pk, 0, out, 0)) { "invalid public key" }
        return out
    }

    fun deviceId(pk: ByteArray) = hex(sha256(utf8("wavedrop-id"), pk).copyOf(10))

    /** 12 digits both people can compare ("codice di sicurezza"). */
    fun safetyCode(pk: ByteArray): String {
        val h = sha256(utf8("wavedrop-safety"), pk)
        val digits = StringBuilder()
        var i = 0
        while (digits.length < 12) {
            val v = (((h[i].toInt() and 0xff) shl 8) or (h[i + 1].toInt() and 0xff)) % 1000
            digits.append(v.toString().padStart(3, '0'))
            i += 2
        }
        val d = digits.substring(0, 12)
        return "${d.substring(0, 4)} ${d.substring(4, 8)} ${d.substring(8, 12)}"
    }

    private fun sortedPair(a: ByteArray, b: ByteArray): Pair<ByteArray, ByteArray> {
        for (i in a.indices) {
            val x = a[i].toInt() and 0xff
            val y = b[i].toInt() and 0xff
            if (x != y) return if (x < y) a to b else b to a
        }
        return a to b
    }

    /** Long-term key shared by two paired devices (both sides compute the same). */
    fun pairKey(sk: ByteArray, myPk: ByteArray, otherPk: ByteArray, purpose: String): ByteArray {
        val (lo, hi) = sortedPair(myPk, otherPk)
        return kdf(dh(sk, otherPk), concat(lo, hi), "wavedrop $purpose v$VERSION")
    }

    fun qrProof(secret: ByteArray, label: String, a: ByteArray, b: ByteArray) = b64(mac(secret, lv(label, a, b)))

    // ───────────── transfer handshake ─────────────

    class Sealed(val ephemeral: KeyPair, val k1: ByteArray, val e: String, val ct: String)
    class Opened(val eA: ByteArray, val k1: ByteArray, val request: JSONObject)
    class Answer(val key: ByteArray, val e: String, val ct: String)
    class AnswerOpened(val key: ByteArray, val answer: JSONObject)

    /** Sender → receiver: seal the request (file list, thumbnail, text…). */
    fun askSeal(sk: ByteArray, pk: ByteArray, peerPk: ByteArray, request: JSONObject, e: KeyPair = newKeyPair()): Sealed {
        val salt = sha256(lv("wd-ask", pk, peerPk, e.pk))
        val k1 = kdf(concat(dh(e.sk, peerPk), dh(sk, peerPk)), salt, "wavedrop ask")
        return Sealed(e, k1, b64(e.pk), sealJson(k1, "wd-ask", request))
    }

    /** Receiver: open a request with the sender's pinned public key. */
    fun askOpen(sk: ByteArray, pk: ByteArray, peerPk: ByteArray, e: String, ct: String): Opened {
        val eA = unb64(e)
        val salt = sha256(lv("wd-ask", peerPk, pk, eA))
        val k1 = kdf(concat(dh(sk, eA), dh(sk, peerPk)), salt, "wavedrop ask")
        return Opened(eA, k1, openJson(k1, "wd-ask", ct))
    }

    private fun sessionKey(dhEE: ByteArray, dhES: ByteArray, k1: ByteArray, eA: ByteArray, eB: ByteArray) =
        kdf(concat(dhEE, dhES, k1), sha256(lv("wd-session", eA, eB)), "wavedrop session")

    /** Receiver → sender: answer, adding a fresh ephemeral key (forward secrecy). */
    fun answerSeal(k1: ByteArray, eA: ByteArray, peerPk: ByteArray, answer: JSONObject, e: KeyPair = newKeyPair()): Answer {
        val key = sessionKey(dh(e.sk, eA), dh(e.sk, peerPk), k1, eA, e.pk)
        return Answer(key, b64(e.pk), sealJson(key, "wd-answer", answer))
    }

    fun answerOpen(k1: ByteArray, sk: ByteArray, e: KeyPair, eB64: String, ct: String): AnswerOpened {
        val eB = unb64(eB64)
        val key = sessionKey(dh(e.sk, eB), dh(sk, eB), k1, e.pk, eB)
        return AnswerOpened(key, openJson(key, "wd-answer", ct))
    }

    // ───────────── file chunks ─────────────

    fun chunkNonce(file: Int, index: Long) = concat(u32(file), u64(index))

    fun chunkAad(session: String, file: Int, index: Long, last: Boolean) =
        concat(utf8("wd-chunk"), lv(session), u32(file), u64(index), byteArrayOf(if (last) 1 else 0))

    fun sealChunk(key: ByteArray, session: String, file: Int, index: Long, last: Boolean, data: ByteArray, len: Int = data.size) =
        seal(key, chunkNonce(file, index), data, chunkAad(session, file, index, last), len)

    fun openChunk(key: ByteArray, session: String, file: Int, index: Long, last: Boolean, data: ByteArray) =
        open(key, chunkNonce(file, index), data, chunkAad(session, file, index, last))

    fun chunkCount(size: Long): Long = max(1L, (size + CHUNK_SIZE - 1) / CHUNK_SIZE)
}
