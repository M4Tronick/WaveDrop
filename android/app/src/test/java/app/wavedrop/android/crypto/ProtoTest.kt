package app.wavedrop.android.crypto

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Checks the Kotlin port against vectors produced by scripts/make-vectors.js. */
class ProtoTest {
    private val v = JSONObject(javaClass.classLoader!!.getResource("vectors.json")!!.readText())

    private fun hex(s: String) = ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    private fun keys(name: String) = v.getJSONObject(name).let { KeyPair(hex(it.getString("sk")), hex(it.getString("pk"))) }

    private val phone = keys("phone")
    private val pc = keys("pc")
    private val ePhone = keys("ephemeralPhone")
    private val ePc = keys("ephemeralPc")

    @Test fun publicKeysIdsAndSafetyCodes() {
        assertArrayEquals(phone.pk, Proto.publicKeyOf(phone.sk))
        assertArrayEquals(ePc.pk, Proto.publicKeyOf(ePc.sk))
        assertEquals(v.getJSONObject("phone").getString("id"), Proto.deviceId(phone.pk))
        assertEquals(v.getJSONObject("pc").getString("safety"), Proto.safetyCode(pc.pk))
        assertEquals(v.getJSONObject("phone").getString("safety"), Proto.safetyCode(phone.pk))
    }

    @Test fun encodings() {
        assertEquals(v.getJSONObject("b64").getString("text"), Proto.b64(hex(v.getJSONObject("b64").getString("bytes"))))
        assertEquals(v.getJSONObject("lv").getString("hex"), Proto.hex(Proto.lv("ab", hex("0102"))))
        val counts = v.getJSONArray("chunkCount")
        for (i in 0 until counts.length()) {
            val pair = counts.getJSONArray(i)
            assertEquals(pair.getLong(1), Proto.chunkCount(pair.getLong(0)))
        }
    }

    @Test fun pairKeysAndMacs() {
        val link = Proto.pairKey(phone.sk, phone.pk, pc.pk, "link")
        assertEquals(v.getJSONObject("pairKeys").getString("link"), Proto.hex(link))
        assertEquals(v.getJSONObject("pairKeys").getString("presence"), Proto.hex(Proto.pairKey(phone.sk, phone.pk, pc.pk, "presence")))
        // Both sides derive the same key.
        assertArrayEquals(link, Proto.pairKey(pc.sk, pc.pk, phone.pk, "link"))
        val ev = v.getJSONObject("events")
        assertEquals(ev.getString("mac"), Proto.b64(Proto.mac(link, Proto.lv("wd-events", ev.getString("t")))))
        val qr = v.getJSONObject("qr")
        val secret = hex(qr.getString("secret"))
        assertEquals(qr.getString("pairProof"), Proto.qrProof(secret, "wd-mobile-pair", phone.pk, pc.pk))
        assertEquals(qr.getString("okProof"), Proto.qrProof(secret, "wd-mobile-ok", pc.pk, phone.pk))
    }

    @Test fun handshakeKeysMatchJavaScript() {
        val sealed = Proto.askSeal(phone.sk, phone.pk, pc.pk, JSONObject().put("x", 1), ePhone)
        assertEquals(v.getJSONObject("ask").getString("k1"), Proto.hex(sealed.k1))
        val opened = Proto.askOpen(pc.sk, pc.pk, phone.pk, sealed.e, sealed.ct)
        assertEquals(1, opened.request.getInt("x"))
        val answer = Proto.answerSeal(opened.k1, opened.eA, phone.pk, JSONObject().put("accepted", true), ePc)
        assertEquals(v.getJSONObject("session").getString("key"), Proto.hex(answer.key))
        val back = Proto.answerOpen(sealed.k1, phone.sk, sealed.ephemeral, answer.e, answer.ct)
        assertTrue(back.answer.getBoolean("accepted"))
        assertArrayEquals(answer.key, back.key)
        val cancel = v.getJSONObject("cancel")
        assertEquals(cancel.getString("mac"), Proto.b64(Proto.mac(answer.key, Proto.lv("wd-cancel", cancel.getString("offer")))))
    }

    @Test fun opensMessagesSealedByJavaScript() {
        val ask = v.getJSONObject("jsAsk")
        val msg = ask.getJSONObject("msg")
        val opened = Proto.askOpen(phone.sk, phone.pk, pc.pk, msg.getString("e"), msg.getString("ct"))
        assertEquals("PC", opened.request.getString("name"))
        assertEquals("a.txt", opened.request.getJSONArray("files").getJSONObject(0).getString("name"))
        // The PC (sender of jsAsk) opens the answer the JS phone side sealed.
        val eph = v.getJSONObject("jsAskEphemeral")
        val answer = v.getJSONObject("jsAnswer").getJSONObject("msg")
        val back = Proto.answerOpen(hex(eph.getString("k1")), pc.sk, KeyPair(hex(eph.getString("sk")), hex(eph.getString("pk"))), answer.getString("e"), answer.getString("ct"))
        assertEquals("s", back.answer.getString("session"))
    }

    @Test fun chunksAreIdenticalAndTamperProof() {
        val c = v.getJSONObject("chunk")
        val key = hex(v.getJSONObject("session").getString("key"))
        val session = c.getString("session")
        assertEquals(c.getString("nonce"), Proto.hex(Proto.chunkNonce(2, 5)))
        assertEquals(c.getString("aad"), Proto.hex(Proto.chunkAad(session, 2, 5, true)))
        val sealed = Proto.sealChunk(key, session, 2, 5, true, hex(c.getString("plain")))
        assertEquals(c.getString("sealed"), Proto.hex(sealed))
        assertArrayEquals(hex(c.getString("plain")), Proto.openChunk(key, session, 2, 5, true, sealed))
        try {
            Proto.openChunk(key, session, 2, 5, false, sealed) // wrong "last" flag
            fail("tampered chunk accepted")
        } catch (_: Exception) {
        }
        assertFalse(Proto.sameBytes(sealed, Proto.sealChunk(key, session, 2, 6, true, hex(c.getString("plain")))))
    }
}
