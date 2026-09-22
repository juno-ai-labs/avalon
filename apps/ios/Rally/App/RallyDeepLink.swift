import Foundation

/// Parses auth returns and canonical Space/Channel/Breakout universal links.
enum RallyDeepLink {
    struct WorkstreamTarget: Equatable {
        var region: RallyRegion? = nil
        var workspaceId: String? = nil
        var spaceId: String? = nil
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
        let parts = url.path.split(separator: "/").map(String.init)
        if (url.scheme == "https" || url.scheme == "http"), parts.count >= 6,
           parts[0] == "app", let region = RallyRegion(rawValue: parts[1]),
           parts[3] == "s", parts[5] == "c",
           let workspaceId = uuidFromBase58(parts[2]),
           let spaceId = uuidFromBase58(parts[4]),
           parts.count == 7 || parts.count == 9,
           let workstreamId = uuidFromBase58(parts[6]) {
            var substreamId = SubstreamAddress.main
            if parts.count == 9 {
                guard parts[7] == "b", let decoded = uuidFromBase58(parts[8]) else { return nil }
                substreamId = decoded
            }
            return WorkstreamTarget(region: region, workspaceId: workspaceId, spaceId: spaceId,
                                    workstreamId: workstreamId, substreamId: substreamId)
        }
        if url.scheme == "rallywithai", url.host == "workstreams" {
            guard let workstreamId = parts.first, !workstreamId.isEmpty, workstreamId != "new" else {
                return nil
            }
            var substreamId = SubstreamAddress.main
            if let index = parts.firstIndex(of: "substreams"), index + 1 < parts.count {
                substreamId = parts[index + 1]
            }
            return WorkstreamTarget(workstreamId: workstreamId, substreamId: normalized(substreamId, query: url))
        }
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
        spaceId: String,
        workstreamId: String,
        substreamId: String = SubstreamAddress.main
    ) -> URL? {
        guard let organization = uuidToBase58(workspaceId),
              let space = uuidToBase58(spaceId),
              let channel = uuidToBase58(workstreamId) else { return nil }
        var path = "/app/\(region.rawValue)/\(organization)/s/\(space)/c/\(channel)"
        if substreamId != SubstreamAddress.main {
            guard let breakout = uuidToBase58(substreamId) else { return nil }
            path += "/b/\(breakout)"
        }
        return URL(string: path, relativeTo: webBase)?.absoluteURL
    }

    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

    private static func uuidToBase58(_ uuid: String) -> String? {
        let hex = uuid.replacingOccurrences(of: "-", with: "")
        guard UUID(uuidString: uuid) != nil, hex.count == 32 else { return nil }
        var bytes = stride(from: 0, to: 32, by: 2).compactMap { offset -> UInt8? in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            let end = hex.index(start, offsetBy: 2)
            return UInt8(hex[start..<end], radix: 16)
        }
        guard bytes.count == 16 else { return nil }
        let leading = bytes.prefix(while: { $0 == 0 }).count
        var digits: [Character] = []
        while bytes.contains(where: { $0 != 0 }) {
            var carry = 0
            for index in bytes.indices {
                let value = carry * 256 + Int(bytes[index])
                bytes[index] = UInt8(value / 58)
                carry = value % 58
            }
            digits.append(alphabet[carry])
        }
        return String(repeating: "1", count: leading) + String(digits.reversed())
    }

    private static func uuidFromBase58(_ encoded: String) -> String? {
        guard !encoded.isEmpty else { return nil }
        var bytes = Array(repeating: UInt8(0), count: 16)
        for character in encoded {
            guard let digit = alphabet.firstIndex(of: character) else { return nil }
            var carry = digit
            for index in bytes.indices.reversed() {
                let value = Int(bytes[index]) * 58 + carry
                bytes[index] = UInt8(value & 255)
                carry = value >> 8
            }
            guard carry == 0 else { return nil }
        }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let groups = [8, 4, 4, 4, 12]
        var offset = hex.startIndex
        let uuid = groups.map { count -> String in
            let end = hex.index(offset, offsetBy: count)
            defer { offset = end }
            return String(hex[offset..<end])
        }.joined(separator: "-")
        guard uuidToBase58(uuid) == encoded else { return nil }
        return uuid
    }
}
