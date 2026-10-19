#if os(iOS)
import SwiftUI
import VisionKit
import WaveDropKit

struct SettingsView: View {
    @EnvironmentObject private var hub: Hub
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var removing: Pc?

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
    /// The project's GitHub page; nil until the repository exists.
    static let repo: URL? = nil
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0" }

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
