#if os(iOS)
import Foundation
import Network
import WaveDropKit

/// A phone heard over Bonjour, with the address its server listens on.
struct NearbyPhone: Identifiable, Equatable {
    let id: String
    let name: String
    let platform: String
    let url: String
}

/// This iPhone's side of phone-to-phone WaveDrop: an HTTP server on the local
/// network (Network.framework) that runs WaveDropKit's PeerCore, announced and
/// discovered over Bonjour (_wavedrop._tcp) like the Android app. Bonjour needs
/// no special entitlement on iOS, unlike UDP multicast. iOS suspends apps in
/// the background, so all of this runs only while WaveDrop is open.
final class PeerService: @unchecked Sendable {
    static let type = "_wavedrop._tcp"
    static let preferredPort: UInt16 = 47480

    let core: PeerCore<PeerBridge>
    private let bridge: PeerBridge
    private let identity: KeyPair
    private let queue = DispatchQueue(label: "app.wavedrop.peer")
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var sweeper: Task<Void, Never>?
    private var advertised: (name: String, visible: Bool) = ("", true)
    private(set) var port: Int = 0
    var onNearby: (([NearbyPhone]) -> Void)?

    init(identity: KeyPair, hub: Hub) {
        self.identity = identity
        bridge = PeerBridge(hub: hub)
        core = PeerCore(identity: identity, host: bridge, temp: FileManager.default.temporaryDirectory.appendingPathComponent("peer", isDirectory: true))
        bridge.service = self
    }

    var id: String { Proto.deviceId(identity.pk) }

    // MARK: lifecycle

    func start(name: String, visible: Bool) {
        advertised = (name, visible)
        if listener == nil { listen(on: NWEndpoint.Port(rawValue: Self.preferredPort) ?? .any) }
        if browser == nil { browse() }
        if sweeper == nil {
            sweeper = Task { [core] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    await core.sweep()
                }
            }
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        browser?.cancel()
        browser = nil
        sweeper?.cancel()
        sweeper = nil
        port = 0
        onNearby?([])
        Task { [core] in await core.close() }
    }

    /// The name or the visibility changed: announce again.
    func update(name: String, visible: Bool) {
        advertised = (name, visible)
        listener?.service = service()
    }

    private func service() -> NWListener.Service? {
        guard advertised.visible, port > 0 else { return nil }
        var entries = ["id": id, "n": String(advertised.name.prefix(40)), "pf": "ios", "v": "2", "port": String(port)]
        if let ip = Self.localIPv4() { entries["ip"] = ip }
        return NWListener.Service(name: id, type: Self.type, domain: nil, txtRecord: NWTXTRecord(entries))
    }

    private func listen(on port: NWEndpoint.Port) {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let listener = try? NWListener(using: params, on: port) else {
            if port != .any { listen(on: .any) }
            return
        }
        self.listener = listener
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self, let listener, self.listener === listener else { return }
            switch state {
            case .ready:
                self.port = Int(listener.port?.rawValue ?? 0)
                listener.service = self.service()
            case .failed:
                listener.cancel()
                self.listener = nil
                self.port = 0
                if port != .any { self.listen(on: .any) } // the preferred port is taken
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return connection.cancel() }
            HTTPConnection(connection: connection, queue: self.queue, core: self.core).start()
        }
        listener.start(queue: queue)
    }

    // MARK: discovery

    private func browse() {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.type, domain: nil), using: .tcp)
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            var phones: [NearbyPhone] = []
            for result in results {
                guard case .bonjour(let txt) = result.metadata, let id = txt["id"],
                      id.range(of: "^[0-9a-f]{20}$", options: .regularExpression) != nil, id != self.id else { continue }
                let name = String((txt["n"] ?? "").prefix(40))
                let port = Int(txt["port"] ?? "") ?? 0
                guard let ip = txt["ip"], ip.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil,
                      (1...65535).contains(port) else { continue }
                phones.append(NearbyPhone(id: id, name: name.isEmpty ? "Telefono" : name, platform: String((txt["pf"] ?? "").prefix(16)),
                                          url: "http://\(ip):\(port)"))
            }
            self.onNearby?(phones.sorted { $0.name < $1.name })
        }
        browser.stateUpdateHandler = { [weak self, weak browser] state in
            if case .failed = state, let self, self.browser === browser {
                self.browser = nil
                self.queue.asyncAfter(deadline: .now() + 3) { if self.listener != nil, self.browser == nil { self.browse() } }
            }
        }
        browser.start(queue: queue)
    }

    /// This iPhone's IPv4 address on Wi-Fi (en0), put in the Bonjour record and the QR.
    static func localIPv4() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var fallback: String?
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(bitPattern: ptr.pointee.ifa_flags)
            guard let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host)
            if String(cString: ptr.pointee.ifa_name) == "en0" { return ip }
            if fallback == nil, !ip.hasPrefix("169.254.") { fallback = ip }
        }
        return fallback
    }
}

