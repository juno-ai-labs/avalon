import Foundation

/// Parent-scoped control socket. The feed socket is one conversation; this one
/// is the work stream's child directory (`privateChildren`) and title, the same
/// `workstream_metadata` frames the desktop center rail listens to.
actor WorkstreamControlSocket {
    private var task: URLSessionWebSocketTask?
    private let session: URLSession
    private var continuation: AsyncStream<Incoming>.Continuation?

    enum Incoming: Sendable {
        case metadata(RallyWorkstreamControlMetadata)
        case closed
    }

    init(session: URLSession = .shared) {
        self.session = session
    }

    func connect(ticket: RallySocketTicket) -> AsyncStream<Incoming> {
        disconnect()
        let stream = AsyncStream<Incoming> { continuation in
            self.continuation = continuation
        }
        guard let url = URL(string: ticket.url) else {
            continuation?.yield(.closed)
            continuation?.finish()
            return stream
        }
        let task = session.webSocketTask(with: url, protocols: [APIConfiguration.socketTicketSubprotocol, ticket.ticket])
        self.task = task
        task.resume()
        Task { await self.subscribe() }
        receiveLoop()
        return stream
    }

    func subscribe() async {
        let payload: [String: Any] = ["type": "subscribe"]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let string = String(data: data, encoding: .utf8) else { return }
        try? await task?.send(.string(string))
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        continuation?.finish()
        continuation = nil
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
            continuation?.yield(.closed)
            continuation?.finish()
        case .success(let message):
            let data: Data?
            switch message {
            case .string(let string): data = string.data(using: .utf8)
            case .data(let value): data = value
            @unknown default: data = nil
            }
            if let data { emit(data) }
            receiveLoop()
        }
    }

    private func emit(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String,
              type == "workstream_metadata",
              let metadataObject = object["metadata"] else { return }
        guard let metadataData = try? JSONSerialization.data(withJSONObject: metadataObject),
              let metadata = try? JSONCoding.decoder.decode(RallyWorkstreamControlMetadata.self, from: metadataData) else { return }
        continuation?.yield(.metadata(metadata))
    }
}
