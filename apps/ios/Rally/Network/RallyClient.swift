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

#if RALLY_DEBUG
    func createDevelopmentWorkspaceSession(workspaceName: String) async throws -> RallySession {
        struct Body: Encodable { var workspaceName: String }
        return try await post(
            path: "/auth/dev/session",
            body: Body(workspaceName: workspaceName),
            as: RallySession.self,
            authorized: false
        )
    }

    func createDevelopmentIdentitySession() async throws -> RallySession {
        struct Body: Encodable {}
        return try await post(
            path: "/auth/dev/identity",
            body: Body(),
            as: RallySession.self,
            authorized: false
        )
    }
#endif

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

    /// Account appearance lives on Global identity, not the regional workspace.
    func getAccountOnboarding(accessToken: String) async throws -> RallyAccountOnboarding {
        try await request(
            method: "GET",
            path: "/onboarding/account",
            bodyData: nil,
            contentType: nil,
            as: RallyAccountOnboarding.self,
            authorized: true,
            extraHeaders: [:],
            baseURL: APIConfiguration.globalURL(),
            bearerToken: accessToken
        )
    }

    func leaveWorkspace(workspaceId: String, expectedOutcome: String) async throws {
        try await requestVoid(
            method: "DELETE",
            path: "/workspaces/\(workspaceId)/membership?expectedOutcome=\(expectedOutcome)",
            body: Optional<Empty>.none
        )
    }

    // MARK: Work streams

    func createWorkstream(
        openingMessage: String,
        clientMessageId: String,
        operationId: String,
        attachmentIds: [String] = []
    ) async throws -> RallyCreatedWorkstream {
        struct Body: Encodable {
            var openingMessage: String
            var participantUserIds: [String]
            var clientMessageId: String
            var attachmentIds: [String]
        }
        return try await post(
            path: "/workstreams",
            body: Body(
                openingMessage: openingMessage,
                participantUserIds: [],
                clientMessageId: clientMessageId,
                attachmentIds: attachmentIds
            ),
            as: RallyCreatedWorkstream.self,
            headers: [APIConfiguration.operationHeader: operationId]
        )
    }

    func conversationSocketTicket(parentId: String, substreamId: String = SubstreamAddress.main) async throws -> RallySocketTicket {
        try await get(path: "/conversations/\(parentId)/substreams/\(substreamId)/socket", as: RallySocketTicket.self)
    }

    func workstreamControlSocketTicket(id: String) async throws -> RallySocketTicket {
        try await get(path: "/workstreams/\(id)/control-socket", as: RallySocketTicket.self)
    }

    func prepareSubstream(parentId: String, operationId: String, throughTurnId: String?) async throws -> SubstreamPreparationPreview {
        struct Body: Encodable {
            var operationId: String
            var throughTurnId: String?

            enum CodingKeys: String, CodingKey { case operationId, throughTurnId }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(operationId, forKey: .operationId)
                try container.encode(throughTurnId, forKey: .throughTurnId)
            }
        }
        return try await post(
            path: "/conversations/\(parentId)/substreams/prepare",
            body: Body(operationId: operationId, throughTurnId: throughTurnId),
            as: SubstreamPreparationPreview.self,
            headers: [APIConfiguration.operationHeader: operationId]
        )
    }

    func confirmSubstream(
        parentId: String,
        operationId: String,
        clientMessageId: String,
        text: String,
        attachmentIds: [String]
    ) async throws -> SubstreamCreationResult {
        struct Opening: Encodable {
            var clientMessageId: String
            var text: String
            var mentions: [RallyMention]
            var attachmentIds: [String]
            var confirmedParticipantUserIds: [String]
        }
        struct Body: Encodable {
            var operationId: String
            var opening: Opening
        }
        return try await post(
            path: "/conversations/\(parentId)/substreams/confirm",
            body: Body(
                operationId: operationId,
                opening: Opening(
                    clientMessageId: clientMessageId,
                    text: text,
                    mentions: [],
                    attachmentIds: attachmentIds,
                    confirmedParticipantUserIds: []
                )
            ),
            as: SubstreamCreationResult.self,
            headers: [APIConfiguration.operationHeader: operationId]
        )
    }

    func cancelSubstream(parentId: String, operationId: String) async {
        struct Body: Encodable { var operationId: String }
        try? await postVoid(
            path: "/conversations/\(parentId)/substreams/cancel",
            body: Body(operationId: operationId),
            authorized: true
        )
    }

    func renameSubstream(parentId: String, substreamId: String, title: String) async throws {
        struct Body: Encodable { var title: String }
        try await requestVoid(
            method: "PATCH",
            path: "/conversations/\(parentId)/substreams/\(substreamId)",
            body: Body(title: title)
        )
    }

    func setSubstreamArchived(parentId: String, substreamId: String, archived: Bool) async throws {
        struct Body: Encodable { var archived: Bool }
        try await requestVoid(
            method: "PATCH",
            path: "/conversations/\(parentId)/substreams/\(substreamId)",
            body: Body(archived: archived)
        )
    }

    func workspaceSocketTicket() async throws -> RallySocketTicket {
        try await get(path: "/workspace/socket", as: RallySocketTicket.self)
    }

    /// Suggested-work chips are still HTTP — the Worker invalidates on the
    /// socket but does not yet push the rows (choosing-sockets-or-rest.md).
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

    func createSidekick() async throws -> String {
        struct Created: Decodable { var automationId: String }
        struct Body: Encodable {}
        let created: Created = try await post(path: "/sidekicks", body: Body(), as: Created.self)
        return created.automationId
    }

    /// Members are still HTTP — workspace_sync invalidates, the payload does
    /// not carry the rows (choosing-sockets-or-rest.md).
    func listMembers() async throws -> [RallyMember] {
        struct Page: Decodable { var items: [RallyMember] }
        let page: Page = try await get(path: "/workspace/members", as: Page.self)
        return page.items
    }

    func searchWorkspace(query: String, cursor: String? = nil) async throws -> RallySearchPage {
        struct Body: Encodable {
            var query: String
            var category: String
            var pageSize: Int
            var cursor: String?

            enum CodingKeys: String, CodingKey { case query, category, pageSize, cursor }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(query, forKey: .query)
                try container.encode(category, forKey: .category)
                try container.encode(pageSize, forKey: .pageSize)
                try container.encodeIfPresent(cursor, forKey: .cursor)
            }
        }
        return try await post(
            path: "/search",
            body: Body(
                query: query,
                category: "all",
                pageSize: RallyPagedDirectory.searchPageSize,
                cursor: cursor
            ),
            as: RallySearchPage.self
        )
    }

    /// Digest is still HTTP — same Worker gap as members and suggested work.
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
        extraHeaders: [String: String] = [:],
        baseURL: URL? = nil,
        bearerToken: String? = nil
    ) async throws -> T {
        let (data, response) = try await send(
            method: method,
            path: path,
            bodyData: bodyData,
            contentType: contentType,
            authorized: authorized,
            extraHeaders: extraHeaders,
            baseURL: baseURL,
            bearerToken: bearerToken
        )
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
        extraHeaders: [String: String],
        baseURL: URL? = nil,
        bearerToken: String? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        let root = baseURL ?? self.baseURL
        guard let url = URL(string: path, relativeTo: root)?.absoluteURL else {
            throw RallyAPIError(status: 0, code: "invalid_url", message: "The request URL was invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token = bearerToken ?? accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
    var snapshotId: String?
    var eventSequence: Int?
    var snapshotThrough: Int?
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
