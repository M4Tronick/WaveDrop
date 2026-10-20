import Foundation

/// Phone-to-phone WaveDrop: the routes each phone serves, the same transfer
/// protocol as the PC (src/core/transfer.js) and the Android app
/// (android/…/net/PeerServer.kt):
///
///   GET  /Hello          who this phone is
///   POST /Pair/Request   "show me your QR": this phone shows a card
///   POST /Pair/QR        pairing: proves it scanned this phone's QR code
///   POST /Ask            sealed request from a paired phone, held open until
///                        someone accepts or declines here
///   POST /Chunk          one sealed 1 MiB chunk, in order
///   POST /Cancel         the sender aborts
///
/// Pairing proves knowledge of the one-time secret in the QR with qrProof
/// ("wd-peer-pair" / "wd-peer-ok"), as the PC's QR does with "wd-mobile-*".

/// Another phone this one is paired with.
public struct PeerInfo: Sendable, Equatable {
    public let id: String
    public let pk: String
    public let name: String
    public let platform: String

    public init(id: String, pk: String, name: String, platform: String) {
        self.id = id
        self.pk = pk
        self.name = name
        self.platform = platform
    }
}

/// An offer from another phone, as the UI sees it.
public struct IncomingOffer: Sendable {
    public let id: String
    public let peer: PeerInfo
    public let senderName: String
    public let files: [(name: String, size: Int)]
    public let text: String?
    public let thumbnail: String?

    public var total: Int { files.reduce(0) { $0 + $1.size } }
}

public enum InStatus: Sendable { case pending, receiving, done, declined, cancelled, failed }

/// What the core needs from the app. The methods are async so a @MainActor
/// object can implement them.
public protocol PeerHost: AnyObject, Sendable {
    associatedtype Saved
    /// Name, platform, server port, and whether this phone accepts anything.
    func me() async -> (name: String, platform: String, port: Int, receiving: Bool)
    func peer(_ id: String) async -> PeerInfo?
    func paired(_ peer: PeerInfo, url: String?) async
    func pairRequest(id: String, name: String, platform: String, url: String?) async
    func offer(_ offer: IncomingOffer) async
    func progress(id: String, received: Int, total: Int) async
    func finished(id: String, status: InStatus, saved: [Saved], note: String?) async
    /// A complete received file at `part` (a temporary file): move it where it belongs.
    func keep(_ part: URL, name: String, size: Int) async throws -> Saved
}

