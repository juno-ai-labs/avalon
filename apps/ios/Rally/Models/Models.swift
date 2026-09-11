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
    var workspaceId: String?
    var title: String
    var titleStatus: String?
    var objective: String?
    var hasUnread: Bool?
    var youAreMentioned: Bool?
    var unseen: Bool?
    var lastActivityAt: String?
    var createdAt: String?
    var updatedAt: String?
    var archivedAt: String?
    var scope: String?
    var harnessStatus: String?
    var pinned: Bool?
    var systemKind: String?
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
    enum Role: String, Sendable { case user, assistant, system }
    var id: String
    var role: Role
    var text: String
    var createdAt: Date
    var isStreaming: Bool
    var clientMessageId: String?
    var sequence: Int?
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
