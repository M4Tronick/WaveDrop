import Foundation
import XCTest
@testable import WaveDropKit

/// Checks the Swift port against vectors produced by scripts/make-vectors.js
/// (the same file the Android tests use).
final class ProtoTests: XCTestCase {
    var v: [String: Any] = [:]

    override func setUpWithError() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "vectors", withExtension: "json"))
        v = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func obj(_ key: String) -> [String: Any] { v[key] as! [String: Any] }
    private func str(_ key: String, _ field: String) -> String { obj(key)[field] as! String }

    private func hex(_ s: String) -> Data {
        var out = Data()
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    private func keys(_ name: String) -> KeyPair { KeyPair(sk: hex(str(name, "sk")), pk: hex(str(name, "pk"))) }

    func testPublicKeysIdsAndSafetyCodes() throws {
        let phone = keys("phone"), pc = keys("pc")
        XCTAssertEqual(try Proto.publicKey(of: phone.sk), phone.pk)
        XCTAssertEqual(try Proto.publicKey(of: keys("ephemeralPc").sk), keys("ephemeralPc").pk)
        XCTAssertEqual(Proto.deviceId(phone.pk), str("phone", "id"))
        XCTAssertEqual(Proto.safetyCode(pc.pk), str("pc", "safety"))
        XCTAssertEqual(Proto.safetyCode(phone.pk), str("phone", "safety"))
    }

    func testEncodings() throws {
        XCTAssertEqual(Proto.b64(hex(str("b64", "bytes"))), str("b64", "text"))
        XCTAssertEqual(Proto.hex(Proto.lv("ab", hex("0102"))), str("lv", "hex"))
        for pair in v["chunkCount"] as! [[Int]] {
            XCTAssertEqual(Proto.chunkCount(pair[0]), pair[1])
        }
    }

    func testPairKeysAndMacs() throws {
        let phone = keys("phone"), pc = keys("pc")
        let link = try Proto.pairKey(phone.sk, myPk: phone.pk, otherPk: pc.pk, purpose: "link")
        XCTAssertEqual(Proto.hex(link), str("pairKeys", "link"))
        XCTAssertEqual(Proto.hex(try Proto.pairKey(phone.sk, myPk: phone.pk, otherPk: pc.pk, purpose: "presence")), str("pairKeys", "presence"))
        XCTAssertEqual(link, try Proto.pairKey(pc.sk, myPk: pc.pk, otherPk: phone.pk, purpose: "link"))
        XCTAssertEqual(Proto.b64(Proto.mac(link, Proto.lv("wd-events", str("events", "t")))), str("events", "mac"))
        let secret = hex(str("qr", "secret"))
        XCTAssertEqual(Proto.qrProof(secret, "wd-mobile-pair", phone.pk, pc.pk), str("qr", "pairProof"))
        XCTAssertEqual(Proto.qrProof(secret, "wd-mobile-ok", pc.pk, phone.pk), str("qr", "okProof"))
    }

    func testHandshakeKeysMatchJavaScript() throws {
        let phone = keys("phone"), pc = keys("pc")
        let sealed = try Proto.askSeal(sk: phone.sk, pk: phone.pk, peerPk: pc.pk, request: ["x": 1], ephemeral: keys("ephemeralPhone"))
        XCTAssertEqual(Proto.hex(sealed.k1), str("ask", "k1"))
        let opened = try Proto.askOpen(sk: pc.sk, pk: pc.pk, peerPk: phone.pk, e: sealed.e, ct: sealed.ct)
        XCTAssertEqual(opened.request["x"] as? Int, 1)
        let answer = try Proto.answerSeal(k1: opened.k1, eA: opened.eA, peerPk: phone.pk, answer: ["accepted": true], ephemeral: keys("ephemeralPc"))
        XCTAssertEqual(Proto.hex(answer.key), str("session", "key"))
        let back = try Proto.answerOpen(k1: sealed.k1, sk: phone.sk, ephemeral: sealed.ephemeral, e: answer.e, ct: answer.ct)
        XCTAssertEqual(back.answer["accepted"] as? Bool, true)
        XCTAssertEqual(back.key, answer.key)
        XCTAssertEqual(Proto.b64(Proto.mac(answer.key, Proto.lv("wd-cancel", str("cancel", "offer")))), str("cancel", "mac"))
    }

    func testOpensMessagesSealedByJavaScript() throws {
        let phone = keys("phone"), pc = keys("pc")
        let msg = obj("jsAsk")["msg"] as! [String: Any]
        let opened = try Proto.askOpen(sk: phone.sk, pk: phone.pk, peerPk: pc.pk, e: msg["e"] as! String, ct: msg["ct"] as! String)
        XCTAssertEqual(opened.request["name"] as? String, "PC")
        let eph = obj("jsAskEphemeral")
        let answer = obj("jsAnswer")["msg"] as! [String: Any]
        let back = try Proto.answerOpen(
            k1: hex(eph["k1"] as! String), sk: pc.sk,
            ephemeral: KeyPair(sk: hex(eph["sk"] as! String), pk: hex(eph["pk"] as! String)),
            e: answer["e"] as! String, ct: answer["ct"] as! String
        )
        XCTAssertEqual(back.answer["session"] as? String, "s")
    }

    func testChunksAreIdenticalAndTamperProof() throws {
        let c = obj("chunk")
        let key = hex(str("session", "key"))
        let session = c["session"] as! String
        let plain = hex(c["plain"] as! String)
        XCTAssertEqual(Proto.hex(Proto.chunkNonce(file: 2, index: 5)), c["nonce"] as? String)
        XCTAssertEqual(Proto.hex(Proto.chunkAad(session: session, file: 2, index: 5, last: true)), c["aad"] as? String)
        let sealed = try Proto.sealChunk(key, session: session, file: 2, index: 5, last: true, plain)
        XCTAssertEqual(Proto.hex(sealed), c["sealed"] as? String)
        XCTAssertEqual(try Proto.openChunk(key, session: session, file: 2, index: 5, last: true, sealed), plain)
        XCTAssertThrowsError(try Proto.openChunk(key, session: session, file: 2, index: 5, last: false, sealed))
    }

    func testPairingLinkAndWording() throws {
        let link = try XCTUnwrap(PairingLink("http://192.168.1.20:47480/m/#k=tn49vhQ9SprMHsja07uFBg&p=xyNNl1gZZuhCOeLjnAQXxE4a99ha4LWgHaJWZKA3tDc"))
        XCTAssertEqual(link.base, "http://192.168.1.20:47480")
        XCTAssertEqual(link.secret.count, 16)
        XCTAssertEqual(link.pcPk.count, 32)
        let wrapped = "wavedrop://pair?u=" + "http://192.168.1.20:47480/m/#k=tn49vhQ9SprMHsja07uFBg&p=xyNNl1gZZuhCOeLjnAQXxE4a99ha4LWgHaJWZKA3tDc"
            .addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        XCTAssertEqual(PairingLink(wrapped)?.base, "http://192.168.1.20:47480")
        XCTAssertNil(PairingLink("https://example.com"))
        XCTAssertEqual(describePayload(names: ["foto.jpg"], text: nil), "«foto.jpg»")
        XCTAssertEqual(describePayload(names: ["Foto/a.jpg", "Foto/b.jpg"], text: nil), "la cartella «Foto»")
        XCTAssertEqual(describePayload(names: [], text: "ciao"), "un testo")
    }
}
