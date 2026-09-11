import UIKit
import UserNotifications

/// Receives APNs device tokens. The Worker does not yet accept an iOS topic
/// (`docs/PRDs/2026-09-11_apple-push-notifications/design.md`); the token is
/// stored on-device so a later client change can register it without a second
/// permission prompt.
final class RallyAppDelegate: NSObject, UIApplicationDelegate {
    static let deviceTokenDefaultsKey = "rally.apns.deviceToken"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        UserDefaults.standard.set(token, forKey: Self.deviceTokenDefaultsKey)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        UserDefaults.standard.removeObject(forKey: Self.deviceTokenDefaultsKey)
    }
}

extension RallyAppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }
}
