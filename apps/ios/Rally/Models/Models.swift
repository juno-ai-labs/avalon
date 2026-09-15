import Foundation

enum RallyRegion: String, Codable, Sendable, CaseIterable, Identifiable {
    case global
    case eu
    var id: String { rawValue }
    var displayName: String { self == .global ? "United States" : "European Union" }
}

struct RallyUser: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var email: String
    var name: String
    var avatarUrl: String?
    var timezone: String
    var presentation: RallyPersonalPresentation? = nil
}

/// Account appearance owned by Global identity (`GET /onboarding/account`).
struct RallyPersonalPresentation: Codable, Sendable, Equatable {
    var displayName: String?
    var initials: String?
    var color: String
    var avatar: String?
    var revision: Int?

    init(displayName: String? = nil, initials: String? = nil, color: String, avatar: String? = nil, revision: Int? = nil) {
        self.displayName = displayName
        self.initials = initials
        self.color = color
        self.avatar = avatar
        self.revision = revision
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        displayName = try container.decodeIfPresent(String.self, forKey: .displayName)
        initials = try container.decodeIfPresent(String.self, forKey: .initials)
        color = try container.decodeIfPresent(String.self, forKey: .color) ?? "blue"
        avatar = try container.decodeIfPresent(String.self, forKey: .avatar)
        revision = try container.decodeIfPresent(Int.self, forKey: .revision)
    }

    /// Server initials when set; otherwise the same two-letter name fallback desktop uses.
    static func initials(stored: String?, fallbackName: String) -> String {
        let trimmed = stored?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        let letters = fallbackName.split { $0.isWhitespace || $0.isNewline }
            .compactMap(\.first)
            .prefix(2)
        let derived = String(letters).uppercased()
        return derived.isEmpty ? "?" : derived
    }
}

struct RallyAccountOnboarding: Codable, Sendable, Equatable {
    var eligible: Bool?
    var introduced: Bool?
    var presentation: RallyPersonalPresentation?
    var revision: Int?
}

struct RallyWorkspace: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var slug: String?
    var region: RallyRegion
    var role: String
    var timezone: String
}

struct RallySession: Codable, Sendable, Equatable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: String
    var user: RallyUser
    var workspace: RallyWorkspace?
    var apiBaseUrl: String

    var isIdentityOnly: Bool { workspace == nil }
}

struct RallyInvitation: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var workspaceName: String?
    var invitedByName: String?
    var region: RallyRegion?
}

struct RallyOnboardingState: Codable, Sendable, Equatable {
    var workspace: RallyWorkspace?
    var workspaces: [RallyWorkspace]
    var invitations: [RallyInvitation]

    init(workspace: RallyWorkspace?, workspaces: [RallyWorkspace], invitations: [RallyInvitation]) {
        self.workspace = workspace
        self.workspaces = workspaces
        self.invitations = invitations
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspace = try container.decodeIfPresent(RallyWorkspace.self, forKey: .workspace)
        invitations = try container.decodeIfPresent([RallyInvitation].self, forKey: .invitations) ?? []
        if let listed = try container.decodeIfPresent([RallyWorkspace].self, forKey: .workspaces) {
            workspaces = listed
        } else if let workspace {
            workspaces = [workspace]
        } else {
            workspaces = []
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(workspace, forKey: .workspace)
        try container.encode(workspaces, forKey: .workspaces)
        try container.encode(invitations, forKey: .invitations)
    }

    private enum CodingKeys: String, CodingKey {
        case workspace
        case workspaces
        case invitations
    }
}

struct RallyWorkstream: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var workspaceId: String? = nil
    var title: String
    var titleStatus: String? = nil
    var objective: String? = nil
    var hasUnread: Bool? = nil
    var youAreMentioned: Bool? = nil
    var unseen: Bool? = nil
    var lastActivityAt: String? = nil
    var lastAccessedAt: String? = nil
    /// `true` when the wire omitted `lastAccessedAt` (older server). Explicit
    /// `null` is a supporting server that nobody has visited.
    var lastAccessedAtOmitted: Bool = true
    var createdAt: String? = nil
    var updatedAt: String? = nil
    var archivedAt: String? = nil
    var scope: String? = nil
    var harnessStatus: String? = nil
    var pinned: Bool? = nil
    var pinPosition: Int? = nil
    var systemKind: String? = nil
    var emailAddress: String? = nil
    var projectId: String? = nil
    var preview: String? = nil
    var appearance: RallySavedAppearance? = nil

