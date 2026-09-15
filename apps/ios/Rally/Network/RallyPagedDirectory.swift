import Foundation

/// Merge rules for cursor-paged Rally directories. The subscribe answer is
/// page one; later pages append; a payload with no cursor is the whole list.
enum RallyPagedDirectory {
    /// Same bound as desktop `WORKSTREAM_PAGE_SIZE` and `list_workstreams`
    /// `limit` max (`WorkspaceSocketClientEventSchema`, 2026-09).
    static let workstreamPageSize = 250

    /// `SearchRequestSchema.pageSize` max in `packages/contracts/src/search.ts`.
    static let searchPageSize = 50

    /// Same block as desktop `TRANSCRIPT_RANGE_BLOCK_SIZE` in
    /// `apps/desktop/src/renderer/lib/transcript.ts`.
    static let transcriptRangeBlockSize = 20

    /// Half-open interval immediately older than the loaded edge, or nil when
    /// sequence 1 is already on screen.
    static func olderTranscriptRange(oldestLoadedSequence: Int) -> (startInclusive: Int, endExclusive: Int)? {
        guard oldestLoadedSequence > 1 else { return nil }
        return (
            startInclusive: max(1, oldestLoadedSequence - transcriptRangeBlockSize),
            endExclusive: oldestLoadedSequence
        )
    }

    /// Subscribe page one over a scrolled list: incoming rows win, later pages
    /// stay. A nil cursor is the whole directory and replaces.
    static func applySubscribePage<Item: Identifiable>(
        existing: [Item],
        incoming: [Item],
        nextCursor: String?
    ) -> [Item] where Item.ID: Hashable {
        if nextCursor == nil {
            return incoming
        }
        let refreshed = Set(incoming.map(\.id))
        return incoming + existing.filter { !refreshed.contains($0.id) }
    }

    /// Later pages from `list_workstreams`, search, or REST `before`.
    static func appendPage<Item: Identifiable>(
        existing: [Item],
        incoming: [Item]
    ) -> [Item] where Item.ID: Hashable {
        var seen = Set(existing.map(\.id))
        var merged = existing
        for item in incoming where !seen.contains(item.id) {
            seen.insert(item.id)
            merged.append(item)
        }
        return merged
    }

    /// Recency or a live row: replace in place, or insert at the front.
    static func upsert<Item: Identifiable>(existing: [Item], item: Item) -> [Item] where Item.ID: Hashable {
        if let index = existing.firstIndex(where: { $0.id == item.id }) {
            var next = existing
            next[index] = item
            return next
        }
        return [item] + existing
    }
}
