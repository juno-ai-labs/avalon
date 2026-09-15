import Foundation

/// The conversation a feed socket is for. Tickets and owners key on this pair.
struct RallyFeedKey: Hashable, Sendable {
    var parentId: String
    var substreamId: String
}

/// One feed the iOS pool may hold. `publishPresence` is true only for the
/// conversation on screen; a retained Main feed stays presence-free.
struct RallyRetainedFeed: Hashable, Sendable {
    var parentId: String
    var substreamId: String
    var publishPresence: Bool

    var key: RallyFeedKey { RallyFeedKey(parentId: parentId, substreamId: substreamId) }
}

/// The sockets iOS keeps at once. Not the desktop pin/recent/running swarm:
/// workspace for the session, control for the parent on the stack, the visible
/// feed, Main of that parent when the parent still has a substream list, and
/// presence-free Main (or child) feeds for directory rows that stayed on
/// screen long enough to warm.
struct RallySocketRetainSet: Equatable, Sendable {
    var workspace: Bool
    var controlParentId: String?
    var feeds: Set<RallyRetainedFeed>

    static let empty = RallySocketRetainSet(workspace: false, controlParentId: nil, feeds: [])
}

/// Navigation-shaped retain policy. The desktop pool is a different client.
enum RallySocketPolicy {
    /// Same delay as desktop `WORKSTREAM_SOCKET_HOVER_WARMUP_MS` in
    /// `apps/desktop/src/renderer/lib/workstream-socket-pool.tsx`.
    static let hoverWarmupSeconds: TimeInterval = 1

    static func retainSet(
        workspaceReady: Bool,
        parentId: String?,
        visibleSubstreamId: String?,
        canUseSubstreams: Bool,
        warmedFeeds: Set<RallyFeedKey> = []
    ) -> RallySocketRetainSet {
        guard workspaceReady else { return .empty }
        var set: RallySocketRetainSet
        if let parentId {
            set = navigationSet(
                parentId: parentId,
                visibleSubstreamId: visibleSubstreamId,
                canUseSubstreams: canUseSubstreams
            )
        } else {
            set = RallySocketRetainSet(workspace: true, controlParentId: nil, feeds: [])
        }
        for key in warmedFeeds where !set.feeds.contains(where: { $0.key == key }) {
            set.feeds.insert(RallyRetainedFeed(
                parentId: key.parentId,
                substreamId: key.substreamId,
                publishPresence: false
            ))
        }
        return set
    }

    private static func navigationSet(
        parentId: String,
        visibleSubstreamId: String?,
        canUseSubstreams: Bool
    ) -> RallySocketRetainSet {
        if !canUseSubstreams {
            var feeds: Set<RallyRetainedFeed> = []
            if let visibleSubstreamId {
                feeds.insert(RallyRetainedFeed(
                    parentId: parentId,
                    substreamId: visibleSubstreamId,
                    publishPresence: true
                ))
            }
            return RallySocketRetainSet(workspace: true, controlParentId: nil, feeds: feeds)
        }
        var feeds: Set<RallyRetainedFeed> = [
            RallyRetainedFeed(
                parentId: parentId,
                substreamId: SubstreamAddress.main,
                publishPresence: visibleSubstreamId == SubstreamAddress.main
            ),
        ]
        if let visibleSubstreamId, visibleSubstreamId != SubstreamAddress.main {
            feeds.insert(RallyRetainedFeed(
                parentId: parentId,
                substreamId: visibleSubstreamId,
                publishPresence: true
            ))
        }
        return RallySocketRetainSet(workspace: true, controlParentId: parentId, feeds: feeds)
    }
}

struct RallyFeedSnapshot: Sendable, Equatable {
    var messages: [RallyChatMessage]
    var title: String?
    var hasOlderTranscript: Bool
    var snapshotId: String? = nil
    var eventSequence: Int = 0
}
