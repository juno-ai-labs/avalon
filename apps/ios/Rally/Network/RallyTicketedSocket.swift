import Foundation

enum RallyTicketedSocketError: Error {
    case notOpen
}

/// Holds the open callback so a URLSession delegate can reach the ticketed
/// socket without the socket actor itself being the delegate.
private final class RallySocketOpenBox: @unchecked Sendable {
    var handler: (@Sendable () -> Void)?
}

private final class RallySocketOpenProbe: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    let box: RallySocketOpenBox

    init(box: RallySocketOpenBox) {
        self.box = box
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        box.handler?()
    }
}

/// The iOS ticketed WebSocket. Every live connection — workspace, parent
/// control, conversation feed — is one of these. Tickets travel as
/// `Sec-WebSocket-Protocol` (`rally.ticket.v1` plus the JWS). The handshake
/// Origin is `app://rallywithai` — URLSession does not send one on its own, and
/// the Worker refuses a missing Origin before it reads the ticket. `subscribe`
/// waits for the handshake; `connected` is true only after that send succeeds. A
/// retain pass must not tear a socket down while `isBusy` — that is the
/// handshake, not a live session to replace.
actor RallyTicketedSocket {
    enum Incoming: Sendable {
        case frame(Data)
        case closed
    }

    private var task: URLSessionWebSocketTask?
    private let session: URLSession
    private let openBox: RallySocketOpenBox
    private var continuation: AsyncStream<Incoming>.Continuation?
    private var connected = false
    private var pendingSubscribe: Data?

    func isConnected() -> Bool { connected }
    func isBusy() -> Bool { connected || task != nil }

    nonisolated static func encode(_ object: [String: Any]) -> Data? {
        try? JSONSerialization.data(withJSONObject: object)
    }

    init() {
        let box = RallySocketOpenBox()
        openBox = box
        let configuration = URLSessionConfiguration.default
        configuration.httpAdditionalHeaders = ["Origin": APIConfiguration.socketOrigin]
        session = URLSession(
            configuration: configuration,
            delegate: RallySocketOpenProbe(box: box),
            delegateQueue: nil
        )
    }

    func connect(ticket: RallySocketTicket, subscribe payload: Data) -> AsyncStream<Incoming> {
        disconnect()
        pendingSubscribe = payload
        let stream = AsyncStream<Incoming> { continuation in
            self.continuation = continuation
        }
        guard let url = URL(string: ticket.url), url.host != nil else {
            pendingSubscribe = nil
            continuation?.yield(.closed)
            continuation?.finish()
            continuation = nil
            return stream
        }
        openBox.handler = {
            Task { await self.sendPendingSubscribe() }
        }
        var request = URLRequest(url: url)
        request.setValue(APIConfiguration.socketOrigin, forHTTPHeaderField: "Origin")
        request.setValue(
            [APIConfiguration.socketTicketSubprotocol, ticket.ticket].joined(separator: ", "),
            forHTTPHeaderField: "Sec-WebSocket-Protocol"
        )
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        Task { await self.sendPendingSubscribe() }
        receiveLoop()
        return stream
    }

    func subscribe(_ payload: Data) async {
        pendingSubscribe = payload
        await sendPendingSubscribe()
    }

    func send(_ payload: Data) async throws {
        guard let task, let string = String(data: payload, encoding: .utf8) else {
            throw RallyTicketedSocketError.notOpen
        }
        try await task.send(.string(string))
    }

    func sendIfOpen(_ payload: Data) async {
        try? await send(payload)
    }

    func disconnect() {
        openBox.handler = nil
        pendingSubscribe = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
        continuation?.finish()
        continuation = nil
    }

    private func sendPendingSubscribe() async {
        guard let payload = pendingSubscribe else { return }
        do {
            try await send(payload)
            connected = true
        } catch {
            connected = false
        }
    }

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            Task { await self.handle(result) }
        }
    }

    private func handle(_ result: Result<URLSessionWebSocketTask.Message, Error>) async {
        switch result {
        case .failure:
            connected = false
            task = nil
            continuation?.yield(.closed)
            continuation?.finish()
        case .success(let message):
            let data: Data?
            switch message {
            case .string(let string): data = string.data(using: .utf8)
            case .data(let value): data = value
            @unknown default: data = nil
            }
            if let data { continuation?.yield(.frame(data)) }
            receiveLoop()
        }
    }
}
