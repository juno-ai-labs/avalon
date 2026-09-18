import SwiftUI
import UIKit

@main
struct RallyApp: App {
    @UIApplicationDelegateAdaptor(RallyAppDelegate.self) private var appDelegate
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .rallyColors()
                .preferredColorScheme(model.preferredColorScheme)
                .tint(RallyPalette.linkBlue)
                .task {
                    appDelegate.attach(model)
                    await model.bootstrap()
                }
                .onOpenURL { url in
                    Task { await model.handleIncomingURL(url) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await model.resumeSockets()
                    await model.reconcilePushRegistration()
                }
            }
        }
    }
}