    var isPinned: Bool { pinned == true || pinPosition != nil }

    init(id: String, title: String) {
        self.id = id
        self.title = title
    }

    /// Same instant Electron's `workstreamRecencyAt` uses.
    var recencyRaw: String? {
        if lastAccessedAtOmitted {
            return lastActivityAt
        }
        return lastAccessedAt ?? createdAt ?? lastActivityAt
    }

    enum CodingKeys: String, CodingKey {
        case id, workspaceId, title, titleStatus, objective
        case hasUnread, youAreMentioned, unseen
        case lastActivityAt, lastAccessedAt, createdAt, updatedAt, archivedAt
        case scope, harnessStatus, pinned, pinPosition, systemKind
        case emailAddress, projectId, preview, appearance
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        workspaceId = try container.decodeIfPresent(String.self, forKey: .workspaceId)
        titleStatus = try container.decodeIfPresent(String.self, forKey: .titleStatus)
        objective = try container.decodeIfPresent(String.self, forKey: .objective)
        hasUnread = try container.decodeIfPresent(Bool.self, forKey: .hasUnread)
        youAreMentioned = try container.decodeIfPresent(Bool.self, forKey: .youAreMentioned)
        unseen = try container.decodeIfPresent(Bool.self, forKey: .unseen)
        lastActivityAt = try container.decodeIfPresent(String.self, forKey: .lastActivityAt)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        archivedAt = try container.decodeIfPresent(String.self, forKey: .archivedAt)
        scope = try container.decodeIfPresent(String.self, forKey: .scope)
        harnessStatus = try container.decodeIfPresent(String.self, forKey: .harnessStatus)
        pinned = try container.decodeIfPresent(Bool.self, forKey: .pinned)
        pinPosition = try container.decodeIfPresent(Int.self, forKey: .pinPosition)
        systemKind = try container.decodeIfPresent(String.self, forKey: .systemKind)
        emailAddress = try container.decodeIfPresent(String.self, forKey: .emailAddress)
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
        preview = try container.decodeIfPresent(String.self, forKey: .preview)
        appearance = try container.decodeIfPresent(RallySavedAppearance.self, forKey: .appearance)
        if container.contains(.lastAccessedAt) {
            lastAccessedAtOmitted = false
            lastAccessedAt = try container.decodeIfPresent(String.self, forKey: .lastAccessedAt)
        } else {
            lastAccessedAtOmitted = true
            lastAccessedAt = nil
        }
    }
}

struct RallyWorkstreamPage: Codable, Sendable {
    var items: [RallyWorkstream]
    var nextCursor: String?
}

struct RallyCreatedWorkstream: Codable, Sendable {
    var workstream: RallyWorkstream
    var turnId: String?
    var harnessRunId: String?
}

struct RallySocketTicket: Codable, Sendable {
    var url: String
    var ticket: String
    var ticketId: String?
}

struct RallyChatMessage: Identifiable, Equatable, Sendable {
    enum Role: String, Sendable { case user, assistant, system, external }
    enum Kind: String, Sendable {
        case text
        case thought
        case toolEvent
        case pluginActivity
        case workAccordion
        case elicitation
        case system
        case automationActivation
        case omitted
    }

    var id: String
    var kind: Kind = .text
    var role: Role
    var text: String
    var createdAt: Date
    var isStreaming: Bool
    var clientMessageId: String? = nil
    var sequence: Int? = nil
    var authorName: String? = nil
    var toolName: String? = nil
    var pluginName: String? = nil
    var toolStatus: String? = nil
    var statusKind: String? = nil
    var elicitation: RallyElicitation? = nil
    var attachments: [RallyAttachment] = []
    var mentions: [RallyMention] = []
    var nested: [RallyChatMessage] = []
    var deliveryState: String? = nil
    /// The transcript turn this row was projected from. Message actions that
    /// branch a substream address this id, not the per-block row id.
    var turnId: String? = nil
}

