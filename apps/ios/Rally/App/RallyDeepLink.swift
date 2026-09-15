import Foundation

/// Parses the two URL shapes iOS is allowed to open: the Google return
/// `rallywithai://auth/complete?ticket=…` and a work-stream universal link
/// `/app/workspaces/:workspaceId/workstreams/:id` (optionally `/substreams/:child`
/// or `?substream=`). `"0"` is Main and is omitted from the returned child id.
enum RallyDeepLink {
    struct WorkstreamTarget: Equatable {
        var region: RallyRegion? = nil
        var workspaceId: String? = nil
        var workstreamId: String
        var substreamId: String
    }

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
        workstreamTarget(from: url)?.workstreamId
    }

    static func workstreamTarget(from url: URL) -> WorkstreamTarget? {
        if url.scheme == "rallywithai", url.host == "workstreams" {
            let parts = url.path.split(separator: "/").map(String.init)
            guard let workstreamId = parts.first, !workstreamId.isEmpty, workstreamId != "new" else {
                return nil
            }
            var substreamId = SubstreamAddress.main
            if let index = parts.firstIndex(of: "substreams"), index + 1 < parts.count {
                substreamId = parts[index + 1]
            }
            return WorkstreamTarget(workstreamId: workstreamId, substreamId: normalized(substreamId, query: url))
        }
        let parts = url.path.split(separator: "/").map(String.init)
        guard let index = parts.firstIndex(of: "workstreams"), index + 1 < parts.count else {
            return nil
        }
        let workstreamId = parts[index + 1]
        guard !workstreamId.isEmpty, workstreamId != "new" else { return nil }
        var substreamId = SubstreamAddress.main
        if index + 3 < parts.count, parts[index + 2] == "substreams" {
            substreamId = parts[index + 3]
        }
        var region: RallyRegion?
        var workspaceId: String?
        if let workspaceIndex = parts.firstIndex(of: "workspaces"), workspaceIndex + 1 < index {
            let first = parts[workspaceIndex + 1]
            if index == workspaceIndex + 3, let parsed = RallyRegion(rawValue: first) {
                region = parsed
                workspaceId = parts[workspaceIndex + 2]
            } else if index == workspaceIndex + 2 {
                workspaceId = first
            }
        }
        return WorkstreamTarget(
            region: region,
            workspaceId: workspaceId,
            workstreamId: workstreamId,
            substreamId: normalized(substreamId, query: url)
        )
    }

    private static func normalized(_ pathSubstream: String, query url: URL) -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = items.first(where: { $0.name == "substream" })?.value
        let value = (query?.isEmpty == false ? query : pathSubstream) ?? SubstreamAddress.main
        return value.isEmpty ? SubstreamAddress.main : value
    }

    static func canonicalURL(
        webBase: URL = APIConfiguration.webBaseURL,
        region: RallyRegion,
        workspaceId: String,
        workstreamId: String,
        substreamId: String = SubstreamAddress.main
    ) -> URL? {
        var path = "/app/workspaces/\(region.rawValue)/\(workspaceId)/workstreams/\(workstreamId)"
        if substreamId != SubstreamAddress.main {
            path += "/substreams/\(substreamId)"
        }
        return URL(string: path, relativeTo: webBase)?.absoluteURL
    }
}
