import Foundation

/// Conversation-feed WebSocket. Tickets travel as `Sec-WebSocket-Protocol`
/// tokens (`rally.ticket.v1` plus the JWS), never as a query parameter.
actor ConversationSocket {
    private var task: URLSessionWebSocketTask?
    private let session: URLSession
    private var continuation: AsyncStream<Incoming>.Continuation?

    enum Incoming: Sendable {
        case snapshot(ConversationBoot)
        case turnUpserted(TranscriptTurn)
        case commandSucceeded(clientMessageId: String, turnId: String?)
        case commandFailed(message: String)
        case closed(code: URLSessionWebSocketTask.CloseCode)
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
            continuation?.yield(.closed(code: .abnormalClosure))
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

    func sendMessage(text: String, clientMessageId: String, operationId: String, attachmentIds: [String] = []) async throws {
        let payload: [String: Any] = [
            "type": "create_message",
            "operationId": operationId,
            "payload": [
                "text": text,
                "clientMessageId": clientMessageId,
                "mentions": [] as [Any],
                "confirmedParticipantUserIds": [] as [Any],
                "attachmentIds": attachmentIds,
            ] as [String: Any],
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let string = String(data: data, encoding: .utf8) else { return }
        try await task?.send(.string(string))
    }

    func subscribe(afterSequence: Int = 0) async {
        let payload: [String: Any] = [
            "type": "subscribe",
            "afterSequence": afterSequence,
            "publishPresence": true,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let string = String(data: data, encoding: .utf8) else { return }
        try? await task?.send(.string(string))
    }

    func stop(operationId: String) async {
        let payload: [String: Any] = ["type": "stop_harness", "operationId": operationId]
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
            Task {
                await self.handle(result)
            }
        }
    }

    private func handle(_ result: Result<URLSessionWebSocketTask.Message, Error>) async {
        switch result {
        case .failure:
            continuation?.yield(.closed(code: .abnormalClosure))
            continuation?.finish()
        case .success(let message):
            let data: Data?
            switch message {
            case .string(let string): data = string.data(using: .utf8)
            case .data(let value): data = value
            @unknown default: data = nil
            }
            if let data {
                emit(data)
            }
            receiveLoop()
        }
    }

    private func emit(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        switch type {
        case "snapshot":
            if let boot = try? JSONCoding.decoder.decode(ConversationBoot.self, from: data) {
                continuation?.yield(.snapshot(boot))
            }
        case "turn_upserted":
            if let turn = (object["turn"] as? [String: Any]).flatMap({
                try? JSONSerialization.data(withJSONObject: $0)
            }).flatMap({ try? JSONCoding.decoder.decode(TranscriptTurn.self, from: $0) }) {
                continuation?.yield(.turnUpserted(turn))
            }
        case "client_command_succeeded":
            let clientMessageId = object["clientMessageId"] as? String
                ?? (object["turn"] as? [String: Any])?["clientMessageId"] as? String
                ?? ""
            let turnId = (object["turn"] as? [String: Any])?["turnId"] as? String
            continuation?.yield(.commandSucceeded(clientMessageId: clientMessageId, turnId: turnId))
        case "client_command_failed":
            let message = (object["error"] as? [String: Any])?["message"] as? String ?? "That message could not be sent."
            continuation?.yield(.commandFailed(message: message))
        default:
            break
        }
    }
}
