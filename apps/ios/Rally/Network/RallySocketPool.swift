import Foundation

/// Owns the iOS retain set: workspace, parent control, visible feed, Main of
/// that parent, and presence-free feeds for warmed directory rows. Snapshots
/// outlive sockets so switching back paints before a new ticket lands.
@MainActor
final class RallySocketPool {
    var onWorkspace: ((WorkspaceSocket.WorkspaceSidebar) -> Void)?
    var onWorkstreamRecency: ((RallyWorkstream) -> Void)?
    var onControl: ((String, RallyWorkstreamControlMetadata) -> Void)?
    var onFeed: ((RallyFeedKey, ConversationSocket.Incoming) -> Void)?

    private let workspaceSocket = WorkspaceSocket()
    private var workspaceTask: Task<Void, Never>?
    private var workspaceOpening = false

    private let controlSocket = WorkstreamControlSocket()
    private var controlTask: Task<Void, Never>?
    private var controlParentId: String?
    private var controlOpening = false

    private struct LiveFeed {
        var socket: ConversationSocket
        var task: Task<Void, Never>?
        var publishPresence: Bool
    }

    private var feeds: [RallyFeedKey: LiveFeed] = [:]
    private var feedOpening: Set<RallyFeedKey> = []
    private(set) var snapshots: [RallyFeedKey: RallyFeedSnapshot] = [:]

    private var pendingSet: RallySocketRetainSet?
    private var isApplying = false

    func snapshot(for key: RallyFeedKey) -> RallyFeedSnapshot? {
        snapshots[key]
    }

    func storeSnapshot(_ snapshot: RallyFeedSnapshot, for key: RallyFeedKey) {
        snapshots[key] = snapshot
    }

    func feedSocket(for key: RallyFeedKey) -> ConversationSocket? {
        feeds[key]?.socket
    }

    func lastSequence(for key: RallyFeedKey) -> Int {
        snapshots[key]?.messages.compactMap(\.sequence).max() ?? 0
    }

    func listWorkstreams(before: String?) async -> WorkspaceSocket.WorkstreamPageResult? {
        await workspaceSocket.listWorkstreams(before: before, includeSystem: false)
    }

    func apply(_ set: RallySocketRetainSet, client: RallyClient) async {
        pendingSet = set
        guard !isApplying else { return }
        isApplying = true
        defer { isApplying = false }
        while let next = pendingSet {
            pendingSet = nil
            await reconcileWorkspace(keep: next.workspace, client: client)
            let current = pendingSet ?? next
            await reconcileControl(parentId: current.controlParentId, client: client)
            if pendingSet != nil { continue }
            await reconcileFeeds(current.feeds, client: client)
        }
    }

    func disconnectAll() async {
        pendingSet = nil
        workspaceOpening = false
        workspaceTask?.cancel()
        await workspaceSocket.disconnect()
        workspaceTask = nil
        controlTask?.cancel()
        await controlSocket.disconnect()
        controlTask = nil
        controlParentId = nil
        controlOpening = false
        feedOpening.removeAll()
        for key in feeds.keys {
            feeds[key]?.task?.cancel()
            await feeds[key]?.socket.disconnect()
        }
        feeds.removeAll()
    }

    func clearSnapshots() {
        snapshots.removeAll()
    }

    private func reconcileWorkspace(keep: Bool, client: RallyClient) async {
        if !keep {
            workspaceOpening = false
            workspaceTask?.cancel()
            await workspaceSocket.disconnect()
            workspaceTask = nil
            return
        }
        if workspaceOpening { return }
        if await workspaceSocket.isBusy() { return }
        workspaceTask?.cancel()
        workspaceOpening = true
        do {
            let ticket = try await client.workspaceSocketTicket()
            let stream = await workspaceSocket.connect(ticket: ticket)
            workspaceOpening = false
            workspaceTask = Task { [weak self] in
                for await event in stream {
                    switch event {
                    case .sidebar(let sidebar):
                        self?.onWorkspace?(sidebar)
                    case .workstreamRecency(let workstream):
                        self?.onWorkstreamRecency?(workstream)
                    case .closed:
                        break
                    }
                }
            }
        } catch {
            workspaceOpening = false
            // Directory paints from the next successful subscribe.
        }
    }

