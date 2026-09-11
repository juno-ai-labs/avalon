import Foundation

/// Workspace directory socket. Tickets travel as `Sec-WebSocket-Protocol`
/// tokens, same as the conversation feed. The subscribe answer carries the
/// sidebar — work streams, notes, Sidekicks, and projects — which is the only
/// list of projects the API publishes (there is no `GET /projects`).
actor WorkspaceSocket {
    private var task: URLSessionWebSocketTask?
    private let session: URLSession
    private var continuation: AsyncStream<Incoming>.Continuation?

    enum Incoming: Sendable {
        case sidebar(WorkspaceSidebar)
        case closed
    }

    struct WorkspaceSidebar: Decodable, Sendable {
        var workstreams: WorkstreamPage?
        var automations: SidekickPage?
        var notes: NotePage?
        var projects: ProjectSnapshot?

        struct WorkstreamPage: Decodable, Sendable { var items: [RallyWorkstream]? }
        struct SidekickPage: Decodable, Sendable { var items: [RallySidekick]? }
        struct NotePage: Decodable, Sendable { var items: [RallyNote]? }
        struct ProjectSnapshot: Decodable, Sendable {
            var active: ProjectPage?
            var inactive: ProjectPage?
        }
        struct ProjectPage: Decodable, Sendable { var items: [RallyProject]? }
    }

    init(session: URLSession = .shared) {
        self.session = session
    }

    func connect(ticket: RallySocketTicket) -> AsyncStream<Incoming> {
        disconnect()
        let stream = AsyncStream<Incoming> { continuation in
            self.continuation = continuation
        }
        guard let url = URL(string: ticket.url) else {
            continuation?.yield(.closed)
            continuation?.finish()
            return stream
        }
        let task = session.webSocketTask(with: url, protocols: [APIConfiguration.socketTicketSubprotocol, ticket.ticket])
        self.task = task
        task.resume()
        Task { await self.subscribe() }
        receiveLoop()
        return stream
    }

    func subscribe() async {
        let payload: [String: Any] = ["type": "subscribe", "afterWaterline": 0]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let string = String(data: data, encoding: .utf8) else { return }
        try? await task?.send(.string(string))
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        continuation?.finish()
        continuation = nil
    }

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            Task { await self.handle(result) }
        }
    }

    private func handle(_ result: Result<URLSessionWebSocketTask.Message, Error>) async {
        switch result {
        case .failure:
            continuation?.yield(.closed)
            continuation?.finish()
        case .success(let message):
            let data: Data?
            switch message {
            case .string(let string): data = string.data(using: .utf8)
            case .data(let value): data = value
            @unknown default: data = nil
            }
            if let data { emit(data) }
            receiveLoop()
        }
    }

    private func emit(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        guard type == "workspace_sync", let sidebarObject = object["sidebar"] else { return }
        guard let sidebarData = try? JSONSerialization.data(withJSONObject: sidebarObject),
              let sidebar = try? JSONCoding.decoder.decode(WorkspaceSidebar.self, from: sidebarData) else { return }
        continuation?.yield(.sidebar(sidebar))
    }
}