enum SubstreamAddress {
    static let main = "0"
}

struct RallyPrivateChild: Codable, Sendable, Equatable, Identifiable {
    var substreamId: String
    var title: String
    var createdByUserId: String?
    var createdAt: String?
    var updatedAt: String?
    var id: String { substreamId }
}

struct SubstreamPreparationPreview: Decodable, Sendable {
    var operationId: String
    var substreamId: String
    var title: String
}

struct SubstreamCreationResult: Decodable, Sendable {
    var substreamId: String
    var title: String
    var opening: Opening?

    struct Opening: Decodable, Sendable {
        var turnId: String
        var clientMessageId: String
        var createdAt: String
    }
}

struct SubstreamCreationAttempt: Equatable, Sendable {
    var parentId: String
    var throughTurnId: String?
    var operationId: String
    var clientMessageId: String
}

struct RallyWorkstreamControlMetadata: Decodable, Sendable {
    var title: String?
    var scope: String?
    var systemKind: String?
    var appearance: RallySavedAppearance?
    var privateChildren: [RallyPrivateChild]?

    init(
        title: String? = nil,
        scope: String? = nil,
        systemKind: String? = nil,
        appearance: RallySavedAppearance? = nil,
        privateChildren: [RallyPrivateChild]? = nil
    ) {
        self.title = title
        self.scope = scope
        self.systemKind = systemKind
        self.appearance = appearance
        self.privateChildren = privateChildren
    }

    /// Control frames carry many fields iOS does not model. A full decode is
    /// preferred; if `appearance` or another nested value is the wrong shape,
    /// children are still taken from JSON so the list can leave its wait.
    static func parseSocketFrame(_ data: Data) -> RallyWorkstreamControlMetadata? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String,
              type == "workstream_metadata" else { return nil }
        let metadataObject = object["metadata"]
        if let metadataObject,
           let metadataData = try? JSONSerialization.data(withJSONObject: metadataObject),
           let decoded = try? JSONCoding.decoder.decode(RallyWorkstreamControlMetadata.self, from: metadataData) {
            return decoded
        }
        return RallyWorkstreamControlMetadata(privateChildren: children(from: metadataObject))
    }

    private static func children(from metadataObject: Any?) -> [RallyPrivateChild] {
        guard let object = metadataObject as? [String: Any],
              let rows = object["privateChildren"] as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let substreamId = row["substreamId"] as? String,
                  let title = row["title"] as? String else { return nil }
            return RallyPrivateChild(
                substreamId: substreamId,
                title: title,
                createdByUserId: row["createdByUserId"] as? String,
                createdAt: row["createdAt"] as? String,
                updatedAt: row["updatedAt"] as? String
            )
        }
    }
}

struct RallyAttachment: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var fileName: String
    var mimeType: String
    var sizeBytes: Int?
}

struct RallyMention: Codable, Sendable, Equatable {
    var type: String?
    var userId: String?
    var connectorType: String?
}

struct RallyElicitation: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var prompt: String
    var responseType: String
    var options: [RallyElicitationOption]
    var status: String
    var answer: RallyElicitationAnswer?

    enum RallyElicitationAnswer: Codable, Sendable, Equatable {
        case text(String)
        case list([String])

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(String.self) {
                self = .text(value)
            } else if let value = try? container.decode([String].self) {
                self = .list(value)
            } else {
                self = .text("")
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .text(let value): try container.encode(value)
            case .list(let value): try container.encode(value)
            }
        }
    }
}

struct RallyElicitationOption: Codable, Sendable, Equatable, Identifiable {
    var optionId: String?
    var label: String?
    var value: String?
    var id: String { optionId ?? value ?? label ?? "option" }

