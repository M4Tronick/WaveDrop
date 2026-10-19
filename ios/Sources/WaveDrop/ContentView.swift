#if os(iOS)
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import WaveDropKit

let accent = Color(red: 10 / 255, green: 132 / 255, blue: 1)

struct ContentView: View {
    @EnvironmentObject private var hub: Hub
    @State private var selectedId: String?
    @State private var showScanner = false
    @State private var showSettings = false
    @State private var showFiles = false
    @State private var showText = false
    @State private var showPaste = false
    @State private var draft = ""
    @State private var photoItems: [PhotosPickerItem] = []

    private var target: Pc? {
        hub.pcs.first { $0.id == selectedId } ?? hub.pcs.first { hub.online.contains($0.id) } ?? hub.pcs.first
    }

    private var targetOnline: Bool { target.map { hub.online.contains($0.id) } ?? false }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if hub.pcs.isEmpty {
                        onboarding
                    } else {
                        pcsRow
                        actions
                    }
                    if !hub.transfers.isEmpty {
                        Text("TRASFERIMENTI").font(.footnote).foregroundStyle(.secondary).padding(.top, 10).padding(.leading, 6)
                    }
                    ForEach(hub.transfers) { TransferRow(transfer: $0) }
                    if !hub.pcs.isEmpty {
                        Button("Collega un altro PC") { showScanner = true }.frame(maxWidth: .infinity).padding(.top, 6)
                    }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("WaveDrop")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .sheet(isPresented: $showScanner) {
                ScannerSheet { code in
                    showScanner = false
                    hub.pair(code)
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView().environmentObject(hub) }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result, let pc = target { hub.send(pickedURLs: urls, to: pc) }
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty, let pc = target else { return }
                photoItems = []
                Task { await sendPhotos(items, to: pc) }
            }
            .alert("Invia a \(target?.name ?? "PC")", isPresented: $showText) {
                TextField("Testo o link", text: $draft)
                Button("Invia") {
                    if let pc = target, !draft.trimmingCharacters(in: .whitespaces).isEmpty { hub.send(files: [], text: draft, to: pc) }
                    draft = ""
                }
                Button("Annulla", role: .cancel) { draft = "" }
            }
            .alert("Incolla il link del PC", isPresented: $showPaste) {
                TextField("http://192.168.…/m/#k=…", text: $draft)
                Button("Collega") {
                    hub.pair(draft)
                    draft = ""
                }
                Button("Annulla", role: .cancel) { draft = "" }
            }
            .overlay(alignment: .bottom) { banner }
            .onAppear { hub.connectAll() }
        }
    }

    // MARK: sections

    private var onboarding: some View {
        VStack(spacing: 12) {
            Image(systemName: "desktopcomputer").font(.system(size: 46)).foregroundStyle(accent)
            Text("Collega il tuo PC").font(.title2.bold())
            Text("Sul PC apri WaveDrop e scegli «Collega telefono». Poi inquadra il codice QR: iPhone e PC si scambiano le chiavi di cifratura.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button {
                showScanner = true
            } label: {
                Label("Scansiona il codice QR", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            Button("Oppure incolla il link") { showPaste = true }
        }
        .padding(22)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private var pcsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(hub.pcs) { pc in
                    let online = hub.online.contains(pc.id)
                    Button {
                        selectedId = pc.id
                    } label: {
                        VStack(spacing: 4) {
                            AvatarView(name: pc.name, size: 72, online: online, selected: pc.id == target?.id)
                            Text(pc.name).font(.footnote.weight(.medium)).lineLimit(1).foregroundStyle(.primary)
                            Text(online ? "Connesso" : "Non raggiungibile").font(.caption2)
                                .foregroundStyle(online ? .green : .secondary)
                        }
                        .frame(width: 96)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                PhotosPicker(selection: $photoItems, matching: .any(of: [.images, .videos])) {
                    ActionTile(icon: "photo.on.rectangle", label: "Foto e video", enabled: targetOnline)
                }
                .disabled(!targetOnline)
                Button { showFiles = true } label: { ActionTile(icon: "doc", label: "File", enabled: targetOnline) }
                    .disabled(!targetOnline)
                Button { showText = true } label: { ActionTile(icon: "text.alignleft", label: "Testo o link", enabled: targetOnline) }
                    .disabled(!targetOnline)
            }
            .buttonStyle(.plain)
            if let pc = target, !targetOnline {
                Text("\(pc.name) non è raggiungibile: apri WaveDrop sul PC e collegati alla stessa rete Wi-Fi.")
                    .font(.footnote).foregroundStyle(.secondary).padding(.leading, 4)
            }
        }
    }

    @ViewBuilder private var banner: some View {
        if let message = hub.banner {
            Text(message)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.thinMaterial, in: Capsule())
                .padding(.bottom, 20)
                .onTapGesture { hub.banner = nil }
                .task {
                    try? await Task.sleep(nanoseconds: 3_500_000_000)
                    hub.banner = nil
                }
        }
    }

    private func sendPhotos(_ items: [PhotosPickerItem], to pc: Pc) async {
        var files: [OutgoingFile] = []
        for item in items {
            guard let picked = try? await item.loadTransferable(type: PickedMedia.self) else { continue }
            let size = (try? picked.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            files.append(OutgoingFile(url: picked.url, name: picked.url.lastPathComponent, size: size,
                                      type: UTType(filenameExtension: picked.url.pathExtension)))
        }
        if files.isEmpty {
            hub.banner = "Impossibile leggere gli elementi scelti"
        } else {
            hub.send(files: files, text: nil, to: pc)
        }
    }
}

/// A photo or video from the picker, copied to a temporary file.
struct PickedMedia: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMedia(url: copy)
        }
    }
}

