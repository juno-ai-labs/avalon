import Foundation

enum APIConfiguration {
    static let defaultGlobalURL = URL(string: "https://api.rallywith.ai")!
    static let defaultEUURL = URL(string: "https://eu.api.rallywith.ai")!
    static let webBaseURL = URL(string: "https://rallywith.ai")!
    static let privacyURL = URL(string: "https://rallywith.ai/trust/privacy")!
    static let termsURL = URL(string: "https://rallywith.ai/trust/terms")!
    static let supportURL = URL(string: "https://rallywith.ai")!
    static let returnURI = URL(string: "rallywithai://auth/complete")!
    static let bundleIdentifier = "ai.rallywith.ios"
    static let messageMaxCharacters = 100_000
    static let operationHeader = "x-rally-operation-id"
    static let draftHeader = "x-rally-draft-id"
    static let socketTicketSubprotocol = "rally.ticket.v1"

    static func globalURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["RALLY_API_GLOBAL_URL"],
           let url = URL(string: override) {
            return url
        }
        if let stored = UserDefaults.standard.string(forKey: "rally.api.global"),
           let url = URL(string: stored) {
            return url
        }
        return defaultGlobalURL
    }

    static func euURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["RALLY_API_EU_URL"],
           let url = URL(string: override) {
            return url
        }
        return defaultEUURL
    }

    static func url(for region: RallyRegion) -> URL {
        region == .eu ? euURL() : globalURL()
    }
}

enum JSONCoding {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = ISO8601DateFormatter.full.date(from: raw)
                ?? ISO8601DateFormatter.fractional.date(from: raw) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date \(raw)")
        }
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

extension ISO8601DateFormatter {
    static let full: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