    enum CodingKeys: String, CodingKey {
        case optionId = "id"
        case label
        case value
    }
}

struct RallySidekick: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var description: String? = nil
    var status: String? = nil
    var lastRunAt: String? = nil
    var appearance: RallySavedAppearance? = nil
}

struct RallySidekickPage: Codable, Sendable {
    var items: [RallySidekick]
}

struct RallySearchPage: Decodable, Sendable {
    var results: [RallySearchHit]
    var nextCursor: String?

    init(results: [RallySearchHit] = [], nextCursor: String? = nil) {
        self.results = results
        self.nextCursor = nextCursor
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        results = try container.decodeIfPresent([RallySearchHit].self, forKey: .results) ?? []
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
    }

    private enum CodingKeys: String, CodingKey { case results, nextCursor }
}

struct RallySearchHit: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String?
    var snippet: String?
    var kind: String?
    var workstreamId: String?
    var substreamId: String?

    enum CodingKeys: String, CodingKey {
        case id, title, snippet, kind, excerpt, category, location
    }

    init(id: String, title: String? = nil, snippet: String? = nil, kind: String? = nil, workstreamId: String? = nil, substreamId: String? = nil) {
        self.id = id
        self.title = title
        self.snippet = snippet
        self.kind = kind
        self.workstreamId = workstreamId
        self.substreamId = substreamId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        snippet = try container.decodeIfPresent(String.self, forKey: .excerpt)
            ?? container.decodeIfPresent(String.self, forKey: .snippet)
        kind = try container.decodeIfPresent(String.self, forKey: .category)
            ?? container.decodeIfPresent(String.self, forKey: .kind)
        if let location = try container.decodeIfPresent(Location.self, forKey: .location) {
            workstreamId = location.workstreamId
            substreamId = location.substreamId
        } else {
            workstreamId = nil
            substreamId = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(snippet, forKey: .snippet)
        try container.encodeIfPresent(kind, forKey: .kind)
    }

    private struct Location: Decodable {
        var kind: String?
        var workstreamId: String?
        var substreamId: String?
    }
}

struct RallyMember: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var email: String?
    var role: String?
    var presentation: RallyPersonalPresentation?

    enum CodingKeys: String, CodingKey {
        case id, name, email, role, user, presentation
    }

    init(id: String, name: String, email: String? = nil, role: String? = nil, presentation: RallyPersonalPresentation? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.role = role
        self.presentation = presentation
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let user = try container.decodeIfPresent(NestedUser.self, forKey: .user) {
            id = user.id
            name = user.name
            email = user.email
            presentation = user.presentation
        } else {
            id = try container.decode(String.self, forKey: .id)
            name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
            email = try container.decodeIfPresent(String.self, forKey: .email)
            presentation = try container.decodeIfPresent(RallyPersonalPresentation.self, forKey: .presentation)
        }
        role = try container.decodeIfPresent(String.self, forKey: .role)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encodeIfPresent(email, forKey: .email)
        try container.encodeIfPresent(role, forKey: .role)
        try container.encodeIfPresent(presentation, forKey: .presentation)
    }

    private struct NestedUser: Decodable {
        var id: String
        var name: String
        var email: String?
        var presentation: RallyPersonalPresentation?
    }
}

struct RallyDigest: Codable, Sendable, Equatable {
    var enabled: Bool
    var days: [Int]
    var times: [Int]
    var timezone: String?
}

struct RallyOpportunity: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var version: Int?
    var displayPrompt: String
    var sourceLabel: String?
}

struct RallyAPIError: Error, Equatable, LocalizedError, Sendable {
    var status: Int
    var code: String
    var message: String

    var errorDescription: String? { message }

    static let offline = RallyAPIError(status: 0, code: "offline", message: "Rally can’t reach the server. Check your connection and try again.")
}

struct Envelope<T: Decodable>: Decodable {
    var error: ErrorBody?
    var wrapped: T?

    struct ErrorBody: Decodable {
        var code: String
        var message: String
        var requestId: String?
    }
}

enum AppearancePreference: String, Codable, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}