// MARK: - components

func initials(_ name: String) -> String {
    let letters = name.split(whereSeparator: \.isWhitespace).compactMap { $0.first(where: \.isLetter) }
    let picked = letters.count > 1 ? [letters.first!, letters.last!] : letters
    let text = String(picked).uppercased()
    return text.isEmpty ? "?" : text
}

struct AvatarView: View {
    let name: String
    let size: CGFloat
    var online: Bool?
    var selected = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Circle()
                .fill(LinearGradient(colors: [Color(white: 0.68), Color(white: 0.54)], startPoint: .top, endPoint: .bottom))
                .overlay(Text(initials(name)).font(.system(size: size * 0.36, weight: .medium)).foregroundStyle(.white))
                .padding(selected ? 5 : 0)
                .overlay(Circle().stroke(selected ? accent : .clear, lineWidth: 3))
            if let online {
                Circle().fill(online ? Color.green : Color.gray)
                    .frame(width: size * 0.22, height: size * 0.22)
                    .overlay(Circle().stroke(Color(.systemGroupedBackground), lineWidth: 3))
            }
        }
        .frame(width: size, height: size)
    }
}

struct ActionTile: View {
    let icon: String
    let label: String
    let enabled: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(enabled ? accent : .gray, in: RoundedRectangle(cornerRadius: 10))
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(enabled ? .primary : .secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}

struct TransferRow: View {
    @EnvironmentObject private var hub: Hub
    let transfer: Transfer

    private var headline: Text {
        let who = Text(transfer.peer).bold()
        switch (transfer.direction, transfer.status) {
        case (.outgoing, .done): return Text("Inviato \(transfer.what) a ") + who
        case (.outgoing, _): return Text("Invio di \(transfer.what) a ") + who
        case (.incoming, .offer): return who + Text(" vuole inviarti \(transfer.what).")
        case (.incoming, .done): return Text("Ricevuto \(transfer.what) da ") + who
        default: return Text("Ricezione di \(transfer.what) da ") + who
        }
    }

    private var statusLine: (String, Color) {
        let size = ByteCountFormatter.string(fromByteCount: Int64(transfer.size), countStyle: .file)
        switch transfer.status {
        case .sending, .receiving: return ("\(Int(transfer.progress * 100))% di \(size)", .secondary)
        case .done: return (transfer.note ?? size, .green)
        case .failed, .declined: return (transfer.note ?? "Non riuscito", .red)
        case .cancelled: return (transfer.note ?? "Annullato", .secondary)
        case .offer: return (transfer.size > 0 ? size : "Testo", .secondary)
        default: return (transfer.note ?? "", .secondary)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Group {
                    if let image = transfer.thumbnail {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Image(systemName: transfer.what == "un testo" ? "text.alignleft" : "doc").foregroundStyle(.secondary)
                    }
                }
                .frame(width: 48, height: 48)
                .background(Color(.tertiarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    headline.font(.subheadline)
                    Text(statusLine.0).font(.footnote).foregroundStyle(statusLine.1)
                }
                Spacer(minLength: 0)
                if !transfer.status.active {
                    Button { hub.dismiss(transfer.id) } label: { Image(systemName: "xmark").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                }
            }
            if transfer.status == .sending || transfer.status == .receiving {
                ProgressView(value: transfer.progress).tint(accent)
            }
            if transfer.direction == .incoming, let text = transfer.text, transfer.status == .offer || transfer.status == .done {
                Text(text).font(.subheadline).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10).background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                if transfer.status == .done {
                    HStack {
                        Button("Copia") { UIPasteboard.general.string = text }.buttonStyle(.bordered)
                        if let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), ["http", "https"].contains(url.scheme ?? "") {
                            Link("Apri link", destination: url).buttonStyle(.borderedProminent)
                        }
                    }
                }
            }
            ForEach(transfer.files) { file in
                HStack {
                    VStack(alignment: .leading) {
                        Text(file.name).font(.subheadline).lineLimit(2)
                        Text(file.inPhotos ? "Salvato in Foto e in File › WaveDrop" : "In File › WaveDrop")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    ShareLink(item: file.url) { Image(systemName: "square.and.arrow.up") }
                }
            }
            switch transfer.status {
            case .offer:
                HStack {
                    Button { hub.decline(transfer.id) } label: { Text("Rifiuta").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
                    Button { hub.accept(transfer.id) } label: { Text("Accetta").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
                }
                .controlSize(.large)
            case .preparing, .waiting, .sending, .receiving:
                Button { hub.cancel(transfer.id) } label: { Text("Annulla").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).controlSize(.large)
            default:
                EmptyView()
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}
#endif