    private func reconcileControl(parentId: String?, client: RallyClient) async {
        guard let parentId else {
            controlTask?.cancel()
            await controlSocket.disconnect()
            controlTask = nil
            controlParentId = nil
            controlOpening = false
            return
        }
        if controlParentId == parentId {
            if controlOpening { return }
            if await controlSocket.isBusy() { return }
        }
        controlTask?.cancel()
        await controlSocket.disconnect()
        controlParentId = parentId
        controlOpening = true
        do {
            let ticket = try await client.workstreamControlSocketTicket(id: parentId)
            let stream = await controlSocket.connect(ticket: ticket)
            controlOpening = false
            let retainedParent = parentId
            controlTask = Task { [weak self] in
                var delivered = false
                for await event in stream {
                    switch event {
                    case .metadata(let metadata):
                        delivered = true
                        self?.onControl?(retainedParent, metadata)
                    case .closed:
                        if !delivered {
                            delivered = true
                            self?.onControl?(
                                retainedParent,
                                RallyWorkstreamControlMetadata(privateChildren: [])
                            )
                        }
                    }
                }
            }
        } catch {
            controlOpening = false
            onControl?(parentId, RallyWorkstreamControlMetadata(privateChildren: []))
        }
    }

    private func reconcileFeeds(_ desired: Set<RallyRetainedFeed>, client: RallyClient) async {
        let wanted = Dictionary(uniqueKeysWithValues: desired.map { ($0.key, $0) })
        for key in feeds.keys where wanted[key] == nil {
            feeds[key]?.task?.cancel()
            await feeds[key]?.socket.disconnect()
            feeds.removeValue(forKey: key)
        }
        let ordered = desired.sorted { left, right in
            if left.publishPresence != right.publishPresence { return left.publishPresence }
            if left.substreamId == SubstreamAddress.main && right.substreamId != SubstreamAddress.main {
                return true
            }
            return false
        }
        for feed in ordered {
            if pendingSet != nil { return }
            await openFeed(feed, client: client)
        }
    }

    private func openFeed(_ feed: RallyRetainedFeed, client: RallyClient) async {
        if feedOpening.contains(feed.key) { return }
        if let live = feeds[feed.key] {
            if await live.socket.isBusy() {
                if await live.socket.isConnected(), live.publishPresence != feed.publishPresence {
                    var live = live
                    if feed.publishPresence {
                        await live.socket.markOpened()
                    } else {
                        await live.socket.subscribe(
                            afterSequence: lastSequence(for: feed.key),
                            publishPresence: false
                        )
                    }
                    live.publishPresence = feed.publishPresence
                    feeds[feed.key] = live
                }
                return
            }
        }
        feeds[feed.key]?.task?.cancel()
        await feeds[feed.key]?.socket.disconnect()
        let socket = feeds[feed.key]?.socket ?? ConversationSocket()
        feedOpening.insert(feed.key)
        defer { feedOpening.remove(feed.key) }
        do {
            let ticket = try await client.conversationSocketTicket(
                parentId: feed.parentId,
                substreamId: feed.substreamId
            )
            let desired = pendingSet?.feeds.first(where: { $0.key == feed.key }) ?? feed
            if pendingSet != nil, pendingSet?.feeds.contains(where: { $0.key == feed.key }) != true {
                return
            }
            let key = desired.key
            let stream = await socket.connect(
                ticket: ticket,
                afterSequence: lastSequence(for: key),
                publishPresence: desired.publishPresence
            )
            let task = Task { [weak self] in
                for await event in stream {
                    self?.onFeed?(key, event)
                }
            }
            feeds[key] = LiveFeed(socket: socket, task: task, publishPresence: desired.publishPresence)
        } catch {
            feeds.removeValue(forKey: feed.key)
        }
    }
}
