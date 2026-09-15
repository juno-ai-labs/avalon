import UIKit
import UserNotifications

/// UIKit callbacks for APNs tokens and notification taps. Registration is
/// `AppModel.reconcilePushRegistration`; this object only forwards.
final class RallyAppDelegate: NSObject, UIApplicationDelegate {
    private weak var model: AppModel?
    private var pendingToken: String?
    private var pendingURL: URL?

    func attach(_ model: AppModel) {
        self.model = model
        if let token = pendingToken {
            pendingToken = nil
            Task { @MainActor in await model.didReceivePushDeviceToken(token) }
        }
        if let url = pendingURL {
            pendingURL = nil
            Task { @MainActor in await model.openPushURL(url) }
        }
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        forward(token: RallyPush.hexDeviceToken(deviceToken))
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Simulator and unsigned Debug builds have no APNs token. Delivery is
        // skipped until a signed device registers; do not clear a prior token.
    }

    private func forward(token: String) {
        if let model {
            Task { @MainActor in await model.didReceivePushDeviceToken(token) }
        } else {
            pendingToken = token
        }
    }

    private func forward(url: URL) {
        if let model {
            Task { @MainActor in await model.openPushURL(url) }
        } else {
            pendingURL = url
        }
    }
}

extension RallyAppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let url = RallyPush.workstreamURL(from: response.notification.request.content.userInfo) else {
            return
        }
        forward(url: url)
    }
}
