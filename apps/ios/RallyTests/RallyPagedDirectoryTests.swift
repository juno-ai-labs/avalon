import XCTest
@testable import Rally

final class RallyPagedDirectoryTests: XCTestCase {
    func testSubscribeWithCursorKeepsLaterPagesAndRefreshesPageOne() {
        let pageOne = [item("a", "A1"), item("b", "B")]
        let later = [item("c", "C")]
        let existing = pageOne + later
        let refreshed = [item("a", "A2"), item("b", "B")]
        let merged = RallyPagedDirectory.applySubscribePage(
            existing: existing,
            incoming: refreshed,
            nextCursor: "1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        )
        XCTAssertEqual(merged.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(merged.first?.title, "A2")
    }

    func testSubscribeWithoutCursorReplacesTheWholeDirectory() {
        let existing = [item("a", "A"), item("kept", "Later")]
        let incoming = [item("a", "A")]
        let merged = RallyPagedDirectory.applySubscribePage(
            existing: existing,
            incoming: incoming,
            nextCursor: nil
        )
        XCTAssertEqual(merged.map(\.id), ["a"])
    }

    func testAppendPageSkipsIdsAlreadyResident() {
        let existing = [item("a", "A"), item("b", "B")]
        let page = [item("b", "B-dup"), item("c", "C")]
        XCTAssertEqual(
            RallyPagedDirectory.appendPage(existing: existing, incoming: page).map(\.id),
            ["a", "b", "c"]
        )
    }

    func testUpsertReplacesAndInsertsAtFront() {
        let existing = [item("a", "A"), item("b", "B")]
        let replaced = RallyPagedDirectory.upsert(existing: existing, item: item("b", "B2"))
        XCTAssertEqual(replaced.map(\.title), ["A", "B2"])
        let inserted = RallyPagedDirectory.upsert(existing: existing, item: item("c", "C"))
        XCTAssertEqual(inserted.map(\.id), ["c", "a", "b"])
    }

    func testOlderTranscriptRangeAsksTheDesktopBlock() {
        let range = RallyPagedDirectory.olderTranscriptRange(oldestLoadedSequence: 45)
        XCTAssertEqual(range?.startInclusive, 25)
        XCTAssertEqual(range?.endExclusive, 45)
    }

    func testOlderTranscriptRangeStopsAtSequenceOne() {
        XCTAssertNil(RallyPagedDirectory.olderTranscriptRange(oldestLoadedSequence: 1))
        let clipped = RallyPagedDirectory.olderTranscriptRange(oldestLoadedSequence: 10)
        XCTAssertEqual(clipped?.startInclusive, 1)
        XCTAssertEqual(clipped?.endExclusive, 10)
    }

    private func item(_ id: String, _ title: String) -> RallyWorkstream {
        RallyWorkstream(id: id, title: title)
    }
}
