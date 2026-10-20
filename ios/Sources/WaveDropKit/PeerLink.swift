import Foundation

/// The QR a phone shows so another phone can pair with it:
/// wavedrop://peer?k=<one-time secret>&p=<public key>&a=<ip:port>&n=<name>
/// (same format as the Android app, android/…/net/PeerServer.kt).
public struct PeerLink: Sendable {
    public let secret: Data
    public let pk: Data
    public let address: String?
    public let name: String?

    public init(secret: Data, pk: Data, address: String?, name: String?) {
        self.secret = secret
        self.pk = pk
        self.address = address
        self.name = name
    }

    public var id: String { Proto.deviceId(pk) }
    public var base: String? { address.map { "http://\($0)" } }

    static func b64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public func format() -> String {
        var s = "wavedrop://peer?k=\(Self.b64url(secret))&p=\(Self.b64url(pk))"
        if let address { s += "&a=\(address)" }
        if let name, !name.isEmpty {
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-._~")
            s += "&n=\(name.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }
        return s
    }

    public init?(_ text: String) {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.lowercased().hasPrefix("wavedrop://peer?") else { return nil }
        var params: [String: String] = [:]
        for pair in raw[raw.index(after: raw.firstIndex(of: "?")!)...].split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { params[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
        }
        guard let k = params["k"], let p = params["p"],
              let secret = try? Proto.unb64url(k), let pk = try? Proto.unb64url(p),
              secret.count == 16, pk.count == 32 else { return nil }
        self.secret = secret
        self.pk = pk
        if let a = params["a"], a.range(of: #"^[0-9a-fA-F.:\[\]]+:\d{1,5}$"#, options: .regularExpression) != nil {
            address = a
        } else {
            address = nil
        }
        name = params["n"].map { String($0.prefix(40)) }
    }
}
