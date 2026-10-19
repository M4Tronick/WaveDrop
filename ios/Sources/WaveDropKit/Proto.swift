import Crypto
import Foundation

/// Swift port of src/shared/protocol.js (WaveDrop protocol v2), byte for byte.
/// The phone side needs QR pairing and the transfer handshake; CPace pairing
/// between PCs is not used here.
public struct KeyPair: Sendable {
    public let sk: Data
    public let pk: Data

    public init(sk: Data, pk: Data) {
        self.sk = sk
        self.pk = pk
    }
}

public enum ProtoError: Error {
    case invalidKey
    case invalidData
}

/// Values accepted by `Proto.lv` (strings are UTF-8 encoded).
public protocol LVPart {
    var lvBytes: Data { get }
}

extension String: LVPart {
    public var lvBytes: Data { Data(utf8) }
}

extension Data: LVPart {
    public var lvBytes: Data { self }
}

public enum Proto {
    public static let version = 2
    public static let chunkSize = 1024 * 1024
    public static let tagSize = 16
    static let zeroNonce = Data(count: 12)

    // MARK: encoding

    public static func b64(_ data: Data) -> String { data.base64EncodedString() }

    public static func unb64(_ text: String) throws -> Data {
        guard let data = Data(base64Encoded: text) else { throw ProtoError.invalidData }
        return data
    }

    public static func unb64url(_ text: String) throws -> Data {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return try unb64(s)
    }

    public static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    static func u32(_ n: UInt32) -> Data { withUnsafeBytes(of: n.bigEndian) { Data($0) } }
    static func u64(_ n: UInt64) -> Data { withUnsafeBytes(of: n.bigEndian) { Data($0) } }

    /// Length-prefixed concatenation, as in protocol.js `lv`.
    public static func lv(_ parts: LVPart...) -> Data {
        var out = Data()
        for part in parts {
            let bytes = part.lvBytes
            out += u32(UInt32(bytes.count))
            out += bytes
        }
        return out
    }

