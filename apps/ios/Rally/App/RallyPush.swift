import Foundation

/// Apple push identity and payload parsing for the iOS topic. Registration
/// itself is REST (`PUT /push-devices/:installationId`) against the workspace
/// session; this type is the shared shape, not the network call.
enum RallyPush {
    static let platform = "ios"
    static let transport = "apns"
    static let topic = APIConfiguration.bundleIdentifier
    static let preferenceKey = "rally.push.enabled"

    static var apnsEnvironment: String {
        #if RALLY_DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
    }

    static func preferenceEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: preferenceKey) as? Bool ?? true
    }

    static func hexDeviceToken(_ data: Data) -> String {
        data.map { String(format: "%02.2hhx", $0) }.joined()
    }

    /// The `kind` values `PushNotificationDataSchema` admits: every Activity row.
    static let pushKinds: Set<String> = [
        "mention", "new_message", "participant_added", "thread_started", "breakout_started", "run_finished", "merged",
        "artifact_updated",
    ]

    /// Same `rally` object desktop parses with `PushNotificationDataSchema`.
    static func workstreamURL(from userInfo: [AnyHashable: Any]) -> URL? {
        guard let rally = dictionary(userInfo["rally"]) else { return nil }
        let version: Int?
        if let int = rally["v"] as? Int {
            version = int
        } else if let number = rally["v"] as? NSNumber {
            version = number.intValue
        } else {
            version = nil
        }
        guard version == 1 else { return nil }
        guard let kind = rally["kind"] as? String, pushKinds.contains(kind) else {
            return nil
        }
        guard rally["workspaceId"] is String, rally["region"] is String else { return nil }
        guard let raw = rally["url"] as? String, let url = URL(string: raw), url.scheme?.lowercased() == "https" else {
            return nil
        }
        return url
    }

    private static func dictionary(_ value: Any?) -> [AnyHashable: Any]? {
        if let dict = value as? [AnyHashable: Any] { return dict }
        if let data = value as? Data {
            return (try? JSONSerialization.jsonObject(with: data)) as? [AnyHashable: Any]
        }
        if let raw = value as? String, let data = raw.data(using: .utf8) {
            return (try? JSONSerialization.jsonObject(with: data)) as? [AnyHashable: Any]
        }
        return nil
    }
}

struct RallyPushDeviceRegistration: Encodable {
    var platform: String
    var transport: String
    var topic: String
    var apnsEnvironment: String
    var token: String
    var appVersion: String

    static func current(token: String) -> RallyPushDeviceRegistration {
        RallyPushDeviceRegistration(
            platform: RallyPush.platform,
            transport: RallyPush.transport,
            topic: RallyPush.topic,
            apnsEnvironment: RallyPush.apnsEnvironment,
            token: token,
            appVersion: RallyPush.appVersion
        )
    }
}

struct RallyClientFeatureFlags: Decodable {
    var pushNotificationsEnabled: Bool?
}
