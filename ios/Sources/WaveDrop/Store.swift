#if os(iOS)
import Foundation
import Security
import UIKit
import WaveDropKit

/// A PC this iPhone is paired with (through its QR code).
struct Pc: Codable, Identifiable, Equatable {
    let id: String
    let pk: String
    var name: String
    let platform: String
    let url: String // http://ip:port
    let addedAt: Date

    var pkData: Data { (try? Proto.unb64(pk)) ?? Data() }
}

/// Identity (private key in the Keychain, this device only), paired PCs and
/// preferences.
final class Store {
    private let defaults = UserDefaults.standard
    let identity: KeyPair

    init() {
        if let sk = Keychain.read("identity"), let pk = try? Proto.publicKey(of: sk) {
            identity = KeyPair(sk: sk, pk: pk)
        } else {
            identity = Proto.newKeyPair()
            Keychain.write("identity", identity.sk)
        }
    }

    var id: String { Proto.deviceId(identity.pk) }

    var name: String {
        get { defaults.string(forKey: "name") ?? UIDevice.current.name }
        set {
            let trimmed = newValue.trimmingCharacters(in: .whitespaces)
            defaults.set(trimmed.isEmpty ? nil : String(trimmed.prefix(40)), forKey: "name")
        }
    }

    var pcs: [Pc] {
        get {
            guard let data = defaults.data(forKey: "pcs") else { return [] }
            return (try? JSONDecoder().decode([Pc].self, from: data)) ?? []
        }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "pcs") }
    }

    func save(_ pc: Pc) { pcs = pcs.filter { $0.id != pc.id } + [pc] }
    func remove(_ id: String) { pcs = pcs.filter { $0.id != id } }
}

enum Keychain {
    private static let service = "app.wavedrop.ios"

    static func read(_ account: String) -> Data? {
        var result: AnyObject?
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func write(_ account: String, _ data: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
#endif
