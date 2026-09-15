import XCTest
@testable import Rally

final class RallySocketPolicyTests: XCTestCase {
    func testSignedOutHoldsNothing() {
        let set = RallySocketPolicy.retainSet(
            workspaceReady: false,
            parentId: "wsr_1",
            visibleSubstreamId: "0",
            canUseSubstreams: true
        )
        XCTAssertEqual(set, .empty)
    }

    func testChatsListHoldsOnlyWorkspace() {
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: nil,
            visibleSubstreamId: nil,
            canUseSubstreams: false
        )
        XCTAssertTrue(set.workspace)
        XCTAssertNil(set.controlParentId)
        XCTAssertTrue(set.feeds.isEmpty)
    }

    func testSubstreamListKeepsControlAndPresenceFreeMain() {
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: "wsr_1",
            visibleSubstreamId: nil,
            canUseSubstreams: true
        )
        XCTAssertEqual(set.controlParentId, "wsr_1")
        XCTAssertEqual(set.feeds, [
            RallyRetainedFeed(parentId: "wsr_1", substreamId: "0", publishPresence: false),
        ])
    }

    func testVisibleMainIsTheOnlyFeedAndPublishesPresence() {
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: "wsr_1",
            visibleSubstreamId: "0",
            canUseSubstreams: true
        )
        XCTAssertEqual(set.feeds, [
            RallyRetainedFeed(parentId: "wsr_1", substreamId: "0", publishPresence: true),
        ])
    }

    func testVisibleChildKeepsPresenceFreeMain() {
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: "wsr_1",
            visibleSubstreamId: "child-1",
            canUseSubstreams: true
        )
        XCTAssertEqual(set.controlParentId, "wsr_1")
        XCTAssertEqual(set.feeds, [
            RallyRetainedFeed(parentId: "wsr_1", substreamId: "0", publishPresence: false),
            RallyRetainedFeed(parentId: "wsr_1", substreamId: "child-1", publishPresence: true),
        ])
    }

    func testSidekickHasNoControlAndNoExtraMain() {
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: "auto_1",
            visibleSubstreamId: "0",
            canUseSubstreams: false
        )
        XCTAssertNil(set.controlParentId)
        XCTAssertEqual(set.feeds, [
            RallyRetainedFeed(parentId: "auto_1", substreamId: "0", publishPresence: true),
        ])
    }

    func testSidekickWithoutAVisibleFeedHoldsNoFeeds() {
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: "auto_1",
            visibleSubstreamId: nil,
            canUseSubstreams: false
        )
        XCTAssertNil(set.controlParentId)
        XCTAssertTrue(set.feeds.isEmpty)
    }

    func testWarmedDirectoryRowAddsPresenceFreeFeed() {
        let warmed = Set([RallyFeedKey(parentId: "wsr_2", substreamId: "0")])
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: nil,
            visibleSubstreamId: nil,
            canUseSubstreams: false,
            warmedFeeds: warmed
        )
        XCTAssertTrue(set.workspace)
        XCTAssertEqual(set.feeds, [
            RallyRetainedFeed(parentId: "wsr_2", substreamId: "0", publishPresence: false),
        ])
    }

    func testWarmedVisibleFeedDoesNotDropPresence() {
        let warmed = Set([RallyFeedKey(parentId: "wsr_1", substreamId: "0")])
        let set = RallySocketPolicy.retainSet(
            workspaceReady: true,
            parentId: "wsr_1",
            visibleSubstreamId: "0",
            canUseSubstreams: true,
            warmedFeeds: warmed
        )
        XCTAssertEqual(set.feeds, [
            RallyRetainedFeed(parentId: "wsr_1", substreamId: "0", publishPresence: true),
        ])
    }
}
