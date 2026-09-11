import Foundation

actor RallyClient {
    private var baseURL: URL
    private var accessToken: String?
    private let session: URLSession
    private let decoder = JSONCoding.decoder
    private let encoder = JSONCoding.encoder

    init(baseURL: URL = APIConfiguration.globalURL(), accessToken: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.accessToken = accessToken
        self.session = session
    }

    func update(baseURL: URL, accessToken: String?) {
        self.baseURL = baseURL
        self.accessToken = accessToken
    }

    func setAccessToken(_ token: String?) {
        accessToken = token
    }

    // MARK: Auth

    func beginGoogleLogin(challenge: PKCEChallenge, returnURI: URL = APIConfiguration.returnURI) async throws -> URL {
        struct Body: Encodable {
            var returnUri: String
            var desktopAttemptId: String
            var desktopCodeChallenge: String
        }
        struct Response: Decodable { var url: String }
        let payload = try await post(
            path: "/auth/google/start",
            body: Body(
                returnUri: returnURI.absoluteString,
                desktopAttemptId: challenge.attemptId,
                desktopCodeChallenge: challenge.challenge
            ),
            as: Response.self,
            authorized: false
        )
        guard let url = URL(string: payload.url) else {
            throw RallyAPIError(status: 502, code: "invalid_start_url", message: "Google sign-in did not return a valid URL.")
        }
        return url
    }

    func exchangeDesktopTicket(ticket: String, attemptId: String, verifier: String, timezone: String) async throws -> RallySession {
        struct Body: Encodable {
            var ticket: String
            var region: String
            var attemptId: String
            var codeVerifier: String
            var timezone: String
        }
        return try await post(
            path: "/auth/desktop/exchange",
            body: Body(
                ticket: ticket,
                region: "global",
                attemptId: attemptId,
                codeVerifier: verifier,
                timezone: timezone
            ),
            as: RallySession.self,
            authorized: false
        )
    }

    func refresh(refreshToken: String) async throws -> RallySession {
        struct Body: Encodable { var refreshToken: String }
        return try await post(path: "/auth/refresh", body: Body(refreshToken: refreshToken), as: RallySession.self, authorized: false)
    }

    func logout(refreshToken: String?) async {
        struct Body: Encodable { var refreshToken: String? }
        do {
            try await postVoid(path: "/auth/logout", body: Body(refreshToken: refreshToken), authorized: true)
        } catch {
            // Logout is idempotent.
        }
    }

    // MARK: Onboarding / workspaces

    func onboardingState() async throws -> RallyOnboardingState {
        try await get(path: "/onboarding", as: RallyOnboardingState.self)
    }

    func createWorkspace(name: String, region: RallyRegion) async throws -> RallySession {
        struct Body: Encodable { var name: String; var region: String }
        return try await post(
            path: "/onboarding/workspace",
            body: Body(name: name, region: region.rawValue),
            as: RallySession.self
        )
    }

    func activateWorkspace(region: RallyRegion, workspaceId: String) async throws -> RallySession {
        struct Body: Encodable { var region: String; var workspaceId: String }
        return try await post(
            path: "/onboarding/workspace/activate",
            body: Body(region: region.rawValue, workspaceId: workspaceId),
            as: RallySession.self
        )
    }

    func acceptInvitation(id: String, region: RallyRegion) async throws -> RallySession {
        struct Body: Encodable { var region: String }
        return try await post(
            path: "/onboarding/invitations/\(id)/accept",
            body: Body(region: region.rawValue),
            as: RallySession.self
        )
    }

    func getWorkspace() async throws -> RallyWorkspace {
        try await get(path: "/workspace", as: RallyWorkspace.self)
    }

    func leaveWorkspace(workspaceId: String, expectedOutcome: String) async throws {
        try await requestVoid(
            method: "DELETE",
            path: "/workspaces/\(workspaceId)/membership?expectedOutcome=\(expectedOutcome)",
            body: Optional<Empty>.none
        )
    }

    // MARK: Work streams

    func listWorkstreams(limit: Int = 50) async throws -> RallyWorkstreamPage {
        try await get(path: "/workstreams?limit=\(limit)", as: RallyWorkstreamPage.self)
    }

    func createWorkstream(
        openingMessage: String,
        clientMessageId: String,
        operationId: String,
        attachmentIds: [String] = [],
        projectId: String? = nil
    ) async throws -> RallyCreatedWorkstream {
        struct Body: Encodable {
            var openingMessage: String
            var participantUserIds: [String]
            var clientMessageId: String
            var attachmentIds: [String]
            var projectId: String?

            enum CodingKeys: String, CodingKey {
                case openingMessage, participantUserIds, clientMessageId, attachmentIds, projectId
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(openingMessage, forKey: .openingMessage)
                try container.encode(participantUserIds, forKey: .participantUserIds)
                try container.encode(clientMessageId, forKey: .clientMessageId)
                try container.encode(attachmentIds, forKey: .attachmentIds)
                try container.encodeIfPresent(projectId, forKey: .projectId)
            }
        }
        return try await post(
            path: "/workstreams",
            body: Body(
                openingMessage: openingMessage,
                participantUserIds: [],
                clientMessageId: clientMessageId,
                attachmentIds: attachmentIds,
                projectId: projectId
            ),
            as: RallyCreatedWorkstream.self,
            headers: [APIConfiguration.operationHeader: operationId]
        )
    }

    func getConversation(id: String) async throws -> ConversationBoot {
        try await get(path: "/conversations/\(id)", as: ConversationBoot.self)
    }

    func conversationSocketTicket(parentId: String, substreamId: String = "0") async throws -> RallySocketTicket {
        try await get(path: "/conversations/\(parentId)/substreams/\(substreamId)/socket", as: RallySocketTicket.self)
    }

    func workspaceSocketTicket() async throws -> RallySocketTicket {
        try await get(path: "/workspace/socket", as: RallySocketTicket.self)
    }

    func workOpportunities() async throws -> [RallyOpportunity] {
        struct Page: Decodable { var items: [RallyOpportunity] }
        let page: Page = try await get(path: "/work-opportunities", as: Page.self)
        return page.items
    }

    func pinWorkstream(id: String) async throws {
        struct Page: Decodable { var items: [RallyWorkstream]? }
        _ = try await request(method: "PUT", path: "/workstreams/\(id)/pin", body: Optional<Empty>.none, as: Page.self)
    }

    func unpinWorkstream(id: String) async throws {
        struct Page: Decodable { var items: [RallyWorkstream]? }
        _ = try await request(method: "DELETE", path: "/workstreams/\(id)/pin", body: Optional<Empty>.none, as: Page.self)
    }

    func patchWorkstream(id: String, title: String? = nil, archived: Bool? = nil, scope: String? = nil) async throws -> RallyWorkstream {
        struct Body: Encodable {
            var title: String?
            var archived: Bool?
            var scope: String?
        }
        return try await request(method: "PATCH", path: "/workstreams/\(id)", body: Body(title: title, archived: archived, scope: scope), as: RallyWorkstream.self)
    }

    func markWorkstreamUnread(id: String) async throws {
        _ = try await request(method: "POST", path: "/workstreams/\(id)/read-state/mark-unread", body: Optional<Empty>.none, as: RallyWorkstream.self)
    }

    func listNotes() async throws -> [RallyNote] {
        let page: RallyNotePage = try await get(path: "/notes?limit=100", as: RallyNotePage.self)
        return page.items.filter { $0.archivedAt == nil }
    }

    func getNote(id: String) async throws -> RallyNote {
        try await get(path: "/notes/\(id)", as: RallyNote.self)
    }

    func createNote(id: String, title: String) async throws -> RallyNote {
        struct Body: Encodable { var id: String; var title: String; var scope: String }
        return try await post(path: "/notes", body: Body(id: id, title: title, scope: "personal"), as: RallyNote.self)
    }

    func listSidekicks() async throws -> [RallySidekick] {
        let page: RallySidekickPage = try await get(path: "/sidekicks", as: RallySidekickPage.self)
        return page.items
    }

    func createSidekick() async throws -> String {
        struct Created: Decodable { var automationId: String }
        struct Body: Encodable {}
        let created: Created = try await post(path: "/sidekicks", body: Body(), as: Created.self)
        return created.automationId
    }

    func createProject(name: String) async throws -> RallyProject {
        struct Body: Encodable {
            var name: String
            var iconKey: String
            var colorKey: String
            var scope: String
        }
        return try await post(
            path: "/projects",
            body: Body(name: name, iconKey: "briefcase", colorKey: "lime", scope: "personal"),
            as: RallyProject.self
        )
    }

    func listMembers() async throws -> [RallyMember] {
        struct Page: Decodable { var items: [RallyMember] }
        let page: Page = try await get(path: "/workspace/members", as: Page.self)
        return page.items
    }

    func searchWorkspace(query: String) async throws -> [RallySearchHit] {
        struct Body: Encodable {
            var query: String
            var category: String
        }
        struct Response: Decodable { var results: [RallySearchHit]? }
        let response: Response = try await post(
            path: "/search",
            body: Body(query: query, category: "all"),
            as: Response.self
        )
        return response.results ?? []
    }

    func getDigest() async throws -> RallyDigest {
        try await get(path: "/digest", as: RallyDigest.self)
    }

    func updateDigest(_ digest: RallyDigest) async throws -> RallyDigest {
        struct Target: Encodable {
            var type: String
            var connectionId: String?
        }
        struct Body: Encodable {
            var enabled: Bool
            var days: [Int]
            var times: [Int]
            var deliveryTargets: [Target]
        }
        return try await request(
            method: "PUT",
            path: "/digest",
            body: Body(
                enabled: digest.enabled,
                days: digest.days,
                times: digest.times,
                deliveryTargets: [Target(type: "email", connectionId: nil)]
            ),
            as: RallyDigest.self
        )
    }

    func addParticipant(workstreamId: String, userId: String) async throws {
        struct Body: Encodable { var userId: String }
        struct Participant: Decodable { var id: String? }
        _ = try await post(path: "/workstreams/\(workstreamId)/participants", body: Body(userId: userId), as: Participant.self)
    }

    func uploadResource(data: Data, fileName: String, mimeType: String, draftId: String) async throws -> UploadedResource {
        let boundary = "rally-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        return try await request(
            method: "POST",
            path: "/resources/upload",
            bodyData: body,
            contentType: "multipart/form-data; boundary=\(boundary)",
            as: UploadedResource.self,
            extraHeaders: [APIConfiguration.draftHeader: draftId]
        )
    }

    // MARK: HTTP

    private struct Empty: Encodable {}

    private func get<T: Decodable>(path: String, as type: T.Type) async throws -> T {
        try await request(method: "GET", path: path, body: Optional<Empty>.none, as: type)
    }

    private func post<Body: Encodable, T: Decodable>(
        path: String,
        body: Body,
        as type: T.Type,
        authorized: Bool = true,
        headers: [String: String] = [:]
    ) async throws -> T {
        try await request(method: "POST", path: path, body: body, as: type, authorized: authorized, extraHeaders: headers)
    }

    private func postVoid<Body: Encodable>(path: String, body: Body, authorized: Bool) async throws {
        try await requestVoid(method: "POST", path: path, body: body, authorized: authorized)
    }

    private func request<Body: Encodable, T: Decodable>(
        method: String,
        path: String,
        body: Body?,
        as type: T.Type,
        authorized: Bool = true,
        extraHeaders: [String: String] = [:]
    ) async throws -> T {
        let data: Data?
        if let body {
            data = try encoder.encode(body)
        } else {
            data = nil
        }
        return try await request(
            method: method,
            path: path,
            bodyData: data,
            contentType: data == nil ? nil : "application/json",
            as: type,
            authorized: authorized,
            extraHeaders: extraHeaders
        )
    }

    private func request<T: Decodable>(
        method: String,
        path: String,
        bodyData: Data?,
        contentType: String?,
        as type: T.Type,
        authorized: Bool = true,
        extraHeaders: [String: String] = [:]
    ) async throws -> T {
        let (data, response) = try await send(method: method, path: path, bodyData: bodyData, contentType: contentType, authorized: authorized, extraHeaders: extraHeaders)
        if (200..<300).contains(response.statusCode) {
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw RallyAPIError(
                    status: response.statusCode,
                    code: "unrecognized_response",
                    message: "Rally received a response it doesn’t recognize. Restarting usually fixes this."
                )
            }
        }
        throw decodeError(data: data, status: response.statusCode)
    }

    private func requestVoid<Body: Encodable>(
        method: String,
        path: String,
        body: Body?,
        authorized: Bool = true
    ) async throws {
        let data = try body.map { try encoder.encode($0) }
        let (responseData, response) = try await send(
            method: method,
            path: path,
            bodyData: data,
            contentType: data == nil ? nil : "application/json",
            authorized: authorized,
            extraHeaders: [:]
        )
        if (200..<300).contains(response.statusCode) { return }
        throw decodeError(data: responseData, status: response.statusCode)
    }

    private func send(
        method: String,
        path: String,
        bodyData: Data?,
        contentType: String?,
        authorized: Bool,
        extraHeaders: [String: String]
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw RallyAPIError(status: 0, code: "invalid_url", message: "The request URL was invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        if authorized, let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        for (key, value) in extraHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.httpBody = bodyData
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw RallyAPIError.offline
            }
            return (data, http)
        } catch let error as RallyAPIError {
            throw error
        } catch {
            throw RallyAPIError.offline
        }
    }

    private func decodeError(data: Data, status: Int) -> RallyAPIError {
        struct Wire: Decodable {
            struct Nested: Decodable { var code: String?; var message: String? }
            var error: Nested?
            var code: String?
            var message: String?
        }
        if let wire = try? decoder.decode(Wire.self, from: data) {
            return RallyAPIError(
                status: status,
                code: wire.error?.code ?? wire.code ?? "http_\(status)",
                message: wire.error?.message ?? wire.message ?? "Request failed (\(status))."
            )
        }
        return RallyAPIError(status: status, code: "http_\(status)", message: "Request failed (\(status)).")
    }
}