/// PeerCore calls into the app through this object; it hops to the main actor.
final class PeerBridge: PeerHost, @unchecked Sendable {
    typealias Saved = ReceivedFile

    private weak var hub: Hub?
    weak var service: PeerService?

    init(hub: Hub) { self.hub = hub }

    func me() async -> (name: String, platform: String, port: Int, receiving: Bool) {
        let port = service?.port ?? 0
        let hub = self.hub
        return await MainActor.run {
            (hub?.store.name ?? "iPhone", "ios", port, hub?.store.visibleToPhones ?? false)
        }
    }

    func peer(_ id: String) async -> PeerInfo? {
        let hub = self.hub
        return await MainActor.run {
            hub?.store.phones.first { $0.id == id }.map { PeerInfo(id: $0.id, pk: $0.pk, name: $0.name, platform: $0.platform) }
        }
    }

    func paired(_ peer: PeerInfo, url: String?) async { await hub?.peerPaired(peer, url: url) }
    func pairRequest(id: String, name: String, platform: String, url: String?) async { await hub?.peerPairRequest(id: id, name: name, platform: platform) }
    func offer(_ offer: IncomingOffer) async { await hub?.peerOffer(offer) }
    func progress(id: String, received: Int, total: Int) async { await hub?.peerProgress(id: id, received: received, total: total) }
    func finished(id: String, status: InStatus, saved: [ReceivedFile], note: String?) async {
        await hub?.peerFinished(id: id, status: status, saved: saved, note: note)
    }
    func keep(_ part: URL, name: String, size: Int) async throws -> ReceivedFile { try await Saver.keep(part, name: name, size: size) }
}

/// One TCP connection: reads requests, hands them to PeerCore, writes answers.
private final class HTTPConnection: @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let core: PeerCore<PeerBridge>
    private let inbox = Inbox()

    /// Bytes received so far, and whether the client has hung up.
    actor Inbox {
        private(set) var buffer = Data()
        private(set) var closed = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func append(_ data: Data) {
            buffer.append(data)
            wake()
        }

        func close() {
            closed = true
            wake()
        }

        func drop(_ count: Int) { buffer = Data(buffer.dropFirst(count)) }

        /// Waits until more bytes arrive or the client hangs up.
        func wait() async {
            if closed { return }
            await withCheckedContinuation { waiters.append($0) }
        }

        private func wake() {
            let ready = waiters
            waiters = []
            ready.forEach { $0.resume() }
        }
    }

    init(connection: NWConnection, queue: DispatchQueue, core: PeerCore<PeerBridge>) {
        self.connection = connection
        self.queue = queue
        self.core = core
    }

    private var remoteAddress: String {
        guard case .hostPort(let host, _) = connection.endpoint else { return "" }
        switch host {
        case .ipv4(let address): return "\(address)"
        case .ipv6(let address): return "\(address)"
        default: return ""
        }
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: Task { await self?.inbox.close() }
            default: break
            }
        }
        connection.start(queue: queue)
        receive()
        Task { await serve() }
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            Task {
                if let data, !data.isEmpty { await self.inbox.append(data) }
                if isComplete || error != nil {
                    await self.inbox.close()
                } else {
                    self.receive()
                }
            }
        }
    }

    private func serve() async {
        defer { connection.cancel() }
        while true {
            // The head…
            var head: HTTPWire.Head?
            while head == nil {
                do {
                    head = try HTTPWire.parseHead(await inbox.buffer)
                } catch {
                    let status = (error as? HTTPWire.Failure) == .chunked ? 411 : (error as? HTTPWire.Failure) == .tooLarge ? 413 : 400
                    await send(HTTPResponse.json(status).serialized(close: true))
                    return
                }
                if head == nil {
                    if await inbox.closed { return }
                    await inbox.wait()
                }
            }
            guard let head else { return }
            if head.headers["expect"]?.lowercased() == "100-continue" {
                await send(Data("HTTP/1.1 100 Continue\r\n\r\n".utf8))
            }
            // …then the body.
            while await inbox.buffer.count < head.headLength + head.contentLength {
                if await inbox.closed { return }
                await inbox.wait()
            }
            let buffer = await inbox.buffer
            let start = buffer.startIndex + head.headLength
            let body = buffer.subdata(in: start..<(start + head.contentLength))
            await inbox.drop(head.headLength + head.contentLength)
            let request = HTTPRequest(method: head.method, path: head.path, query: head.query, headers: head.headers, body: body,
                                      remoteAddress: remoteAddress)
            let inbox = self.inbox
            guard let response = await core.handle(request, clientGone: { await inbox.closed }) else { return }
            let close = request.wantsClose
            await send(response.serialized(close: close))
            if close { return }
        }
    }

    private func send(_ data: Data) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            connection.send(content: data, completion: .contentProcessed { _ in done.resume() })
        }
    }
}
#endif
