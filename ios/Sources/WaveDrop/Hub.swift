#if os(iOS)
import Foundation
import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WaveDropKit

enum Direction { case incoming, outgoing }

enum Status {
    case preparing, waiting, offer, sending, receiving, done, declined, cancelled, failed

    var active: Bool { [.preparing, .waiting, .offer, .sending, .receiving].contains(self) }
}

struct ReceivedFile: Identifiable {
    let id = UUID()
    let name: String
    let url: URL
    let size: Int
    let inPhotos: Bool
}

struct Transfer: Identifiable {
    let id: String
    let peerId: String // a PC or a phone
    var peer: String
    let direction: Direction
    var what: String
    var size: Int
    var status: Status
    var progress: Double = 0
    var note: String?
    var text: String?
    var thumbnail: UIImage?
    var files: [ReceivedFile] = []
}

/// A file picked on the iPhone, ready to send.
struct OutgoingFile {
    let url: URL
    let name: String
    let size: Int
    let type: UTType?
}

/// Somewhere to send: a PC or a paired phone.
struct Target: Identifiable, Equatable {
    let id: String
    let name: String
    let isPhone: Bool
    let platform: String
    let online: Bool
}

/// Another phone asked this iPhone to show its QR code.
struct PairRequest: Identifiable, Equatable {
    let id: String
    let name: String
    let platform: String
}

/// This iPhone's pairing QR while it is on screen; `pairedWith` once someone scanned it.
struct ShownQr: Equatable {
    let text: String
    let expires: Date
    var pairedWith: String?
}

struct RemoteCancelled: Error {
    var note = "Annullato sul PC"
}

struct WaveError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The wording for each kind of receiver, so PC and phone sends share one code path.
struct Receiver {
    let name: String
    let isPhone: Bool

    var waiting: String { isPhone ? "In attesa che \(name) accetti…" : "In attesa di conferma sul PC…" }
    var unreachable: String {
        isPhone ? "\(name) non è raggiungibile: avete WaveDrop aperto sulla stessa rete Wi-Fi?" : "PC non raggiungibile: WaveDrop è aperto e siete sulla stessa rete?"
    }
    var unpaired: String {
        isPhone ? "\(name) non riconosce più questo iPhone: abbinatevi di nuovo con il QR." : "Il PC non riconosce più questo iPhone: ricollegalo con un nuovo QR."
    }
    var cancelled: String { isPhone ? "Annullato su \(name)" : "Annullato sul PC" }

    func declined(_ reason: String?) -> String {
        switch reason {
        case "off": return isPhone ? "\(name) non sta ricevendo file" : "Il PC non sta ricevendo file"
        case "timeout": return isPhone ? "Nessuna risposta da \(name)" : "Nessuna risposta dal PC"
        default: return isPhone ? "\(name) ha rifiutato" : "Il PC ha rifiutato"
        }
    }
}

func platformLabel(_ platform: String) -> String {
    switch platform {
    case "ios": return "iPhone"
    case "android": return "Android"
    default: return "Telefono"
    }
}

/// Owns the links to every paired PC and phone, this iPhone's server, and the list of transfers.
@MainActor
final class Hub: ObservableObject {
    @Published private(set) var pcs: [Pc] = []
    @Published private(set) var online: Set<String> = []
    @Published private(set) var phones: [Phone] = []
    @Published private(set) var heard: [String: NearbyPhone] = [:] // every phone Bonjour hears, by id
    @Published private(set) var requests: [PairRequest] = []
    @Published private(set) var qr: ShownQr?
    @Published var transfers: [Transfer] = []
    @Published var banner: String?

    let store = Store()
    let session: URLSession
    let streamSession: URLSession
    private var links: [String: PcLink] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private var peerOffers: Set<String> = [] // incoming offers from phones
    private lazy var peer: PeerService = {
        let service = PeerService(identity: store.identity, hub: self)
        service.onNearby = { [weak self] list in
            Task { @MainActor in self?.nearbyChanged(list) }
        }
        return service
    }()

