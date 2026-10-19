#if os(iOS)
import SwiftUI
import VisionKit
import WaveDropKit

struct SettingsView: View {
    @EnvironmentObject private var hub: Hub
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var removing: Pc?
    @StateObject private var update = UpdateCheck()

    var body: some View {
        NavigationStack {
            Form {
                Section("Questo iPhone") {
                    TextField("Nome visto dai PC", text: $name)
                        .onSubmit { hub.store.name = name }
                    LabeledContent("Codice di sicurezza", value: Proto.safetyCode(hub.store.identity.pk))
                }
                Section {
                    ForEach(hub.pcs) { pc in
                        HStack(spacing: 12) {
                            AvatarView(name: pc.name, size: 40, online: hub.online.contains(pc.id))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(pc.name).font(.body.weight(.semibold))
                                Text("Codice \(Proto.safetyCode(pc.pkData))").font(.caption).foregroundStyle(.secondary)
                                Text(pc.url.replacingOccurrences(of: "http://", with: "")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Rimuovi", role: .destructive) { removing = pc }.buttonStyle(.borderless)
                        }
                    }
                } header: {
                    Text("PC collegati")
                } footer: {
                    Text("I file viaggiano cifrati end-to-end (X25519 + ChaCha20-Poly1305): solo questo iPhone e il PC possono leggerli. I codici di sicurezza devono coincidere con quelli nelle Impostazioni di WaveDrop sul PC. iOS sospende le app in background: per ricevere, tieni WaveDrop aperto.")
                }
                Section {
                    if update.available, let latest = update.latest {
                        LabeledContent("È disponibile WaveDrop \(latest)", value: "hai la \(About.version)")
                        Link("Come aggiornare l'app", destination: About.updateHelp)
                    } else {
                        LabeledContent(update.latest == nil ? "Versione \(About.version)" : "È la versione più recente", value: About.version)
                    }
                    Button(update.checking ? "Controllo in corso…" : "Controlla ora") { Task { await update.check() } }
                        .disabled(update.checking)
                } header: {
                    Text("Aggiornamenti")
                } footer: {
                    Text("L'app installata con xtool non può aggiornarsi da sola: va ricompilata dai sorgenti nuovi, come la prima volta.")
                }
                Section("Informazioni") {
                    LabeledContent("Versione", value: About.version)
                    LabeledContent("Autore", value: About.author)
                    LabeledContent("Licenza", value: "MIT · © 2026 \(About.author)")
                    if let repo = About.repo { Link("Codice sorgente su GitHub", destination: repo) }
                }
                Section {
                    ForEach(About.credits, id: \.name) { credit in
                        Link(destination: credit.url) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(credit.name) · \(credit.by)").foregroundStyle(.primary)
                                Text(credit.what).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Ringraziamenti")
                } footer: {
                    Text("AirDrop e iPhone sono marchi di Apple Inc.; WaveDrop è un progetto indipendente, non affiliato ad Apple.")
                }
            }
            .navigationTitle("Impostazioni")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fine") {
                        hub.store.name = name
                        dismiss()
                    }
                }
            }
            .onAppear { name = hub.store.name }
            .task { await update.check() }
            .alert("Scollegare \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Scollega", role: .destructive) {
                    if let pc = removing { hub.remove(pc) }
                    removing = nil
                }
                Button("Annulla", role: .cancel) { removing = nil }
            } message: {
                Text("Per ricollegarlo servirà un nuovo codice QR.")
            }
        }
    }
}

/// Camera QR scanner (VisionKit), with a fallback when the device can't scan.
enum About {
    static let author = "Matteo Davanzo"
    /// The project's GitHub page.
    static let repo = URL(string: "https://github.com/M4Tronick/WaveDrop")
    static let updateHelp = URL(string: "https://github.com/M4Tronick/WaveDrop/blob/main/ios/README.md")!

    /// "1.2.3" > "1.2.0"; pre-release suffixes are ignored.
    static func isNewer(_ a: String, than b: String) -> Bool {
        func parts(_ v: String) -> [Int] {
            v.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(whereSeparator: { $0 == "." || $0 == "-" }).map { Int($0) ?? 0 }
        }
        let pa = parts(a), pb = parts(b)
        for i in 0..<3 {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.3" }

    struct Credit { let name, by, what: String; let url: URL }
    static let credits = [
        Credit(name: "OpenDrop", by: "SEEMOO, TU Darmstadt", what: "Studio del protocollo AirDrop", url: URL(string: "https://github.com/seemoo-lab/opendrop")!),
        Credit(name: "OWL", by: "SEEMOO, TU Darmstadt", what: "AWDL aperto, la radio Wi-Fi di AirDrop", url: URL(string: "https://github.com/seemoo-lab/owl")!),
        Credit(name: "omdrop-owl", by: "t4t5", what: "Ponte AirDrop su Linux", url: URL(string: "https://github.com/t4t5/omdrop-owl")!),
        Credit(name: "omdrop-plugin", by: "netmojo-systems", what: "Ponte AirDrop su Linux", url: URL(string: "https://github.com/netmojo-systems/omdrop-plugin")!),
        Credit(name: "xtool", by: "xtool-org", what: "Questa app, compilata senza Mac", url: URL(string: "https://github.com/xtool-org/xtool")!),
        Credit(name: "swift-crypto", by: "Apple", what: "Crittografia", url: URL(string: "https://github.com/apple/swift-crypto")!),
    ]
}

/// The latest release on GitHub, compared with this app's version.
@MainActor
final class UpdateCheck: ObservableObject {
    @Published var latest: String?
    @Published var checking = false

    var available: Bool { latest.map { About.isNewer($0, than: About.version) } ?? false }

    func check() async {
        checking = true
        defer { checking = false }
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/M4Tronick/WaveDrop/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String else { return }
        latest = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
    }
}

struct ScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    QRScanner(onCode: onCode).ignoresSafeArea()
                } else {
                    ContentUnavailableView(
                        "Scanner non disponibile",
                        systemImage: "camera",
                        description: Text("Consenti l'accesso alla fotocamera in Impostazioni, oppure usa «Incolla il link».")
                    )
                }
            }
            .navigationTitle("Inquadra il QR del PC")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } }
            }
        }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in items {
                if case .barcode(let code) = item, let text = code.payloadStringValue, PairingLink(text) != nil {
                    done = true
                    scanner.stopScanning()
                    onCode(text)
                    return
                }
            }
        }
    }
}
#endif
