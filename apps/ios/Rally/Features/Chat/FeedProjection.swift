import Foundation

/// Projects a conversation transcript into the same feed row kinds the
/// Electron renderer shows (`docs/conversation-surfaces.md`).
enum FeedProjection {
    static func rows(from turns: [TranscriptTurn]) -> [RallyChatMessage] {
        var projected: [RallyChatMessage] = []
        for turn in turns {
            projected.append(contentsOf: rows(from: turn))
        }
        return collapseSettledWork(projected)
    }

    static func rows(from turn: TranscriptTurn) -> [RallyChatMessage] {
        let created = turn.createdAtUtc.flatMap(JSONCoding.date(from:)) ?? Date()
        let role = role(for: turn.actor)
        let id = turn.turnId ?? UUID().uuidString
        if turn.blocksOmitted == true {
            return tagged([RallyChatMessage(
                id: id,
                kind: .omitted,
                role: role,
                text: "This message is too large to display.",
                createdAt: created,
                isStreaming: false,
                clientMessageId: turn.clientMessageId,
                sequence: turn.transcriptSequence,
                authorName: turn.authorSnapshot?.displayName
            )], turnId: turn.turnId)
        }
        if turn.entryKind == "status" {
            return tagged([RallyChatMessage(
                id: id,
                kind: .system,
                role: .system,
                text: statusText(turn.statusKind),
                createdAt: created,
                isStreaming: false,
                sequence: turn.transcriptSequence,
                statusKind: turn.statusKind
            )], turnId: turn.turnId)
        }
        var rows: [RallyChatMessage] = []
        for (index, block) in (turn.blocks ?? []).enumerated() {
            if block.type == "text", block.messageType == "suggestion" { continue }
            if let row = row(block: block, turn: turn, index: index, created: created, role: role, turnId: id) {
                rows.append(row)
            }
        }
        return tagged(rows, turnId: turn.turnId)
    }

    /// The five turns ending at the branch point, matching desktop
    /// `branchProvenance` (`BRANCH_PROVENANCE_TURNS = 5`).
    static func branchProvenance(messages: [RallyChatMessage], throughTurnId: String?) -> [RallyChatMessage] {
        guard let throughTurnId else { return [] }
        guard let cutoff = messages.lastIndex(where: { $0.turnId == throughTurnId }) else { return [] }
        let start = max(0, cutoff + 1 - 5)
        return Array(messages[start...cutoff])
    }

    private static func tagged(_ rows: [RallyChatMessage], turnId: String?) -> [RallyChatMessage] {
        rows.map { row in
            var copy = row
            copy.turnId = turnId
            return copy
        }
    }

    private static func row(
        block: TranscriptBlock,
        turn: TranscriptTurn,
        index: Int,
        created: Date,
        role: RallyChatMessage.Role,
        turnId: String
    ) -> RallyChatMessage? {
        let id = "\(turnId):\(index)"
        switch block.type {
        case "thinking":
            return RallyChatMessage(
                id: id,
                kind: .thought,
                role: .assistant,
                text: "Thinking",
                createdAt: created,
                isStreaming: block.streaming == true,
                sequence: turn.transcriptSequence
            )
        case "tool":
            let isPlugin = block.pluginId != nil
            return RallyChatMessage(
                id: id,
                kind: isPlugin ? .pluginActivity : .toolEvent,
                role: .assistant,
                text: block.error ?? block.toolName ?? block.pluginId ?? (isPlugin ? "Plugin" : "Tool"),
                createdAt: created,
                isStreaming: block.status == "started" || block.status == "planned",
                sequence: turn.transcriptSequence,
                toolName: block.toolName,
                pluginName: block.pluginId,
                toolStatus: block.status
            )
        case "text", .none:
            let messageType = block.messageType ?? "text"
            if messageType == "elicitation" {
                return RallyChatMessage(
                    id: id,
                    kind: .elicitation,
                    role: .assistant,
                    text: elicitationPrompt(block.structuredContent)
                        ?? block.text.map { visibleParticipantText($0, actor: turn.actor) } ?? "Rally needs input",
                    createdAt: created,
                    isStreaming: false,
                    sequence: turn.transcriptSequence,
                    elicitation: elicitation(from: block.structuredContent)
                )
            }
            if messageType == "system" {
                return RallyChatMessage(
                    id: id,
                    kind: .system,
                    role: .system,
                    text: block.text ?? "",
                    createdAt: created,
                    isStreaming: false,
                    sequence: turn.transcriptSequence
                )
            }
            if messageType == "plugin_activity" || messageType == "tool_event" {
                return RallyChatMessage(
                    id: id,
                    kind: messageType == "plugin_activity" ? .pluginActivity : .toolEvent,
                    role: .assistant,
                    text: block.text ?? block.toolName ?? block.pluginId ?? "Work",
                    createdAt: created,
                    isStreaming: block.streaming == true,
                    sequence: turn.transcriptSequence,
                    toolName: block.toolName,
                    pluginName: block.pluginId,
                    toolStatus: block.status
                )
            }
            if messageType == "thought" {
                return RallyChatMessage(
                    id: id,
                    kind: .thought,
                    role: .assistant,
                    text: block.text ?? "Thinking",
                    createdAt: created,
                    isStreaming: block.streaming == true,
                    sequence: turn.transcriptSequence
                )
            }
            if messageType == "automation_activation" {
                return RallyChatMessage(
                    id: id,
                    kind: .automationActivation,
                    role: .assistant,
                    text: block.text ?? "",
                    createdAt: created,
                    isStreaming: block.streaming == true,
                    sequence: turn.transcriptSequence,
                    authorName: automationName(block.structuredContent)
                )
            }
            let text = visibleParticipantText(block.text ?? "", actor: turn.actor)
            if text.isEmpty, (block.attachments ?? []).isEmpty, block.streaming != true {
                return nil
            }
            return RallyChatMessage(
                id: turn.turnId ?? id,
                kind: .text,
                role: role,
                text: text,
                createdAt: created,
                isStreaming: block.streaming == true,
                clientMessageId: turn.clientMessageId,
                sequence: turn.transcriptSequence,
                authorName: turn.authorSnapshot?.displayName,
                attachments: block.attachments ?? [],
                mentions: block.mentions ?? []
            )
        default:
            return nil
        }
    }