    init() {
        let api = URLSessionConfiguration.default
        api.timeoutIntervalForRequest = 100 // /Ask waits for someone to accept on the other side
        session = URLSession(configuration: api)
        let stream = URLSessionConfiguration.default
        stream.timeoutIntervalForRequest = 3600
        stream.timeoutIntervalForResource = 7 * 24 * 3600
        streamSession = URLSession(configuration: stream)
        pcs = store.pcs
        phones = store.phones
    }

    /// PCs and paired phones, in the order the UI shows them.
    var targets: [Target] {
        pcs.map { Target(id: $0.id, name: $0.name, isPhone: false, platform: $0.platform, online: online.contains($0.id)) }
            + phones.map { Target(id: $0.id, name: $0.name, isPhone: true, platform: $0.platform, online: heard[$0.id] != nil) }
    }

    /// Phones heard nearby that are not paired yet.
    var nearby: [NearbyPhone] {
        let paired = Set(phones.map(\.id))
        return heard.values.filter { !paired.contains($0.id) }.sorted { $0.name < $1.name }
    }

    // MARK: links

    private func link(_ pc: Pc) -> PcLink {
        if let existing = links[pc.id] { return existing }
        let created = PcLink(hub: self, pc: pc)
        links[pc.id] = created
        return created
    }

    /// The app is on screen: PC links, this iPhone's server and Bonjour.
    func connectAll() {
        pcs.forEach { link($0).connect() }
        peer.start(name: store.name, visible: store.visibleToPhones)
    }

    /// The app went to the background: iOS would suspend all of it anyway.
    func disconnectAll() {
        links.values.forEach { $0.disconnect() }
        peer.stop()
        hideQr()
    }

    func setOnline(_ id: String, _ value: Bool) {
        if value { online.insert(id) } else { online.remove(id) }
    }

    func rename(_ pc: Pc) {
        store.save(pc)
        pcs = store.pcs
    }

    /// The name changed: announce it again.
    func announce() { peer.update(name: store.name, visible: store.visibleToPhones) }

    var visibleToPhones: Bool {
        get { store.visibleToPhones }
        set {
            store.visibleToPhones = newValue
            objectWillChange.send()
            announce()
        }
    }

    func handle(url: URL) {
        guard url.scheme == "wavedrop" else { return }
        pair(url.absoluteString)
    }

    /// A PC's QR or another phone's QR.
    func pair(_ text: String) {
        if let link = PeerLink(text) {
            Task {
                do {
                    let phone = try await pairPhone(link)
                    banner = "Abbinato con \(phone.name) ✓"
                } catch {
                    banner = error.localizedDescription
                }
            }
            return
        }
        guard let link = PairingLink(text) else {
            banner = "Questo non è un codice QR di WaveDrop."
            return
        }
        Task {
            do {
                let pc = try await Pairing.pair(link: link, store: store, session: session)
                links[pc.id]?.disconnect()
                links[pc.id] = nil
                pcs = store.pcs
                self.link(pc).connect()
                banner = "Collegato a \(pc.name) ✓"
            } catch {
                banner = error.localizedDescription
            }
        }
    }

    func remove(_ pc: Pc) {
        links[pc.id]?.disconnect()
        links[pc.id] = nil
        store.remove(pc.id)
        pcs = store.pcs
        online.remove(pc.id)
    }

    // MARK: phones

    private func nearbyChanged(_ list: [NearbyPhone]) {
        heard = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // Keep the last known address (and name) of paired phones.
        for var phone in store.phones {
            guard let h = heard[phone.id], h.url != phone.url || h.name != phone.name else { continue }
            phone.url = h.url
            phone.name = h.name
            store.save(phone)
        }
        phones = store.phones
    }

    func removePhone(_ phone: Phone) {
        store.removePhone(phone.id)
        phones = store.phones
    }

