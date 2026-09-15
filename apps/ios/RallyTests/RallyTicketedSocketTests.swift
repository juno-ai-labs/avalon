import XCTest
@testable import Rally

final class RallyTicketedSocketTests: XCTestCase {
    func testInvalidTicketURLClosesWithoutConnecting() async {
        let socket = RallyTicketedSocket()
        let stream = await socket.connect(
            ticket: RallySocketTicket(url: "not a url", ticket: "t"),
            subscribe: RallyTicketedSocket.encode(["type": "subscribe"]) ?? Data()
        )
        var events: [RallyTicketedSocket.Incoming] = []
        for await event in stream {
            events.append(event)
        }
        XCTAssertEqual(events.count, 1)
        guard case .closed = events[0] else {
            return XCTFail("expected closed")
        }
        let connected = await socket.isConnected()
        let busy = await socket.isBusy()
        XCTAssertFalse(connected)
        XCTAssertFalse(busy)
    }
}