    private static func visibleParticipantText(_ text: String, actor: String?) -> String {
        guard actor == "human" || actor == "external" else { return text }
        return text.replacingOccurrences(
            of: #"^<user_system_prompt>\nThe following was provided by this user as instructions for how to respond to this message\. For other users' requests ignore these instructions\.\n<user_suppplied>\n[\s\S]*?\n</user_suppplied>\n</user_system_prompt>\n{0,2}"#,
            with: "",
            options: .regularExpression
        )
    }

    /// Fold settled thought/tool/plugin rows that sit immediately above an
    /// assistant answer into a `work_accordion`, matching desktop
    /// `collapseSettledWorkIntoAccordion`.
    static func collapseSettledWork(_ rows: [RallyChatMessage]) -> [RallyChatMessage] {
        var result: [RallyChatMessage] = []
        var pending: [RallyChatMessage] = []
        func flushPending() {
            result.append(contentsOf: pending)
            pending.removeAll()
        }
        for row in rows {
            if isMachinery(row), row.isStreaming == false {
                pending.append(row)
                continue
            }
            if row.kind == .text, row.role == .assistant, !pending.isEmpty, pending.allSatisfy({ !$0.isStreaming }) {
                let accordion = RallyChatMessage(
                    id: "work-\(row.id)",
                    kind: .workAccordion,
                    role: .assistant,
                    text: "Worked",
                    createdAt: pending.first?.createdAt ?? row.createdAt,
                    isStreaming: false,
                    sequence: pending.first?.sequence,
                    nested: pending,
                    turnId: row.turnId
                )
                result.append(accordion)
                pending.removeAll()
            } else {
                flushPending()
            }
            result.append(row)
        }
        flushPending()
        return result
    }

    private static func isMachinery(_ row: RallyChatMessage) -> Bool {
        row.kind == .thought || row.kind == .toolEvent || row.kind == .pluginActivity
    }

    private static func role(for actor: String?) -> RallyChatMessage.Role {
        switch actor {
        case "human": .user
        case "external": .external
        case "system": .system
        default: .assistant
        }
    }

    private static func statusText(_ kind: String?) -> String {
        switch kind {
        case "assistant_turn_failed": "Rally couldn’t finish that response."
        case "assistant_turn_stopped": "Stopped."
        default: kind ?? "Status"
        }
    }

    private static func elicitationPrompt(_ content: [String: JSONValue]?) -> String? {
        content?["prompt"]?.string
    }

    private static func automationName(_ content: [String: JSONValue]?) -> String? {
        if case .object(let object) = content?["automation_activation"] {
            return object["automationName"]?.string
        }
        return content?["automationName"]?.string
    }

    static func elicitation(from content: [String: JSONValue]?) -> RallyElicitation? {
        guard let content else { return nil }
        let id = content["id"]?.string ?? UUID().uuidString
        let prompt = content["prompt"]?.string ?? "Rally needs input"
        let responseType = content["responseType"]?.string ?? "text"
        let status = content["status"]?.string ?? "open"
        var options: [RallyElicitationOption] = []
        if case .array(let raw) = content["options"] {
            options = raw.compactMap { item in
                guard case .object(let object) = item else { return nil }
                return RallyElicitationOption(
                    optionId: object["id"]?.string,
                    label: object["label"]?.string,
                    value: object["value"]?.string ?? object["label"]?.string
                )
            }
        }
        return RallyElicitation(id: id, prompt: prompt, responseType: responseType, options: options, status: status, answer: nil)
    }
}

/// Which feed chrome to show while a substream is opening.
enum RallyFeedChrome: Equatable {
    case launch
    case skeleton
    case emptyGreeting
    case messages

    static func resolve(isLaunch: Bool, isConnecting: Bool, hasMessages: Bool) -> RallyFeedChrome {
        if isLaunch { return .launch }
        if hasMessages { return .messages }
        if isConnecting { return .skeleton }
        return .emptyGreeting
    }
}

/// Substream-list chrome. Main and New substream paint immediately; children
/// wait on the parent directory rather than covering the whole list.
enum RallySubstreamListChrome: Equatable {
    case awaitingChildren
    case directory

    static func resolve(hasChildDirectory: Bool) -> RallySubstreamListChrome {
        hasChildDirectory ? .directory : .awaitingChildren
    }
}