    public static func sameBytes(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    // MARK: primitives

    public static func sha256(_ parts: Data...) -> Data {
        var hasher = SHA256()
        for p in parts { hasher.update(data: p) }
        return Data(hasher.finalize())
    }

    public static func mac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    public static func kdf(_ ikm: Data, salt: Data, info: String, length: Int = 32) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data(info.utf8), outputByteCount: length
        )
        return key.withUnsafeBytes { Data($0) }
    }

    /// ChaCha20-Poly1305 (RFC 8439); returns ciphertext || tag like the JS side.
    public static func seal(_ key: Data, nonce: Data, _ plain: Data, aad: Data) throws -> Data {
        let box = try ChaChaPoly.seal(plain, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    public static func open(_ key: Data, nonce: Data, _ sealed: Data, aad: Data) throws -> Data {
        guard sealed.count >= tagSize else { throw ProtoError.invalidData }
        let box = try ChaChaPoly.SealedBox(
            nonce: ChaChaPoly.Nonce(data: nonce),
            ciphertext: sealed.prefix(sealed.count - tagSize),
            tag: sealed.suffix(tagSize)
        )
        return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }

    public static func sealJson(_ key: Data, _ label: String, _ value: [String: Any]) throws -> String {
        let json = try JSONSerialization.data(withJSONObject: value)
        return b64(try seal(key, nonce: zeroNonce, json, aad: Data(label.utf8)))
    }

    public static func openJson(_ key: Data, _ label: String, _ text: String) throws -> [String: Any] {
        let plain = try open(key, nonce: zeroNonce, try unb64(text), aad: Data(label.utf8))
        guard let object = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw ProtoError.invalidData }
        return object
    }

    // MARK: identity

    public static func newKeyPair() -> KeyPair {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(sk: key.rawRepresentation, pk: key.publicKey.rawRepresentation)
    }

    public static func publicKey(of sk: Data) throws -> Data {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: sk).publicKey.rawRepresentation
    }

    public static func dh(_ sk: Data, _ pk: Data) throws -> Data {
        let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: sk)
        let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pk)
        let out = try priv.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Data($0) }
        if out.allSatisfy({ $0 == 0 }) { throw ProtoError.invalidKey } // low-order point
        return out
    }

    public static func deviceId(_ pk: Data) -> String { hex(sha256(Data("wavedrop-id".utf8), pk).prefix(10)) }

    /// 12 digits both people can compare ("codice di sicurezza").
    public static func safetyCode(_ pk: Data) -> String {
        let h = [UInt8](sha256(Data("wavedrop-safety".utf8), pk))
        var digits = ""
        var i = 0
        while digits.count < 12 {
            let v = ((Int(h[i]) << 8) | Int(h[i + 1])) % 1000
            digits += String(format: "%03d", v)
            i += 2
        }
        let d = Array(digits.prefix(12))
        return "\(String(d[0..<4])) \(String(d[4..<8])) \(String(d[8..<12]))"
    }

    /// Long-term key shared by two paired devices (both sides compute the same).
    public static func pairKey(_ sk: Data, myPk: Data, otherPk: Data, purpose: String) throws -> Data {
        let mine = [UInt8](myPk)
        let theirs = [UInt8](otherPk)
        let mineFirst = mine.lexicographicallyPrecedes(theirs) || mine == theirs
        let salt = mineFirst ? myPk + otherPk : otherPk + myPk
        return kdf(try dh(sk, otherPk), salt: salt, info: "wavedrop \(purpose) v\(version)")
    }

    public static func qrProof(_ secret: Data, _ label: String, _ a: Data, _ b: Data) -> String {
        b64(mac(secret, lv(label, a, b)))
    }

    // MARK: transfer handshake

    public struct Sealed {
        public let ephemeral: KeyPair
        public let k1: Data
        public let e: String
        public let ct: String
    }

    public struct Opened {
        public let eA: Data
        public let k1: Data
        public let request: [String: Any]
    }

    public struct Answer {
        public let key: Data
        public let e: String
        public let ct: String
    }

    /// Sender → receiver: seal the request (file list, thumbnail, text…).
    public static func askSeal(sk: Data, pk: Data, peerPk: Data, request: [String: Any], ephemeral: KeyPair = newKeyPair()) throws -> Sealed {
        let salt = sha256(lv("wd-ask", pk, peerPk, ephemeral.pk))
        let k1 = kdf(try dh(ephemeral.sk, peerPk) + dh(sk, peerPk), salt: salt, info: "wavedrop ask")
        return Sealed(ephemeral: ephemeral, k1: k1, e: b64(ephemeral.pk), ct: try sealJson(k1, "wd-ask", request))
    }

    /// Receiver: open a request with the sender's pinned public key.
    public static func askOpen(sk: Data, pk: Data, peerPk: Data, e: String, ct: String) throws -> Opened {
        let eA = try unb64(e)
        let salt = sha256(lv("wd-ask", peerPk, pk, eA))
        let k1 = kdf(try dh(sk, eA) + dh(sk, peerPk), salt: salt, info: "wavedrop ask")
        return Opened(eA: eA, k1: k1, request: try openJson(k1, "wd-ask", ct))
    }

    static func sessionKey(_ dhEE: Data, _ dhES: Data, _ k1: Data, _ eA: Data, _ eB: Data) -> Data {
        kdf(dhEE + dhES + k1, salt: sha256(lv("wd-session", eA, eB)), info: "wavedrop session")
    }

    /// Receiver → sender: answer with a fresh ephemeral key (forward secrecy).
    public static func answerSeal(k1: Data, eA: Data, peerPk: Data, answer: [String: Any], ephemeral: KeyPair = newKeyPair()) throws -> Answer {
        let key = sessionKey(try dh(ephemeral.sk, eA), try dh(ephemeral.sk, peerPk), k1, eA, ephemeral.pk)
        return Answer(key: key, e: b64(ephemeral.pk), ct: try sealJson(key, "wd-answer", answer))
    }

    public static func answerOpen(k1: Data, sk: Data, ephemeral: KeyPair, e: String, ct: String) throws -> (key: Data, answer: [String: Any]) {
        let eB = try unb64(e)
        let key = sessionKey(try dh(ephemeral.sk, eB), try dh(sk, eB), k1, ephemeral.pk, eB)
        return (key, try openJson(key, "wd-answer", ct))
    }

    // MARK: file chunks

    public static func chunkNonce(file: Int, index: Int) -> Data { u32(UInt32(file)) + u64(UInt64(index)) }

    public static func chunkAad(session: String, file: Int, index: Int, last: Bool) -> Data {
        Data("wd-chunk".utf8) + lv(session) + u32(UInt32(file)) + u64(UInt64(index)) + Data([last ? 1 : 0])
    }

    public static func sealChunk(_ key: Data, session: String, file: Int, index: Int, last: Bool, _ data: Data) throws -> Data {
        try seal(key, nonce: chunkNonce(file: file, index: index), data, aad: chunkAad(session: session, file: file, index: index, last: last))
    }

    public static func openChunk(_ key: Data, session: String, file: Int, index: Int, last: Bool, _ data: Data) throws -> Data {
        try open(key, nonce: chunkNonce(file: file, index: index), data, aad: chunkAad(session: session, file: file, index: index, last: last))
    }

    public static func chunkCount(_ size: Int) -> Int { max(1, (size + chunkSize - 1) / chunkSize) }
}

/// «foto.jpg», la cartella «Foto», 3 elementi, un testo — same wording as the PC.
public func describePayload(names: [String], text: String?) -> String {
    if names.isEmpty, text != nil { return "un testo" }
    var tops: [String] = []
    for name in names {
        let top = String(name.split(separator: "/", omittingEmptySubsequences: false).first ?? "")
        if !tops.contains(top) { tops.append(top) }
    }
    if tops.count == 1 { return names.contains { $0.contains("/") } ? "la cartella «\(tops[0])»" : "«\(tops[0])»" }
    return "\(tops.count) elementi"
}

/// The link inside the PC's QR code: http://ip:port/m/#k=<secret>&p=<PC key>
public struct PairingLink: Sendable {
    public let base: String
    public let secret: Data
    public let pcPk: Data

    public init?(_ text: String) {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("wavedrop://") {
            guard let inner = URLComponents(string: raw)?.queryItems?.first(where: { $0.name == "u" })?.value else { return nil }
            raw = inner
        }
        guard let url = URLComponents(string: raw), let scheme = url.scheme, scheme == "http" || scheme == "https",
              let host = url.host, let fragment = url.percentEncodedFragment else { return nil }
        var params: [String: String] = [:]
        for pair in fragment.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { params[kv[0]] = kv[1] }
        }
        guard let k = params["k"], let p = params["p"],
              let secret = try? Proto.unb64url(k), let pcPk = try? Proto.unb64url(p),
              secret.count == 16, pcPk.count == 32 else { return nil }
        base = "\(scheme)://\(host)" + (url.port.map { ":\($0)" } ?? "")
        self.secret = secret
        self.pcPk = pcPk
    }
}