    /// Shows this iPhone's QR (valid 5 minutes, once).
    func showQr() {
        peer.start(name: store.name, visible: store.visibleToPhones)
        Task {
            let secret = await peer.core.newQr()
            let ip = PeerService.localIPv4()
            let port = peer.port
            let link = PeerLink(secret: secret, pk: store.identity.pk, address: ip != nil && port > 0 ? "\(ip!):\(port)" : nil, name: store.name)
            qr = ShownQr(text: link.format(), expires: Date().addingTimeInterval(PeerCore<PeerBridge>.qrTTL))
        }
    }

    func hideQr() {
        guard qr != nil else { return }
        qr = nil
        Task { await peer.core.dropQr() }
    }

    /// Scanned another phone's QR: prove it and exchange keys.
    private func pairPhone(_ link: PeerLink) async throws -> Phone {
        let me = store.identity
        guard link.pk != me.pk else { throw WaveError(message: "Questo è il codice QR di questo iPhone: inquadra quello dell'altro telefono.") }
        var urls: [String] = []
        if let base = link.base { urls.append(base) }
        if let h = heard[link.id]?.url, !urls.contains(h) { urls.append(h) }
        guard !urls.isEmpty else { throw WaveError(message: "Non trovo l'altro telefono: siete sulla stessa rete Wi-Fi?") }
        let body: [String: Any] = [
            "id": store.id, "pk": Proto.b64(me.pk), "name": store.name, "platform": "ios", "port": peer.port,
            "proof": Proto.qrProof(link.secret, "wd-peer-pair", me.pk, link.pk),
        ]
        for url in urls {
            guard let reply = try? await session.post("\(url)/Pair/QR", json: body) else { continue }
            let (status, data) = reply
            if status == 410 { throw WaveError(message: "Il codice QR è scaduto o è già stato usato: mostrane uno nuovo sull'altro telefono.") }
            guard status == 200 else { throw WaveError(message: "Abbinamento non riuscito (errore \(status)).") }
            let j = jsonObject(data)
            guard let pkText = j["pk"] as? String, let pk = try? Proto.unb64(pkText), pk == link.pk,
                  j["proof"] as? String == Proto.qrProof(link.secret, "wd-peer-ok", link.pk, me.pk)
            else { throw WaveError(message: "L'altro telefono non ha superato la verifica: abbinamento annullato.") }
            let name = (j["name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            let phone = Phone(id: link.id, pk: pkText, name: String((name.isEmpty ? link.name ?? "Telefono" : name).prefix(40)),
                              platform: String((j["platform"] as? String ?? "").prefix(16)), url: url, addedAt: Date())
            store.save(phone)
            phones = store.phones
            requests.removeAll { $0.id == phone.id }
            return phone
        }
        throw WaveError(message: "L'altro telefono non risponde: tenete WaveDrop aperto, sulla stessa rete Wi-Fi.")
    }

    /// Asks a nearby phone to show its QR code, so this iPhone can scan it.
    func requestPair(_ phone: NearbyPhone) {
        let body: [String: Any] = ["id": store.id, "name": store.name, "platform": "ios", "port": peer.port]
        let session = self.session
        Task { _ = try? await session.post("\(phone.url)/Pair/Request", json: body) }
    }

    func dismissRequest(_ id: String) { requests.removeAll { $0.id == id } }

    // Called by PeerCore through PeerBridge.

    func peerPaired(_ info: PeerInfo, url: String?) {
        store.save(Phone(id: info.id, pk: info.pk, name: info.name, platform: info.platform, url: heard[info.id]?.url ?? url ?? "", addedAt: Date()))
        phones = store.phones
        requests.removeAll { $0.id == info.id }
        qr?.pairedWith = info.name
        banner = "Abbinato con \(info.name) ✓"
    }

    func peerPairRequest(id: String, name: String, platform: String) {
        requests.removeAll { $0.id == id }
        requests.append(PairRequest(id: id, name: name, platform: platform))
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    func peerOffer(_ offer: IncomingOffer) {
        peerOffers.insert(offer.id)
        var thumb: UIImage?
        if let url = offer.thumbnail, let comma = url.firstIndex(of: ","), let data = try? Proto.unb64(String(url[url.index(after: comma)...])) {
            thumb = UIImage(data: data)
        }
        add(Transfer(id: offer.id, peerId: offer.peer.id, peer: offer.senderName, direction: .incoming,
                     what: describePayload(names: offer.files.map { $0.name }, text: offer.text), size: offer.total,
                     status: .offer, text: offer.text, thumbnail: thumb))
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    func peerProgress(id: String, received: Int, total: Int) {
        update(id) {
            $0.status = .receiving
            $0.note = nil
            $0.progress = total > 0 ? Double(received) / Double(total) : 1
        }
    }

    func peerFinished(id: String, status: InStatus, saved: [ReceivedFile], note: String?) {
        update(id) { t in
            switch status {
            case .done:
                t.status = .done
                t.progress = 1
                t.files = saved
                t.note = t.size == 0 ? "Ricevuto" : nil
            case .declined:
                t.status = .declined
                t.note = note ?? "Rifiutato"
            case .cancelled:
                if t.status != .cancelled {
                    t.status = .cancelled
                    t.note = note
                }
            case .failed:
                t.status = .failed
                t.note = note ?? "Non riuscito"
            default:
                break
            }
        }
    }

    // MARK: transfers

    func add(_ t: Transfer) { transfers.insert(t, at: 0) }

    func update(_ id: String, _ change: (inout Transfer) -> Void) {
        guard let i = transfers.firstIndex(where: { $0.id == id }) else { return }
        change(&transfers[i])
    }

    func transfer(_ id: String) -> Transfer? { transfers.first { $0.id == id } }

    func dismiss(_ id: String) { transfers.removeAll { $0.id == id } }

    func send(files: [OutgoingFile], text: String?, to target: Target) {
        let id = UUID().uuidString
        let label = text != nil && files.isEmpty ? "un testo" : files.count == 1 ? "un file" : "\(files.count) elementi"
        add(Transfer(id: id, peerId: target.id, peer: target.name, direction: .outgoing, what: label, size: 0, status: .preparing, note: "Preparazione…"))
        if let pc = pcs.first(where: { $0.id == target.id }) {
            run(id) { try await self.sendSealed(id: id, url: pc.url, peerPk: pc.pkData, to: Receiver(name: pc.name, isPhone: false), files: files, text: text) }
        } else if let phone = phones.first(where: { $0.id == target.id }) {
            let url = heard[phone.id]?.url ?? phone.url
            run(id) {
                guard !url.isEmpty else { throw WaveError(message: Receiver(name: phone.name, isPhone: true).unreachable) }
                try await self.sendSealed(id: id, url: url, peerPk: phone.pkData, to: Receiver(name: phone.name, isPhone: true), files: files, text: text)
            }
        }
    }

    /// Files from the document picker: security-scoped, copied before sending.
    func send(pickedURLs: [URL], to target: Target) {
        var files: [OutgoingFile] = []
        for url in pickedURLs {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent(url.lastPathComponent)
            do {
                try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: url, to: copy)
                let size = (try? copy.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                files.append(OutgoingFile(url: copy, name: url.lastPathComponent, size: size, type: UTType(filenameExtension: url.pathExtension)))
            } catch {
                banner = "Impossibile leggere \(url.lastPathComponent)"
            }
        }
        if !files.isEmpty { send(files: files, text: nil, to: target) }
    }

    /// iPhone → PC or iPhone → phone: the same sealed /Ask and /Chunk exchange.
    private func sendSealed(id: String, url: String, peerPk: Data, to: Receiver, files: [OutgoingFile], text: String?) async throws {
        let me = store.identity
        let total = files.reduce(0) { $0 + $1.size }
        let thumb: Data? = files.first.flatMap { thumbnail($0) }
        let what = describePayload(names: files.map(\.name), text: text)
        update(id) { t in
            t.what = what
            t.size = total
            t.status = .waiting
            t.note = to.waiting
            t.thumbnail = thumb.flatMap { UIImage(data: $0) }
        }
        let request: [String: Any] = [
            "name": store.name,
            "platform": "ios",
            "files": files.map { ["name": $0.name, "size": $0.size] },
            "text": text ?? NSNull(),
            "thumbnail": thumb.map { "data:image/jpeg;base64," + Proto.b64($0) } ?? NSNull(),
        ]
        let sealed = try Proto.askSeal(sk: me.sk, pk: me.pk, peerPk: peerPk, request: request)
        let (status, data): (Int, Data)
        do {
            (status, data) = try await session.post("\(url)/Ask", json: ["id": store.id, "e": sealed.e, "ct": sealed.ct])
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw WaveError(message: to.unreachable)
        }
        if status == 401 { throw WaveError(message: to.unpaired) }
        guard status == 200 else {
            let reason = jsonObject(data)["reason"] as? String
            update(id) {
                $0.status = .declined
                $0.note = to.declined(reason)
            }
            return
        }
        let body = jsonObject(data)
        let answer = try Proto.answerOpen(k1: sealed.k1, sk: me.sk, ephemeral: sealed.ephemeral,
                                          e: body["e"] as? String ?? "", ct: body["ct"] as? String ?? "")
        let sessionId = answer.answer["session"] as? String ?? ""
        let token = answer.answer["token"] as? String ?? ""
        if files.isEmpty {
            update(id) { $0.status = .done; $0.progress = 1; $0.note = "Testo inviato" }
            return
        }

        update(id) { $0.status = .sending; $0.note = nil }
        do {
            var sent = 0
            for (f, file) in files.enumerated() {
                let handle = try FileHandle(forReadingFrom: file.url)
                defer { try? handle.close() }
                let count = Proto.chunkCount(file.size)
                for c in 0..<count {
                    try Task.checkCancellation()
                    let last = c == count - 1
                    let chunk = try handle.read(upToCount: Proto.chunkSize) ?? Data()
                    let expected = last ? file.size - c * Proto.chunkSize : Proto.chunkSize
                    guard chunk.count == expected else { throw WaveError(message: "Il file è cambiato durante l'invio") }
                    let sealedChunk = try Proto.sealChunk(answer.key, session: sessionId, file: f, index: c, last: last, chunk)
                    let code = try await session.post("\(url)/Chunk?s=\(enc(sessionId))&f=\(f)&c=\(c)&last=\(last ? 1 : 0)", bytes: sealedChunk)
                    if code == 410 { throw RemoteCancelled(note: to.cancelled) }
                    guard code == 200 else { throw WaveError(message: "Invio interrotto (errore \(code))") }
                    sent += chunk.count
                    update(id) { $0.progress = total > 0 ? Double(sent) / Double(total) : 1 }
                }
            }
            update(id) { $0.status = .done; $0.progress = 1; $0.note = nil }
        } catch {
            if Task.isCancelled {
                let http = session
                let cancelURL = "\(url)/Cancel?s=\(enc(sessionId))&t=\(enc(token))"
                Task.detached { _ = try? await http.post(cancelURL, json: [:]) }
            }
            throw error
        }
    }

    private func thumbnail(_ file: OutgoingFile) -> Data? {
        guard file.type?.conforms(to: .image) == true, let image = UIImage(contentsOfFile: file.url.path) else { return nil }
        return image.preparingThumbnail(of: CGSize(width: 160, height: 160))?.jpegData(compressionQuality: 0.75)
    }

    func accept(_ id: String) {
        guard let t = transfer(id) else { return }
        update(id) { $0.status = .receiving; $0.note = "Connessione…" }
        if peerOffers.contains(id) {
            Task { await peer.core.decide(id, accept: true) }
            return
        }
        guard let pc = pcs.first(where: { $0.id == t.peerId }) else { return }
        run(id) { try await self.link(pc).accept(id: id) }
    }

    func decline(_ id: String) {
        guard let t = transfer(id) else { return }
        if peerOffers.contains(id) {
            Task { await peer.core.decide(id, accept: false) }
            return
        }
        guard let pc = pcs.first(where: { $0.id == t.peerId }) else { return }
        Task { await self.link(pc).decline(id: id) }
    }

    func cancel(_ id: String) {
        guard let t = transfer(id) else { return }
        if t.status == .offer { return decline(id) }
        update(id) {
            $0.status = .cancelled
            $0.note = $0.direction == .outgoing ? "Invio annullato" : "Ricezione annullata"
        }
        if peerOffers.contains(id) {
            Task { await peer.core.cancel(id) }
        } else {
            tasks[id]?.cancel()
        }
    }

    func remoteCancel(_ id: String) {
        guard let t = transfer(id), t.status.active else { return }
        update(id) { $0.status = .cancelled; $0.note = "Annullato sul PC" }
        tasks[id]?.cancel()
    }

    private func run(_ id: String, _ work: @escaping () async throws -> Void) {
        tasks[id] = Task {
            do {
                try await work()
            } catch is CancellationError {
                // status already set by cancel()/remoteCancel()
            } catch let error as RemoteCancelled {
                update(id) { $0.status = .cancelled; $0.note = error.note }
            } catch let error as URLError where error.code == .cancelled {
                // cancelled by the user
            } catch {
                update(id) {
                    if $0.status.active {
                        $0.status = .failed
                        $0.note = error.localizedDescription
                    }
                }
            }
            tasks[id] = nil
        }
    }
}

// MARK: - HTTP helpers

extension URLSession {
    func post(_ url: String, json: [String: Any]) async throws -> (Int, Data) {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, response) = try await data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    func post(_ url: String, bytes: Data) async throws -> Int {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        let (_, response) = try await upload(for: request, from: bytes)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    func get(_ url: String) async throws -> (Int, Data) {
        let (data, response) = try await data(from: URL(string: url)!)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

func jsonObject(_ data: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
}

func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s }

// MARK: - pairing

enum Pairing {
    static func pair(link: PairingLink, store: Store, session: URLSession) async throws -> Pc {
        let me = store.identity
        let status: Int
        let data: Data
        do {
            (status, data) = try await session.post("\(link.base)/m/pair", json: [
                "pk": Proto.b64(me.pk),
                "name": store.name,
                "platform": "ios",
                "proof": Proto.qrProof(link.secret, "wd-mobile-pair", me.pk, link.pcPk),
            ])
        } catch {
            throw WaveError(message: "Il PC non risponde. iPhone e PC sono sulla stessa rete Wi-Fi, e WaveDrop è aperto?")
        }
        if status == 410 { throw WaveError(message: "Il codice QR è scaduto o è già stato usato. Generane uno nuovo sul PC.") }
        guard status == 200 else { throw WaveError(message: "Collegamento non riuscito (errore \(status)).") }
        let body = jsonObject(data)
        guard let pkText = body["pk"] as? String, let pcPk = try? Proto.unb64(pkText), Proto.sameBytes(pcPk, link.pcPk),
              body["proof"] as? String == Proto.qrProof(link.secret, "wd-mobile-ok", link.pcPk, me.pk),
              let id = body["id"] as? String
        else { throw WaveError(message: "Il PC non ha superato la verifica: collegamento annullato.") }
        let pc = Pc(id: id, pk: pkText, name: body["name"] as? String ?? "PC", platform: body["platform"] as? String ?? "",
                    url: link.base, addedAt: Date())
        store.save(pc)
        return pc
    }
}

// MARK: - one PC

@MainActor
final class PcLink {
    private weak var hub: Hub?
    private(set) var pc: Pc
    private var active = false
    private var streamTask: Task<Void, Never>?
    private var offers: [String: Offer] = [:]

    private struct Offer {
        let opened: Proto.Opened
        let files: [(name: String, size: Int)]
        let text: String?
    }

    init(hub: Hub, pc: Pc) {
        self.hub = hub
        self.pc = pc
    }

    private var store: Store { hub!.store }

    // MARK: event stream

    func connect() {
        guard !active else { return }
        active = true
        streamTask = Task { [weak self] in
            while let self, self.active, !Task.isCancelled {
                try? await self.stream()
                self.hub?.setOnline(self.pc.id, false)
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    func disconnect() {
        active = false
        streamTask?.cancel()
        streamTask = nil
        hub?.setOnline(pc.id, false)
    }

    private func stream() async throws {
        guard let hub else { return }
        let me = store.identity
        let t = String(Int64(Date().timeIntervalSince1970 * 1000))
        let sig = Proto.b64(Proto.mac(try Proto.pairKey(me.sk, myPk: me.pk, otherPk: pc.pkData, purpose: "link"), Proto.lv("wd-events", t)))
        let url = URL(string: "\(pc.url)/m/events?id=\(store.id)&t=\(t)&sig=\(enc(sig))")!
        let (bytes, response) = try await hub.streamSession.bytes(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
        var type: String?
        // One "event:" line followed by one "data:" line per event (server format).
        for try await line in bytes.lines {
            if line.hasPrefix("event:") {
                type = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:"), let kind = type {
                let data = Data(line.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8)
                handle(kind, jsonObject(data))
                type = nil
            }
        }
    }

    private func handle(_ type: String, _ data: [String: Any]) {
        switch type {
        case "hello":
            hub?.setOnline(pc.id, true)
            if let name = data["name"] as? String, !name.isEmpty, name != pc.name {
                pc.name = name
                hub?.rename(pc)
            }
        case "offer":
            onOffer(data)
        case "cancel":
            if let offer = data["offer"] as? String {
                offers[offer] = nil
                hub?.remoteCancel(offer)
            }
        default:
            break
        }
    }

    // MARK: PC → iPhone

    private func onOffer(_ ev: [String: Any]) {
        guard let hub, let offerId = ev["offer"] as? String, offers[offerId] == nil, hub.transfer(offerId) == nil,
              let e = ev["e"] as? String, let ct = ev["ct"] as? String else { return }
        let me = store.identity
        guard let opened = try? Proto.askOpen(sk: me.sk, pk: me.pk, peerPk: pc.pkData, e: e, ct: ct) else { return }
        let req = opened.request
        let files = (req["files"] as? [[String: Any]] ?? []).compactMap { f -> (name: String, size: Int)? in
            guard let name = f["name"] as? String, let size = f["size"] as? Int else { return nil }
            return (name, size)
        }
        let text = req["text"] as? String
        offers[offerId] = Offer(opened: opened, files: files, text: text)
        var thumb: UIImage?
        if let url = req["thumbnail"] as? String, let comma = url.firstIndex(of: ","),
           let data = try? Proto.unb64(String(url[url.index(after: comma)...])) {
            thumb = UIImage(data: data)
        }
        hub.add(Transfer(
            id: offerId, peerId: pc.id, peer: req["name"] as? String ?? pc.name, direction: .incoming,
            what: describePayload(names: files.map { $0.name }, text: text), size: files.reduce(0) { $0 + $1.size },
            status: .offer, text: text, thumbnail: thumb
        ))
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    func accept(id: String) async throws {
        guard let hub, let offer = offers[id] else { throw WaveError(message: "L'offerta non è più valida.") }
        defer { offers[id] = nil }
        let answer = try Proto.answerSeal(k1: offer.opened.k1, eA: offer.opened.eA, peerPk: pc.pkData, answer: ["accepted": true])
        let (status, _) = try await hub.session.post("\(pc.url)/m/answer", json: ["offer": id, "e": answer.e, "ct": answer.ct])
        guard status == 200 else { throw WaveError(message: "L'offerta non è più valida.") }
        if offer.files.isEmpty {
            hub.update(id) { $0.status = .done; $0.progress = 1; $0.note = "Ricevuto" }
            return
        }

        hub.update(id) { $0.status = .receiving; $0.progress = 0; $0.note = nil }
        let total = offer.files.reduce(0) { $0 + $1.size }
        var got = 0
        var received: [ReceivedFile] = []
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(id)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        do {
            for (f, file) in offer.files.enumerated() {
                let part = temp.appendingPathComponent("\(f).part")
                FileManager.default.createFile(atPath: part.path, contents: nil)
                let handle = try FileHandle(forWritingTo: part)
                defer { try? handle.close() }
                let count = Proto.chunkCount(file.size)
                for c in 0..<count {
                    try Task.checkCancellation()
                    let (code, data) = try await hub.session.get("\(pc.url)/m/chunk?o=\(enc(id))&f=\(f)&c=\(c)")
                    if code == 410 { throw RemoteCancelled() }
                    guard code == 200 else { throw WaveError(message: "Download interrotto (errore \(code))") }
                    let plain = try Proto.openChunk(answer.key, session: id, file: f, index: c, last: c == count - 1, data)
                    try handle.write(contentsOf: plain)
                    got += plain.count
                    hub.update(id) { $0.progress = total > 0 ? Double(got) / Double(total) : 1 }
                }
                try handle.close()
                received.append(try await Saver.keep(part, name: file.name, size: file.size))
            }
            hub.update(id) { $0.status = .done; $0.progress = 1; $0.files = received }
        } catch {
            if Task.isCancelled {
                let mac = Proto.b64(Proto.mac(answer.key, Proto.lv("wd-cancel", id)))
                let http = hub.session
                let url = "\(pc.url)/m/cancel"
                Task.detached { _ = try? await http.post(url, json: ["offer": id, "mac": mac]) }
            }
            throw error
        }
    }

    func decline(id: String) async {
        guard let hub, let offer = offers.removeValue(forKey: id) else { return }
        hub.update(id) { $0.status = .declined; $0.note = "Rifiutato" }
        guard let answer = try? Proto.answerSeal(k1: offer.opened.k1, eA: offer.opened.eA, peerPk: pc.pkData, answer: ["accepted": false]) else { return }
        _ = try? await hub.session.post("\(pc.url)/m/answer", json: ["offer": id, "e": answer.e, "ct": answer.ct])
    }
}

// MARK: - saving received files

enum Saver {
    /// Documents/WaveDrop (visible in the Files app); photos and videos also go to Photos.
    static func keep(_ part: URL, name: String, size: Int) async throws -> ReceivedFile {
        let folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("WaveDrop", isDirectory: true)
        let safe = name.split(separator: "/").map(String.init).last.map(clean) ?? "file"
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let dest = unique(folder.appendingPathComponent(safe))
        try FileManager.default.moveItem(at: part, to: dest)
        let type = UTType(filenameExtension: dest.pathExtension)
        var inPhotos = false
        if type?.conforms(to: .image) == true || type?.conforms(to: .movie) == true {
            inPhotos = await addToPhotos(dest, video: type?.conforms(to: .movie) == true)
        }
        return ReceivedFile(name: dest.lastPathComponent, url: dest, size: size, inPhotos: inPhotos)
    }

    private static func clean(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "\\:*?\"<>|").union(.controlCharacters)
        let cleaned = name.components(separatedBy: bad).joined(separator: "_").trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "file" : String(cleaned.prefix(150))
    }

    private static func unique(_ url: URL) -> URL {
        var candidate = url
        var n = 1
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = url.deletingLastPathComponent().appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
            n += 1
        }
        return candidate
    }

    private static func addToPhotos(_ url: URL, video: Bool) async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { return false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                if video {
                    PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
                } else {
                    PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url)
                }
            }
            return true
        } catch {
            return false
        }
    }
}
#endif
