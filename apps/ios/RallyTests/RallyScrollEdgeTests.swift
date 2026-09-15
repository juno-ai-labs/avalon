import XCTest
@testable import Rally

final class RallyScrollEdgeTests: XCTestCase {
    func testShortContentIsNearBottomAndNotAtTop() {
        let edge = RallyScrollEdge(
            offsetY: 0,
            containerHeight: 800,
            contentHeight: 400,
            topInset: 0,
            bottomInset: 0
        )
        XCTAssertFalse(edge.overflows)
        XCTAssertFalse(edge.atTop)
        XCTAssertTrue(edge.nearBottom)
    }

    func testBottomAnchoredOverflowIsNearBottomNotTop() {
        let edge = RallyScrollEdge(
            offsetY: 200,
            containerHeight: 800,
            contentHeight: 1000,
            topInset: 0,
            bottomInset: 0
        )
        XCTAssertTrue(edge.overflows)
        XCTAssertFalse(edge.atTop)
        XCTAssertTrue(edge.nearBottom)
    }

    func testPulledToOldestRowIsAtTop() {
        let edge = RallyScrollEdge(
            offsetY: 0,
            containerHeight: 800,
            contentHeight: 1000,
            topInset: 0,
            bottomInset: 0
        )
        XCTAssertTrue(edge.overflows)
        XCTAssertTrue(edge.atTop)
        XCTAssertFalse(edge.nearBottom)
    }
}
