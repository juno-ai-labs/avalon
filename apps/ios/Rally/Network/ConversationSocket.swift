import Foundation

/// Conversation-feed codec on `RallyTicketedSocket`. Subscribe, send, stop,
/// retry, elicitation, older ranges, and `mark_opened` are frames on that
/// transport — not REST.
actor ConversationSocket {
    private let transport = RallyTicketedSocket()
    private var publishPresence = true
    private var afterSequence = 0

    func isConnected() async -> Bool { await transport.isConnected() }
    func isBusy() async -> Bool { await transport.isBusy() }

    enum Incoming: Sendable {
        case snapshot(ConversationBoot)
        case turnUpserted(TranscriptTurn)
        case streamStarted(turnId: String, streamId: String, reset: Bool)
        case streamDelta(turnId: String, streamId: String, delta: String, reset: Bool)
        case streamCompleted(streamId: String)
        case olderTurns([TranscriptTurn], coveredStartInclusive: Int)
        case commandSucceeded(clientMessageId: String, turnId: String?)
        case commandFailed(message: String)
        case resyncRequired
        case closed
    }

    func connect(
        ticket: RallySocketTicket,
        afterSequence: Int = 0,
        publishPresence: Bool = true
    ) async -> AsyncStream<Incoming> {
        self.afterSequence = afterSequence
        self.publishPresence = publishPresence
        let frames = await transport.connect(
            ticket: ticket,
            subscribe: Self.json(Self.subscribePayload(afterSequence: afterSequence, publishPresence: publishPresence))
        )
        return mapFrames(frames)
    }

    func sendMessage(text: String, clientMessageId: String, operationId: String, attachmentIds: [String] = []) async throws {
        try await transport.send(Self.json([
            "type": "create_message",
            "operationId": operationId,
            "payload": [
                "text": text,
                "clientMessageId": clientMessageId,
                "mentions": [] as [Any],
                "confirmedParticipantUserIds": [] as [Any],
                "attachmentIds": attachmentIds,
            ] as [String: Any],
        ]))
    }

    func subscribe(afterSequence: Int = 0, publishPresence: Bool = true) async {
        self.afterSequence = afterSequence
        self.publishPresence = publishPresence
        await transport.subscribe(
            Self.json(Self.subscribePayload(afterSequence: afterSequence, publishPresence: publishPresence))
        )
    }

    func markOpened() async {
        await transport.sendIfOpen(Self.json(["type": "mark_opened"]))
        if !publishPresence {
            await subscribe(afterSequence: afterSequence, publishPresence: true)
        }
    }

    func retry(operationId: String) async {
        await transport.sendIfOpen(Self.json(["type": "retry_harness", "operationId": operationId]))
    }

    func stop(operationId: String) async {
        await transport.sendIfOpen(Self.json(["type": "stop_harness", "operationId": operationId]))
    }

    func answerElicitation(id: String, answer: RallyElicitation.RallyElicitationAnswer?, skipped: Bool, operationId: String) async throws {
        var inner: [String: Any] = [:]
        if skipped {
            inner["skipped"] = true
        } else if let answer {
            switch answer {
            case .text(let value):
                inner["answer"] = value
            case .list(let values):
                inner["answer"] = values
            }
            inner["skipped"] = false
        }
        try await transport.send(Self.json([
            "type": "answer_elicitation",
            "operationId": operationId,
            "elicitationId": id,
            "payload": inner,
        ]))
    }

    func loadOlder(
        requestId: String,
        snapshotId: String,
        startInclusive: Int,
        endExclusive: Int,
        resumeAfterEventSequence: Int
    ) async throws {
        try await transport.send(Self.json([
            "type": "load_transcript_range",
            "requestId": requestId,
            "request": [
                "snapshotId": snapshotId,
                "range": [
                    "startInclusive": startInclusive,
                    "endExclusive": endExclusive,
                ] as [String: Any],
                "resumeAfterEventSequence": resumeAfterEventSequence,
            ] as [String: Any],
        ]))
    }

    func requestSnapshot() async {
        await transport.sendIfOpen(Self.json(["type": "request_snapshot"]))
    }

    func disconnect() async {
        await transport.disconnect()
    }

    private static func json(_ object: [String: Any]) -> Data {
        RallyTicketedSocket.encode(object) ?? Data()
    }

    private static func subscribePayload(afterSequence: Int, publishPresence: Bool) -> [String: Any] {
        [
            "type": "subscribe",
            "afterSequence": afterSequence,
            "publishPresence": publishPresence,
        ]
    }

    private func mapFrames(_ frames: AsyncStream<RallyTicketedSocket.Incoming>) -> AsyncStream<Incoming> {
        AsyncStream { continuation in
            let task = Task {
                for await event in frames {
                    switch event {
                    case .frame(let data):
                        if let incoming = Self.incoming(from: data) {
                            continuation.yield(incoming)
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

    /// Maps a work-stream room frame. Live turns are `transcript_turn_upserted`;
    /// `turn_upserted` is the range-protocol name and is ignored here.
    nonisolated static func incoming(from data: Data) -> Incoming? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        switch type {
        case "snapshot":
            return (try? JSONCoding.decoder.decode(ConversationBoot.self, from: data)).map { .snapshot($0) }
        case "transcript_turn_upserted":
            return (object["turn"] as? [String: Any]).flatMap {
                try? JSONSerialization.data(withJSONObject: $0)
            }.flatMap { try? JSONCoding.decoder.decode(TranscriptTurn.self, from: $0) }
            .map { .turnUpserted($0) }
        case "stream_started":
            guard let turnId = object["turnId"] as? String, let streamId = object["streamId"] as? String else {
                return nil
            }
            return .streamStarted(turnId: turnId, streamId: streamId, reset: object["reset"] as? Bool ?? false)
        case "stream_delta":
            guard let turnId = object["turnId"] as? String, let streamId = object["streamId"] as? String else {
                return nil
            }
            return .streamDelta(
                turnId: turnId,
                streamId: streamId,
                delta: object["delta"] as? String ?? "",
                reset: object["reset"] as? Bool ?? false
            )
        case "stream_completed":
            guard let streamId = object["streamId"] as? String else { return nil }
            return .streamCompleted(streamId: streamId)
        case "client_command_succeeded":
            let clientMessageId = object["clientMessageId"] as? String
                ?? (object["turn"] as? [String: Any])?["clientMessageId"] as? String
                ?? ""
            let turnId = (object["turn"] as? [String: Any])?["turnId"] as? String
            return .commandSucceeded(clientMessageId: clientMessageId, turnId: turnId)
        case "client_command_failed":
            let message = (object["error"] as? [String: Any])?["message"] as? String ?? "That message could not be sent."
            return .commandFailed(message: message)
        case "transcript_range":
            let result = object["result"] as? [String: Any]
            let turnsObject = result?["turns"] ?? []
            let turnsData = (try? JSONSerialization.data(withJSONObject: turnsObject)) ?? Data("[]".utf8)
            let turns = (try? JSONCoding.decoder.decode([TranscriptTurn].self, from: turnsData)) ?? []
            let coveredStart = (result?["covered"] as? [String: Any])?["startInclusive"] as? Int
                ?? turns.compactMap(\.transcriptSequence).min()
                ?? 1
            return .olderTurns(turns, coveredStartInclusive: coveredStart)
        case "resync_required":
            return .resyncRequired
        case "error":
            let message = object["message"] as? String ?? "This part of the transcript could not be loaded."
            return .commandFailed(message: message)
        default:
            return nil
        }
    }
}