struct ConversationBoot: Decodable, Sendable {
    var id: String?
    var title: String?
    var transcript: TranscriptSnapshot?

    init(id: String? = nil, title: String? = nil, transcript: TranscriptSnapshot? = nil) {
        self.id = id
        self.title = title
        self.transcript = transcript
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let nested = try container.decodeIfPresent(NestedWorkstream.self, forKey: .workstream) {
            id = nested.id
            title = nested.title
        } else {
            id = try container.decodeIfPresent(String.self, forKey: .id)
            title = try container.decodeIfPresent(String.self, forKey: .title)
        }
        transcript = try container.decodeIfPresent(TranscriptSnapshot.self, forKey: .transcript)
    }

    private struct NestedWorkstream: Decodable {
        var id: String?
        var title: String?
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case transcript
        case workstream
    }
}

struct TranscriptSnapshot: Decodable, Sendable {
    var ranges: [TranscriptRange]?
    var activeTurns: [TranscriptTurn]?
}

struct TranscriptRange: Decodable, Sendable {
    var turns: [TranscriptTurn]?
}

struct TranscriptTurn: Decodable, Sendable {
    var turnId: String?
    var transcriptSequence: Int?
    var actor: String?
    var entryKind: String?
    var createdAtUtc: String?
    var clientMessageId: String?
    var blocks: [TranscriptBlock]?
    var blocksOmitted: Bool?
    var authorSnapshot: AuthorSnapshot?
    var statusKind: String?

    struct AuthorSnapshot: Decodable, Sendable {
        var displayName: String?
    }
}

struct TranscriptBlock: Decodable, Sendable {
    var type: String?
    var text: String?
    var streaming: Bool?
    var messageType: String?
    var structuredContent: [String: JSONValue]?
    var toolName: String?
    var pluginId: String?
    var status: String?
    var error: String?
    var attachments: [RallyAttachment]?
    var mentions: [RallyMention]?
}

enum JSONValue: Decodable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([String: JSONValue].self) { self = .object(value); return }
        if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
        self = .null
    }

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}

struct UploadedResource: Decodable, Sendable {
    var id: String
    var fileName: String?
}
