import Foundation

/// Workspace directory codec on `RallyTicketedSocket`. The subscribe answer
/// carries the first sidebar page; later work-stream pages are
/// `list_workstreams` on this socket.
actor WorkspaceSocket {
    /// Same as desktop `COMMAND_TIMEOUT_MS` in
    /// `apps/desktop/src/renderer/lib/workspace-socket.tsx`.
    private static let commandTimeoutSeconds: TimeInterval = 120

    private let transport = RallyTicketedSocket()
    private var pendingPages: [String: CheckedContinuation<WorkstreamPageResult?, Never>] = [:]

    func isConnected() async -> Bool { await transport.isConnected() }
    func isBusy() async -> Bool { await transport.isBusy() }

    enum Incoming: Sendable {
        case sidebar(WorkspaceSidebar)
        case workstreamRecency(RallyWorkstream)
        case closed
    }

    struct WorkstreamPageResult: Sendable {
        var items: [RallyWorkstream]
        var nextCursor: String?
    }

    struct WorkspaceSidebar: Decodable, Sendable {
        var workstreams: WorkstreamPage?
        var automations: SidekickPage?

        struct WorkstreamPage: Decodable, Sendable {
            var items: [RallyWorkstream]?
            var nextCursor: String?
        }

        struct SidekickPage: Decodable, Sendable { var items: [RallySidekick]? }
    }

    func connect(ticket: RallySocketTicket) async -> AsyncStream<Incoming> {
        let frames = await transport.connect(
            ticket: ticket,
            subscribe: Self.json(["type": "subscribe", "afterWaterline": 0])
        )
        return mapFrames(frames)
    }

    func subscribe() async {
        await transport.subscribe(Self.json(["type": "subscribe", "afterWaterline": 0]))
    }

    func listWorkstreams(before: String?, includeSystem: Bool) async -> WorkstreamPageResult? {
        guard await transport.isConnected() else { return nil }
        let requestId = UUID().uuidString.lowercased()
        var payload: [String: Any] = [
            "type": "list_workstreams",
            "requestId": requestId,
            "limit": RallyPagedDirectory.workstreamPageSize,
            "includeSystem": includeSystem,
        ]
        if let before {
            payload["before"] = before
        }
        let body = Self.json(payload)
        return await withCheckedContinuation { continuation in
            pendingPages[requestId] = continuation
            Task {
                do {
                    try await self.transport.send(body)
                } catch {
                    await self.failPage(requestId)
                }
            }
            Task { await self.timeoutPage(requestId) }
        }
    }

    func disconnect() async {
        failAllPages()
        await transport.disconnect()
    }

    private static func json(_ object: [String: Any]) -> Data {
        RallyTicketedSocket.encode(object) ?? Data()
    }

    private func timeoutPage(_ requestId: String) async {
        try? await Task.sleep(for: .seconds(Self.commandTimeoutSeconds))
        pendingPages.removeValue(forKey: requestId)?.resume(returning: nil)
    }

    private func failPage(_ requestId: String) {
        pendingPages.removeValue(forKey: requestId)?.resume(returning: nil)
    }

    private func failAllPages() {
        for (_, continuation) in pendingPages {
            continuation.resume(returning: nil)
        }
        pendingPages.removeAll()
    }

    private func mapFrames(_ frames: AsyncStream<RallyTicketedSocket.Incoming>) -> AsyncStream<Incoming> {
        AsyncStream { continuation in
            let task = Task {
                for await event in frames {
                    switch event {
                    case .frame(let data):
                        await self.emit(data, into: continuation)
                    case .closed:
                        await self.failAllPages()
                        continuation.yield(.closed)
                        continuation.finish()
                        return
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func emit(_ data: Data, into continuation: AsyncStream<Incoming>.Continuation) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        switch type {
        case "workspace_sync":
            guard let sidebarObject = object["sidebar"] else { return }
            guard let sidebarData = try? JSONSerialization.data(withJSONObject: sidebarObject),
                  let sidebar = try? JSONCoding.decoder.decode(WorkspaceSidebar.self, from: sidebarData) else { return }
            continuation.yield(.sidebar(sidebar))
        case "workspace_workstream_page":
            let requestId = object["requestId"] as? String
            let itemsObject = object["items"] ?? []
            let itemsData = (try? JSONSerialization.data(withJSONObject: itemsObject)) ?? Data("[]".utf8)
            let items = (try? JSONCoding.decoder.decode([RallyWorkstream].self, from: itemsData)) ?? []
            let nextCursor = object["nextCursor"] as? String
            let page = WorkstreamPageResult(items: items, nextCursor: nextCursor)
            if let requestId, let pending = pendingPages.removeValue(forKey: requestId) {
                pending.resume(returning: page)
            }
        case "workspace_workstream_recency":
            guard let row = object["workstream"],
                  let rowData = try? JSONSerialization.data(withJSONObject: row),
                  let workstream = try? JSONCoding.decoder.decode(RallyWorkstream.self, from: rowData) else { return }
            continuation.yield(.workstreamRecency(workstream))
        default:
            break
        }
    }
}
