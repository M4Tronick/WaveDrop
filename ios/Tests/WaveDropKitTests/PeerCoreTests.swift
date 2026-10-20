import Foundation
import XCTest
@testable import WaveDropKit

/// The phone-to-phone core, driven the way a second phone (Android or iPhone)
/// drives it: real keys, real sealed requests and chunks, requests built as the
/// socket layer builds them.
final class FakeHost: PeerHost, @unchecked Sendable {
    typealias Saved = URL

    var peers: [String: PeerInfo] = [:]
    var pairedWith: [(PeerInfo, String?)] = []
    var requests: [String] = []
    var offers: [IncomingOffer] = []
    var finished: (InStatus, [URL], String?)?
    var receiving = true
    var decision: Bool?
    weak var core: PeerCore<FakeHost>?
    let dest: URL

    init(dest: URL) { self.dest = dest }

    func me() async -> (name: String, platform: String, port: Int, receiving: Bool) { ("iPhone di Anna", "ios", 47480, receiving) }
    func peer(_ id: String) async -> PeerInfo? { peers[id] }
    func paired(_ peer: PeerInfo, url: String?) async {
        peers[peer.id] = peer
        pairedWith.append((peer, url))
    }
    func pairRequest(id: String, name: String, platform: String, url: String?) async {
        requests.append("\(id) \(name) \(platform) \(url ?? "-")")
    }
    func offer(_ offer: IncomingOffer) async {
        offers.append(offer)
        if let decision, let core {
            Task { await core.decide(offer.id, accept: decision) }
        }
    }
    func progress(id: String, received: Int, total: Int) async {}
    func finished(id: String, status: InStatus, saved: [URL], note: String?) async { finished = (status, saved, note) }
    func keep(_ part: URL, name: String, size: Int) async throws -> URL {
        let target = dest.appendingPathComponent(name)
        try FileManager.default.moveItem(at: part, to: target)
        return target
    }
}

final class PeerCoreTests: XCTestCase {
    let receiver = Proto.newKeyPair()
    let sender = Proto.newKeyPair()
    var senderId: String { Proto.deviceId(sender.pk) }
    var dir: URL!
    var host: FakeHost!
    var core: PeerCore<FakeHost>!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        host = FakeHost(dest: dir)
        core = PeerCore(identity: receiver, host: host, temp: dir.appendingPathComponent("tmp"))
        host.core = core
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private let stillThere: @Sendable () async -> Bool = { false }

    private func post(_ path: String, _ json: [String: Any], remote: String = "192.168.1.7") async -> (Int, [String: Any]) {
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        var query: [String: String] = [:]
        if parts.count == 2 {
            for pair in parts[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                query[kv[0]] = kv.count > 1 ? kv[1] : ""
            }
        }
        let body = try! JSONSerialization.data(withJSONObject: json)
        let req = HTTPRequest(method: "POST", path: parts[0], query: query, body: body, remoteAddress: remote)
        guard let res = await core.handle(req, clientGone: stillThere) else { return (0, [:]) }
        return (res.status, (try? JSONSerialization.jsonObject(with: res.body) as? [String: Any]) ?? [:])
    }

    private func chunk(_ session: String, _ f: Int, _ c: Int, _ last: Bool, _ body: Data) async -> Int {
        let req = HTTPRequest(method: "POST", path: "/Chunk", query: ["s": session, "f": "\(f)", "c": "\(c)", "last": last ? "1" : "0"], body: body)
        return await core.handle(req, clientGone: stillThere)?.status ?? 0
    }

    private func pairSender() {
        host.peers[senderId] = PeerInfo(id: senderId, pk: Proto.b64(sender.pk), name: "Pixel di Bruno", platform: "android")
    }

    // MARK: wire format