public actor PeerCore<Host: PeerHost> {
    public static var qrTTL: TimeInterval { 5 * 60 }
    static var askTimeout: TimeInterval { 90 }
    static var idleTimeout: TimeInterval { 60 }
    static var requestGap: TimeInterval { 10 }

    private final class Entry {
        let offer: IncomingOffer
        let token: String
        let peerPk: Data
        var status = InStatus.pending
        var decision: Bool?
        var key: Data?
        var received = 0
        var file = 0
        var next = 0
        var part: URL?
        var handle: FileHandle?
        var saved: [Host.Saved] = []
        var lastChunk = Date()

        init(offer: IncomingOffer, token: String, peerPk: Data) {
            self.offer = offer
            self.token = token
            self.peerPk = peerPk
        }
    }

    private struct Qr {
        let secret: Data
        let expires: Date
        var attempts = 3
    }

    private let identity: KeyPair
    private weak var host: Host?
    private let temp: URL
    private var qr: Qr?
    private var entries: [String: Entry] = [:]
    private var requests: [String: Date] = [:]

    public init(identity: KeyPair, host: Host, temp: URL) {
        self.identity = identity
        self.host = host
        self.temp = temp
    }

    // MARK: QR pairing

    /// A new one-time QR secret; the previous one stops working.
    public func newQr(ttl: TimeInterval = qrTTL) -> Data {
        let secret = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        qr = Qr(secret: secret, expires: Date().addingTimeInterval(ttl))
        return secret
    }

    public func dropQr() { qr = nil }

    // MARK: decisions from the UI

    public func decide(_ id: String, accept: Bool) {
        guard let e = entries[id], e.status == .pending else { return }
        e.decision = accept
    }

    public func cancel(_ id: String) async {
        guard let e = entries[id] else { return }
        switch e.status {
        case .pending: e.decision = false
        case .receiving: await end(e, .cancelled, "Ricezione annullata")
        default: break
        }
    }

    /// Ends whatever is still running (the app goes to the background).
    public func close() async {
        for e in entries.values where e.status == .pending || e.status == .receiving {
            await end(e, .cancelled, "Ricezione interrotta")
        }
    }

    /// Fails transfers whose sender went quiet; call now and then.
    public func sweep() async {
        let now = Date()
        for e in entries.values where e.status == .receiving && now.timeIntervalSince(e.lastChunk) > Self.idleTimeout {
            await end(e, .failed, "Connessione interrotta")
        }
    }

    // MARK: routes

    /// `clientGone` says whether the client has hung up (checked while /Ask waits).
    /// Returns nil to close the connection without answering.
    public func handle(_ req: HTTPRequest, clientGone: @escaping @Sendable () async -> Bool) async -> HTTPResponse? {
        switch "\(req.method) \(req.path)" {
        case "GET /Hello": return await hello()
        case "POST /Pair/Request": return await pairRequest(req)
        case "POST /Pair/QR": return await pairQr(req)
        case "POST /Ask": return await ask(req, clientGone: clientGone)
        case "POST /Chunk": return await chunk(req)
        case "POST /Cancel": return await remoteCancel(req)
        default: return .json(404)
        }
    }

    private func clean(_ v: Any?, _ max: Int) -> String {
        String(((v as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(max))
    }

    private func urlOf(_ req: HTTPRequest, port: Int?) -> String? {
        guard let port, (1...65535).contains(port), !req.remoteAddress.isEmpty else { return nil }
        var ip = req.remoteAddress
        if ip.hasPrefix("::ffff:") { ip = String(ip.dropFirst(7)) }
        return ip.contains(":") ? "http://[\(ip)]:\(port)" : "http://\(ip):\(port)"
    }

    private func hello() async -> HTTPResponse {
        guard let host else { return .json(404) }
        let me = await host.me()
        guard me.receiving else { return .json(404) }
        return .json(200, [
            "app": "wavedrop", "v": Proto.version, "kind": "hello", "vis": "everyone",
            "id": Proto.deviceId(identity.pk), "pk": Proto.b64(identity.pk),
            "name": me.name, "platform": me.platform, "port": me.port,
        ])
    }

    private func pairRequest(_ req: HTTPRequest) async -> HTTPResponse {
        guard let host, let body = req.json else { return .json(400) }
        let id = clean(body["id"], 20)
        guard id.range(of: "^[0-9a-f]{20}$", options: .regularExpression) != nil, id != Proto.deviceId(identity.pk) else { return .json(400) }
        let now = Date()
        requests = requests.filter { now.timeIntervalSince($0.value) <= Self.requestGap }
        guard requests[id] == nil, requests.count < 5 else { return .json(429) }
        requests[id] = now
        let name = clean(body["name"], 40)
        await host.pairRequest(id: id, name: name.isEmpty ? "Telefono" : name, platform: clean(body["platform"], 16),
                               url: urlOf(req, port: body["port"] as? Int))
        return .json(202)
    }

    private func pairQr(_ req: HTTPRequest) async -> HTTPResponse {
        guard let host, let body = req.json else { return .json(400) }
        guard let current = qr, Date() <= current.expires else { return .json(410, ["reason": "expired"]) }
        guard let pkText = body["pk"] as? String, let pk = try? Proto.unb64(pkText), pk.count == 32,
              Proto.deviceId(pk) == body["id"] as? String, pk != identity.pk else { return .json(400) }
        guard body["proof"] as? String == Proto.qrProof(current.secret, "wd-peer-pair", pk, identity.pk) else {
            qr?.attempts -= 1
            if (qr?.attempts ?? 0) <= 0 { qr = nil }
            return .json(403, ["reason": "proof"])
        }
        qr = nil // one pairing per QR
        let name = clean(body["name"], 40)
        let peer = PeerInfo(id: Proto.deviceId(pk), pk: Proto.b64(pk), name: name.isEmpty ? "Telefono" : name, platform: clean(body["platform"], 16))
        await host.paired(peer, url: urlOf(req, port: body["port"] as? Int))
        let me = await host.me()
        return .json(200, [
            "id": Proto.deviceId(identity.pk), "pk": Proto.b64(identity.pk), "name": me.name, "platform": me.platform, "port": me.port,
            "proof": Proto.qrProof(current.secret, "wd-peer-ok", identity.pk, pk),
        ])
    }

    // MARK: receiving

    private func ask(_ req: HTTPRequest, clientGone: @escaping @Sendable () async -> Bool) async -> HTTPResponse? {
        guard let host, let body = req.json else { return .json(400) }
        guard let id = body["id"] as? String, let peer = await host.peer(id), let peerPk = try? Proto.unb64(peer.pk) else {
            return .json(401, ["reason": "unpaired"])
        }
        guard await host.me().receiving else { return .json(403, ["accepted": false, "reason": "off"]) }
        guard let opened = try? Proto.askOpen(sk: identity.sk, pk: identity.pk, peerPk: peerPk,
                                              e: body["e"] as? String ?? "", ct: body["ct"] as? String ?? "") else {
            return .json(401, ["reason": "auth"])
        }
        let r = opened.request
        let list = r["files"] as? [Any] ?? []
        guard list.count <= 10_000 else { return .json(400) }
        var files: [(name: String, size: Int)] = []
        for item in list {
            guard let f = item as? [String: Any], let size = (f["size"] as? NSNumber)?.intValue, size >= 0 else { return .json(400) }
            let name = clean(f["name"], 500)
            files.append((name.isEmpty ? "file" : name, size))
        }
        let rawText = r["text"] as? String
        let text = rawText.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : String($0.prefix(100_000)) }
        guard !files.isEmpty || text != nil else { return .json(400) }
        let thumb = (r["thumbnail"] as? String).flatMap { t in
            (t.hasPrefix("data:image/jpeg;base64,") || t.hasPrefix("data:image/png;base64,")) && t.count < 400_000 ? t : nil
        }
        let senderName = clean(r["name"], 40)
        let offer = IncomingOffer(id: UUID().uuidString.lowercased(), peer: peer, senderName: senderName.isEmpty ? peer.name : senderName,
                                  files: files, text: text, thumbnail: thumb)
        let entry = Entry(offer: offer, token: Proto.hex(Data((0..<16).map { _ in UInt8.random(in: 0...255) })), peerPk: peerPk)
        entries[offer.id] = entry
        await host.offer(offer)

        // Held open until someone answers on this phone.
        let deadline = Date().addingTimeInterval(Self.askTimeout)
        while entry.decision == nil {
            if Date() > deadline {
                await end(entry, .declined, "Nessuna risposta")
                return .json(403, ["accepted": false, "reason": "timeout"])
            }
            if await clientGone() {
                await end(entry, .cancelled, "\(offer.senderName) ha annullato l'invio")
                return nil
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        guard entry.decision == true, entry.status == .pending else {
            await end(entry, .declined, "Rifiutato")
            return .json(403, ["accepted": false, "reason": "declined"])
        }
        guard let answer = try? Proto.answerSeal(k1: opened.k1, eA: opened.eA, peerPk: peerPk,
                                                 answer: ["accepted": true, "session": offer.id, "token": entry.token]) else {
            await end(entry, .failed, "Errore di cifratura")
            return .json(500)
        }
        entry.key = answer.key
        if files.isEmpty {
            await end(entry, .done, nil)
        } else {
            entry.status = .receiving
            entry.lastChunk = Date()
        }
        return .json(200, ["e": answer.e, "ct": answer.ct])
    }

    private func chunk(_ req: HTTPRequest) async -> HTTPResponse {
        guard let host, let s = req.query["s"], let entry = entries[s] else { return .json(401) }
        guard entry.status == .receiving, let key = entry.key else { return .json(410, ["reason": "\(entry.status)"]) }
        guard let f = Int(req.query["f"] ?? ""), let c = Int(req.query["c"] ?? "") else { return .json(400) }
        let last = req.query["last"] == "1"
        let files = entry.offer.files
        guard f == entry.file, f < files.count, c == entry.next else { return .json(409, ["reason": "order"]) }
        let (name, size) = files[f]
        let count = Proto.chunkCount(size)
        guard last == (c == count - 1) else { return .json(400, ["reason": "framing"]) }
        let expected = last ? size - c * Proto.chunkSize : Proto.chunkSize
        guard let plain = try? Proto.openChunk(key, session: entry.offer.id, file: f, index: c, last: last, req.body),
              plain.count == expected else {
            await end(entry, .failed, "Dati non autentici: ricezione interrotta")
            return .json(400, ["reason": "auth"])
        }
        do {
            if entry.handle == nil {
                try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
                let part = temp.appendingPathComponent("\(entry.offer.id)-\(f).part")
                FileManager.default.createFile(atPath: part.path, contents: nil)
                entry.part = part
                entry.handle = try FileHandle(forWritingTo: part)
            }
            try entry.handle?.write(contentsOf: plain)
            entry.received += plain.count
            entry.next += 1
            entry.lastChunk = Date()
            if last, let part = entry.part {
                try entry.handle?.close()
                entry.handle = nil
                entry.part = nil
                entry.saved.append(try await host.keep(part, name: name, size: size))
                entry.file += 1
                entry.next = 0
            }
        } catch {
            await end(entry, .failed, "Impossibile salvare il file")
            return .json(500)
        }
        if entry.status != .receiving { return .json(410, ["reason": "\(entry.status)"]) }
        if entry.file >= files.count {
            await end(entry, .done, nil)
        } else {
            await host.progress(id: entry.offer.id, received: entry.received, total: entry.offer.total)
        }
        return .json(200, ["ok": true])
    }

    private func remoteCancel(_ req: HTTPRequest) async -> HTTPResponse {
        guard let s = req.query["s"], let entry = entries[s], req.query["t"] == entry.token else { return .json(401) }
        await end(entry, .cancelled, "\(entry.offer.senderName) ha annullato l'invio")
        return .json(200, ["ok": true])
    }

    private func end(_ entry: Entry, _ status: InStatus, _ note: String?) async {
        guard entry.status == .pending || entry.status == .receiving else { return }
        entry.status = status
        if entry.decision == nil { entry.decision = false }
        if status != .done {
            try? entry.handle?.close()
            entry.handle = nil
            if let part = entry.part { try? FileManager.default.removeItem(at: part) }
            entry.part = nil
        }
        entry.key = nil
        await host?.finished(id: entry.offer.id, status: status, saved: status == .done ? entry.saved : [], note: note)
        let id = entry.offer.id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            await self?.forget(id)
        }
    }

    private func forget(_ id: String) { entries[id] = nil }
}
