import Foundation

/// Parent-scoped control codec on `RallyTicketedSocket`. The feed socket is
/// one conversation; this one is the work stream's child directory
/// (`privateChildren`) and title, the same `workstream_metadata` frames the
/// desktop center rail listens to.
actor WorkstreamControlSocket {
    private let transport = RallyTicketedSocket()

    func isConnected() async -> Bool { await transport.isConnected() }
    func isBusy() async -> Bool { await transport.isBusy() }

    enum Incoming: Sendable {
        case metadata(RallyWorkstreamControlMetadata)
        case closed
    }

    func connect(ticket: RallySocketTicket) async -> AsyncStream<Incoming> {
        let frames = await transport.connect(
            ticket: ticket,
            subscribe: Self.json(["type": "subscribe"])
        )
        return mapFrames(frames)
    }

    func subscribe() async {
        await transport.subscribe(Self.json(["type": "subscribe"]))
    }

    func disconnect() async {
        await transport.disconnect()
    }

    private static func json(_ object: [String: Any]) -> Data {
        RallyTicketedSocket.encode(object) ?? Data()
    }

    private func mapFrames(_ frames: AsyncStream<RallyTicketedSocket.Incoming>) -> AsyncStream<Incoming> {
        AsyncStream { continuation in
            let task = Task {
                for await event in frames {
                    switch event {
                    case .frame(let data):
                        if let metadata = RallyWorkstreamControlMetadata.parseSocketFrame(data) {
                            continuation.yield(.metadata(metadata))
                        }
                    case .closed:
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
}
