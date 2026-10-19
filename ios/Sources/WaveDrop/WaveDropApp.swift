// The app itself is iOS-only; on Linux (`swift test`) this target is empty.
#if os(iOS)
import SwiftUI

@main
struct WaveDropApp: App {
    @StateObject private var hub = Hub()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(hub)
                .onOpenURL { url in hub.handle(url: url) }
        }
        .onChange(of: phase) { _, phase in
            // iOS suspends apps in the background: keep the PC links only while visible.
            if phase == .active { hub.connectAll() } else if phase == .background { hub.disconnectAll() }
        }
    }
}
#endif