    func testParsesRequestHeads() throws {
        let raw = Data("POST /Chunk?s=ab%2Dc&f=0&c=1&last=1 HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".utf8)
        let head = try XCTUnwrap(try HTTPWire.parseHead(raw))
        XCTAssertEqual(head.method, "POST")
        XCTAssertEqual(head.path, "/Chunk")
        XCTAssertEqual(head.query["s"], "ab-c")
        XCTAssertEqual(head.query["last"], "1")
        XCTAssertEqual(head.contentLength, 5)
        XCTAssertEqual(head.headers["connection"], "close")
        XCTAssertEqual(raw.count - head.headLength, 5)
        XCTAssertNil(try HTTPWire.parseHead(Data("GET / HTTP/1.1\r\nHost:".utf8)))
        XCTAssertThrowsError(try HTTPWire.parseHead(Data("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)))
        XCTAssertThrowsError(try HTTPWire.parseHead(Data("POST / HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n".utf8)))
        let out = String(decoding: HTTPResponse.json(404).serialized(close: true), as: UTF8.self)
        XCTAssertTrue(out.hasPrefix("HTTP/1.1 404 Not Found\r\n"))
        XCTAssertTrue(out.contains("Content-Length: 2\r\n"))
    }

    func testPeerLinksRoundTrip() throws {
        let secret = Data(repeating: 7, count: 16)
        let link = PeerLink(secret: secret, pk: receiver.pk, address: "192.168.1.5:47480", name: "iPhone di Anna")
        let back = try XCTUnwrap(PeerLink(link.format()))
        XCTAssertEqual(back.secret, secret)
        XCTAssertEqual(back.pk, receiver.pk)
        XCTAssertEqual(back.base, "http://192.168.1.5:47480")
        XCTAssertEqual(back.name, "iPhone di Anna")
        XCTAssertEqual(back.id, Proto.deviceId(receiver.pk))
        // The Android app writes spaces as %20 and base64url without padding: same parse.
        XCTAssertNotNil(PeerLink("wavedrop://peer?k=\(PeerLink.b64url(secret))&p=\(PeerLink.b64url(receiver.pk))&n=Pixel%20di%20Bruno"))
        XCTAssertNil(PeerLink("http://192.168.1.2:47480/m/#k=abc&p=def"))
        XCTAssertNil(PeerLink(PeerLink(secret: secret, pk: receiver.pk, address: "1.2.3.4:5; rm -rf", name: nil).format())?.address)
    }

    // MARK: pairing

    func testPairsWithTheQrSecretOnce() async throws {
        let secret = await core.newQr()
        let body: [String: Any] = ["id": senderId, "pk": Proto.b64(sender.pk), "name": "Pixel di Bruno", "platform": "android", "port": 47480,
                                   "proof": Proto.qrProof(secret, "wd-peer-pair", sender.pk, receiver.pk)]
        let (code, res) = await post("/Pair/QR", body)
        XCTAssertEqual(code, 200)
        XCTAssertEqual(res["pk"] as? String, Proto.b64(receiver.pk))
        XCTAssertEqual(res["proof"] as? String, Proto.qrProof(secret, "wd-peer-ok", receiver.pk, sender.pk))
        XCTAssertEqual(host.pairedWith.first?.0.name, "Pixel di Bruno")
        XCTAssertEqual(host.pairedWith.first?.1, "http://192.168.1.7:47480")
        let (again, _) = await post("/Pair/QR", body)
        XCTAssertEqual(again, 410)
    }

    func testWrongProofsBurnTheQr() async throws {
        let secret = await core.newQr()
        var body: [String: Any] = ["id": senderId, "pk": Proto.b64(sender.pk),
                                   "proof": Proto.qrProof(Data(repeating: 1, count: 16), "wd-peer-pair", sender.pk, receiver.pk)]
        for _ in 0..<3 {
            let (code, _) = await post("/Pair/QR", body)
            XCTAssertEqual(code, 403)
        }
        body["proof"] = Proto.qrProof(secret, "wd-peer-pair", sender.pk, receiver.pk)
        let (code, _) = await post("/Pair/QR", body)
        XCTAssertEqual(code, 410)
        XCTAssertTrue(host.pairedWith.isEmpty)
    }

    func testPairRequestsAreRateLimited() async {
        let body: [String: Any] = ["id": senderId, "name": "Pixel di Bruno", "platform": "android", "port": 1234]
        let (first, _) = await post("/Pair/Request", body)
        let (second, _) = await post("/Pair/Request", body)
        XCTAssertEqual(first, 202)
        XCTAssertEqual(second, 429)
        XCTAssertEqual(host.requests, ["\(senderId) Pixel di Bruno android http://192.168.1.7:1234"])
    }

    // MARK: transfers

    private func ask(files: [(String, Int)], text: String? = nil) async throws -> (Int, (key: Data, session: String, token: String)?) {
        let request: [String: Any] = ["name": "Pixel di Bruno", "platform": "android",
                                      "files": files.map { ["name": $0.0, "size": $0.1] }, "text": text ?? NSNull(), "thumbnail": NSNull()]
        let sealed = try Proto.askSeal(sk: sender.sk, pk: sender.pk, peerPk: receiver.pk, request: request)
        let (code, res) = await post("/Ask", ["id": senderId, "e": sealed.e, "ct": sealed.ct])
        guard code == 200 else { return (code, nil) }
        let opened = try Proto.answerOpen(k1: sealed.k1, sk: sender.sk, ephemeral: sealed.ephemeral, e: res["e"] as! String, ct: res["ct"] as! String)
        XCTAssertEqual(opened.answer["accepted"] as? Bool, true)
        return (code, (opened.key, opened.answer["session"] as! String, opened.answer["token"] as! String))
    }

    func testReceivesFilesOnceAccepted() async throws {
        pairSender()
        host.decision = true
        let big = Data((0..<(2 * Proto.chunkSize + 12345)).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        let (code, s) = try await ask(files: [("foto.jpg", big.count), ("vuoto.txt", 0)])
        XCTAssertEqual(code, 200)
        let session = try XCTUnwrap(s)
        XCTAssertEqual(host.offers.first?.senderName, "Pixel di Bruno")
        let count = Proto.chunkCount(big.count)
        for c in 0..<count {
            let part = big.subdata(in: (c * Proto.chunkSize)..<min(big.count, (c + 1) * Proto.chunkSize))
            let status = await chunk(session.session, 0, c, c == count - 1, try Proto.sealChunk(session.key, session: session.session, file: 0, index: c, last: c == count - 1, part))
            XCTAssertEqual(status, 200)
        }
        XCTAssertNil(host.finished)
        let empty = await chunk(session.session, 1, 0, true, try Proto.sealChunk(session.key, session: session.session, file: 1, index: 0, last: true, Data()))
        XCTAssertEqual(empty, 200)
        let done = try XCTUnwrap(host.finished)
        XCTAssertEqual(done.0, .done)
        XCTAssertEqual(done.1.map(\.lastPathComponent), ["foto.jpg", "vuoto.txt"])
        XCTAssertEqual(try Data(contentsOf: done.1[0]), big)
        let after = await chunk(session.session, 0, 0, false, Data(count: 32))
        XCTAssertEqual(after, 410)
    }

    func testTextNeedsOnlyTheAnswer() async throws {
        pairSender()
        host.decision = true
        let (code, _) = try await ask(files: [], text: "https://example.com/")
        XCTAssertEqual(code, 200)
        XCTAssertEqual(host.offers.first?.text, "https://example.com/")
        XCTAssertEqual(host.finished?.0, .done)
    }

    func testDeclinedStrangersAndHidden() async throws {
        let (stranger, _) = try await ask(files: [("a.txt", 1)])
        XCTAssertEqual(stranger, 401)
        pairSender()
        host.receiving = false
        let (hidden, _) = try await ask(files: [("a.txt", 1)])
        XCTAssertEqual(hidden, 403)
        XCTAssertTrue(host.offers.isEmpty)
        host.receiving = true
        host.decision = false
        let (declined, _) = try await ask(files: [("a.txt", 1)])
        XCTAssertEqual(declined, 403)
        XCTAssertEqual(host.finished?.0, .declined)
    }

    func testTamperedChunkStopsTheTransfer() async throws {
        pairSender()
        host.decision = true
        let asked = try await ask(files: [("a.bin", 100)])
        let s = try XCTUnwrap(asked.1)
        var sealed = try Proto.sealChunk(s.key, session: s.session, file: 0, index: 0, last: true, Data(count: 100))
        sealed[sealed.startIndex + 5] ^= 1 // sealed may be a slice of a larger buffer
        let status = await chunk(s.session, 0, 0, true, sealed)
        XCTAssertEqual(status, 400)
        XCTAssertEqual(host.finished?.0, .failed)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0 != "tmp" }, [])
    }

    func testSenderCancelAndOrder() async throws {
        pairSender()
        host.decision = true
        let asked = try await ask(files: [("a.bin", Proto.chunkSize + 1)])
        let s = try XCTUnwrap(asked.1)
        let wrongOrder = await chunk(s.session, 0, 1, true, try Proto.sealChunk(s.key, session: s.session, file: 0, index: 1, last: true, Data(count: 1)))
        XCTAssertEqual(wrongOrder, 409)
        let first = await chunk(s.session, 0, 0, false, try Proto.sealChunk(s.key, session: s.session, file: 0, index: 0, last: false, Data(count: Proto.chunkSize)))
        XCTAssertEqual(first, 200)
        let (bad, _) = await post("/Cancel?s=\(s.session)&t=wrong", [:])
        XCTAssertEqual(bad, 401)
        let (ok, _) = await post("/Cancel?s=\(s.session)&t=\(s.token)", [:])
        XCTAssertEqual(ok, 200)
        XCTAssertEqual(host.finished?.0, .cancelled)
        XCTAssertEqual(host.finished?.2, "Pixel di Bruno ha annullato l'invio")
        let late = await chunk(s.session, 0, 1, true, try Proto.sealChunk(s.key, session: s.session, file: 0, index: 1, last: true, Data(count: 1)))
        XCTAssertEqual(late, 410)
    }

    func testASenderThatHangsUpWithdrawsTheOffer() async throws {
        pairSender()
        let sealed = try Proto.askSeal(sk: sender.sk, pk: sender.pk, peerPk: receiver.pk, request: ["files": [], "text": "ciao"])
        let body = try JSONSerialization.data(withJSONObject: ["id": senderId, "e": sealed.e, "ct": sealed.ct])
        let response = await core.handle(HTTPRequest(method: "POST", path: "/Ask", body: body), clientGone: { true })
        XCTAssertNil(response)
        XCTAssertEqual(host.finished?.0, .cancelled)
    }
}
