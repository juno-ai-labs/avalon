import SwiftUI

/// Which end of a scroll view is showing. Bottom-anchored feeds must not treat
/// the first layout (offset 0 before the anchor applies) as "the reader pulled
/// to the oldest row."
struct RallyScrollEdge: Equatable {
    var overflows: Bool
    var atTop: Bool
    var nearBottom: Bool

    init(
        offsetY: CGFloat,
        containerHeight: CGFloat,
        contentHeight: CGFloat,
        topInset: CGFloat,
        bottomInset: CGFloat
    ) {
        overflows = contentHeight > containerHeight + 1
        atTop = overflows && offsetY <= topInset + 1
        let visibleBottom = offsetY + containerHeight
        let contentBottom = contentHeight - bottomInset
        nearBottom = !overflows || visibleBottom >= contentBottom - 1
    }
}

/// Terminal-row trigger for cursor pages. Feed history uses `RallyScrollEdge`
/// instead: a LazyVStack sentinel at index 0 appears while the view is still
/// pinned to the newest row.
struct RallyInfiniteScrollTrigger: ViewModifier {
    var isTerminal: Bool
    var hasMore: Bool
    var isLoading: Bool
    var load: () -> Void

    func body(content: Content) -> some View {
        content
            .onAppear(perform: trigger)
            .onChange(of: isLoading) { _, loading in
                if !loading { trigger() }
            }
            .onChange(of: hasMore) { _, more in
                if more { trigger() }
            }
    }

    private func trigger() {
        guard isTerminal, hasMore, !isLoading else { return }
        load()
    }
}

extension View {
    func rallyInfiniteScroll(
        isTerminal: Bool,
        hasMore: Bool,
        isLoading: Bool,
        load: @escaping () -> Void
    ) -> some View {
        modifier(RallyInfiniteScrollTrigger(
            isTerminal: isTerminal,
            hasMore: hasMore,
            isLoading: isLoading,
            load: load
        ))
    }
}
