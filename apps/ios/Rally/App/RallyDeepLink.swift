import Foundation

/// Parses the two URL shapes iOS is allowed to open: the Google return
/// `rallywithai://auth/complete?ticket=…` and a work-stream universal link
/// `/app/workspaces/:workspaceId/workstreams/:id`.
enum RallyDeepLink {
    static func authTicket(from url: URL) -> String? {
        guard url.scheme == "rallywithai" else { return nil }
        guard url.host == "auth" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return items.first(where: { $0.name == "ticket" })?.value
    }

    static func authError(from url: URL) -> String? {
        guard url.scheme == "rallywithai", url.host == "auth" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return items.first(where: { $0.name == "error" })?.value
    }

    static func workstreamId(from url: URL) -> String? {
        let parts = url.path.split(separator: "/").map(String.init)
        guard let index = parts.firstIndex(of: "workstreams"), index + 1 < parts.count else {
            return nil
        }
        let value = parts[index + 1]
        return value.isEmpty ? nil : value
    }
}
