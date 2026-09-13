import XCTest
@testable import Rally

final class PKCETests: XCTestCase {
    func testChallengeLengthsMatchDesktop() {
        var sizes: [Int] = []
        let challenge = PKCEChallenge.generate { count in
            sizes.append(count)
            return Data(repeating: UInt8(count % 256), count: count)
        }
        XCTAssertEqual(sizes, [32, 48])
        XCTAssertEqual(challenge.attemptId.count, 43)
        XCTAssertEqual(challenge.verifier.count, 64)
        XCTAssertFalse(challenge.challenge.contains("+"))
        XCTAssertFalse(challenge.challenge.contains("/"))
        XCTAssertFalse(challenge.challenge.contains("="))
    }

    func testBase64URLStripsPadding() {
        let encoded = PKCEChallenge.base64URL(Data(repeating: 0, count: 32))
        XCTAssertEqual(encoded.count, 43)
        XCTAssertFalse(encoded.contains("="))
    }
}

final class DeepLinkTests: XCTestCase {
    func testAuthTicketFromReturnURI() throws {
        let url = try XCTUnwrap(URL(string: "rallywithai://auth/complete?ticket=abc123"))
        XCTAssertEqual(RallyDeepLink.authTicket(from: url), "abc123")
        XCTAssertNil(RallyDeepLink.authError(from: url))
    }

    func testAuthErrorFromReturnURI() throws {
        let url = try XCTUnwrap(URL(string: "rallywithai://auth/complete?error=access_denied"))
        XCTAssertEqual(RallyDeepLink.authError(from: url), "access_denied")
        XCTAssertNil(RallyDeepLink.authTicket(from: url))
    }

    func testWorkstreamUniversalLink() throws {
        let url = try XCTUnwrap(URL(string: "https://rallywith.ai/app/workspaces/ws_1/workstreams/wsr_9"))
        XCTAssertEqual(RallyDeepLink.workstreamId(from: url), "wsr_9")
        XCTAssertEqual(RallyDeepLink.workstreamTarget(from: url)?.substreamId, "0")
    }

    func testWorkstreamChildPath() throws {
        let url = try XCTUnwrap(URL(string: "https://rallywith.ai/app/workspaces/global/ws_1/workstreams/00000000-0000-4000-8000-000000000009/substreams/00000000-0000-4000-8000-00000000000a"))
        let target = try XCTUnwrap(RallyDeepLink.workstreamTarget(from: url))
        XCTAssertEqual(target.workstreamId, "00000000-0000-4000-8000-000000000009")
        XCTAssertEqual(target.substreamId, "00000000-0000-4000-8000-00000000000a")
    }

    func testWorkstreamQuerySubstream() throws {
        let url = try XCTUnwrap(URL(string: "https://rallywith.ai/app/workspaces/global/ws_1/workstreams/wsr_9?substream=child-1"))
        XCTAssertEqual(RallyDeepLink.workstreamTarget(from: url)?.substreamId, "child-1")
    }

    func testDesktopDeepLinkChild() throws {
        let url = try XCTUnwrap(URL(string: "rallywithai://workstreams/wsr_9/substreams/child-1"))
        let target = try XCTUnwrap(RallyDeepLink.workstreamTarget(from: url))
        XCTAssertEqual(target.workstreamId, "wsr_9")
        XCTAssertEqual(target.substreamId, "child-1")
    }

    func testCanonicalChildURL() throws {
        let url = try XCTUnwrap(RallyDeepLink.canonicalURL(
            region: .global,
            workspaceId: "ws_1",
            workstreamId: "wsr_9",
            substreamId: "child-1"
        ))
        XCTAssertEqual(url.absoluteString, "https://rallywith.ai/app/workspaces/global/ws_1/workstreams/wsr_9/substreams/child-1")
        let main = try XCTUnwrap(RallyDeepLink.canonicalURL(
            region: .eu,
            workspaceId: "ws_1",
            workstreamId: "wsr_9"
        ))
        XCTAssertEqual(main.absoluteString, "https://rallywith.ai/app/workspaces/eu/ws_1/workstreams/wsr_9")
    }

    func testIgnoresUnrelatedHTTPS() throws {
        let url = try XCTUnwrap(URL(string: "https://rallywith.ai/trust/privacy"))
        XCTAssertNil(RallyDeepLink.workstreamId(from: url))
        XCTAssertNil(RallyDeepLink.authTicket(from: url))
    }
}

final class ChatMappingTests: XCTestCase {
    func testMapsHumanAndAssistantText() throws {
        let json = """
        {
          "turnId": "t1",
          "actor": "human",
          "createdAtUtc": "2026-09-11T12:00:00.000Z",
          "clientMessageId": "c1",
          "blocks": [{ "type": "text", "text": "Hello Rally" }]
        }
        """.data(using: .utf8)!
        let turn = try JSONCoding.decoder.decode(TranscriptTurn.self, from: json)
        let mapped = try XCTUnwrap(ChatMapping.message(from: turn))
        XCTAssertEqual(mapped.role, .user)
        XCTAssertEqual(mapped.text, "Hello Rally")
        XCTAssertEqual(mapped.clientMessageId, "c1")
        XCTAssertFalse(mapped.isStreaming)
    }

    func testJoinsTextBlocksAndIgnoresThinkingWithoutText() throws {
        let json = """
        {
          "turnId": "t2",
          "actor": "assistant",
          "createdAtUtc": "2026-09-11T12:00:01Z",
          "blocks": [
            { "type": "thinking" },
            { "type": "text", "text": "Here is the plan.", "streaming": true }
          ]
        }
        """.data(using: .utf8)!
        let turn = try JSONCoding.decoder.decode(TranscriptTurn.self, from: json)
        let mapped = try XCTUnwrap(ChatMapping.message(from: turn))
        XCTAssertEqual(mapped.role, .assistant)
        XCTAssertEqual(mapped.text, "Here is the plan.")
        XCTAssertTrue(mapped.isStreaming)
    }
}

final class FeedProjectionTests: XCTestCase {
    func testProjectsEveryDesktopFeedKind() throws {
        let json = """
        [
          {
            "turnId": "human",
            "actor": "human",
            "transcriptSequence": 1,
            "createdAtUtc": "2026-09-11T12:00:00Z",
            "blocks": [{ "type": "text", "text": "Hello", "messageType": "text" }]
          },
          {
            "turnId": "think",
            "actor": "assistant",
            "transcriptSequence": 2,
            "createdAtUtc": "2026-09-11T12:00:01Z",
            "blocks": [
              { "type": "thinking", "streaming": false },
              { "type": "tool", "toolName": "search", "pluginId": "web", "status": "completed" },
              { "type": "text", "text": "Done." }
            ]
          },
          {
            "turnId": "ask",
            "actor": "assistant",
            "transcriptSequence": 3,
            "createdAtUtc": "2026-09-11T12:00:02Z",
            "blocks": [{
              "type": "text",
              "messageType": "elicitation",
              "structuredContent": {
                "id": "e1",
                "prompt": "Which one?",
                "responseType": "radio",
                "status": "open",
                "options": [{ "id": "a", "label": "Alpha", "value": "a" }]
              }
            }]
          },
          {
            "turnId": "sys",
            "actor": "system",
            "entryKind": "status",
            "statusKind": "assistant_turn_failed",
            "transcriptSequence": 4,
            "createdAtUtc": "2026-09-11T12:00:03Z",
            "blocks": []
          },
          {
            "turnId": "auto",
            "actor": "assistant",
            "transcriptSequence": 5,
            "createdAtUtc": "2026-09-11T12:00:04Z",
            "blocks": [{ "type": "text", "messageType": "automation_activation", "text": "Ran the digest" }]
          },
          {
            "turnId": "omit",
            "actor": "assistant",
            "transcriptSequence": 6,
            "createdAtUtc": "2026-09-11T12:00:05Z",
            "blocksOmitted": true,
            "blocks": []
          },
          {
            "turnId": "suggest",
            "actor": "assistant",
            "transcriptSequence": 7,
            "createdAtUtc": "2026-09-11T12:00:06Z",
            "blocks": [{ "type": "text", "messageType": "suggestion", "text": "hidden" }]
          }
        ]
        """.data(using: .utf8)!
        let turns = try JSONCoding.decoder.decode([TranscriptTurn].self, from: json)
        let rows = FeedProjection.rows(from: turns)
        let kinds = rows.map(\.kind)
        XCTAssertTrue(kinds.contains(.text))
        XCTAssertTrue(kinds.contains(.workAccordion))
        XCTAssertTrue(kinds.contains(.elicitation))
        XCTAssertTrue(kinds.contains(.system))
        XCTAssertTrue(kinds.contains(.automationActivation))
        XCTAssertTrue(kinds.contains(.omitted))
        XCTAssertFalse(rows.contains { $0.text == "hidden" })
        XCTAssertEqual(rows.first { $0.kind == .system }?.statusKind, "assistant_turn_failed")
        XCTAssertEqual(rows.first { $0.kind == .elicitation }?.elicitation?.options.count, 1)
        let accordion = try XCTUnwrap(rows.first { $0.kind == .workAccordion })
        XCTAssertEqual(accordion.nested.contains { $0.kind == .thought }, true)
        XCTAssertEqual(accordion.nested.contains { $0.kind == .pluginActivity }, true)
        XCTAssertEqual(rows.first { $0.kind == .text }?.turnId, "human")
    }

    func testBranchProvenanceTakesFiveTurnsThroughCutoff() throws {
        let messages = (1...8).map { index in
            RallyChatMessage(
                id: "m\(index)",
                role: index.isMultiple(of: 2) ? .assistant : .user,
                text: "t\(index)",
                createdAt: Date(),
                isStreaming: false,
                turnId: "turn-\(index)"
            )
        }
        let provenance = FeedProjection.branchProvenance(messages: messages, throughTurnId: "turn-6")
        XCTAssertEqual(provenance.map(\.turnId), ["turn-2", "turn-3", "turn-4", "turn-5", "turn-6"])
        XCTAssertEqual(FeedProjection.branchProvenance(messages: messages, throughTurnId: nil), [])
        XCTAssertEqual(FeedProjection.branchProvenance(messages: messages, throughTurnId: "missing"), [])
    }

    func testKeepsStreamingThoughtsOutOfAccordion() throws {
        let json = """
        [
          {
            "turnId": "t",
            "actor": "assistant",
            "transcriptSequence": 1,
            "createdAtUtc": "2026-09-11T12:00:00Z",
            "blocks": [
              { "type": "thinking", "streaming": true },
              { "type": "text", "text": "partial", "streaming": true }
            ]
          }
        ]
        """.data(using: .utf8)!
        let turns = try JSONCoding.decoder.decode([TranscriptTurn].self, from: json)
        let rows = FeedProjection.rows(from: turns)
        XCTAssertEqual(rows.map(\.kind), [.thought, .text])
    }
}

final class DirectoryDecodeTests: XCTestCase {
    func testMembersPageNestedUser() throws {
        let json = """
        { "items": [{ "role": "admin", "user": { "id": "u1", "name": "Ada", "email": "ada@juno-labs.com" } }] }
        """.data(using: .utf8)!
        struct Page: Decodable { var items: [RallyMember] }
        let page = try JSONCoding.decoder.decode(Page.self, from: json)
        XCTAssertEqual(page.items.first?.id, "u1")
        XCTAssertEqual(page.items.first?.name, "Ada")
        XCTAssertEqual(page.items.first?.role, "admin")
    }

    func testSearchResultsShape() throws {
        let json = """
        {
          "results": [{
            "id": "r1",
            "category": "messages",
            "title": "Ship iOS",
            "excerpt": "Hello Rally",
            "location": { "kind": "message", "workstreamId": "wsr_9", "substreamId": "child-1", "turnId": "t", "transcriptSequence": 1, "range": { "start": 0, "end": 1 } }
          }]
        }
        """.data(using: .utf8)!
        struct Response: Decodable { var results: [RallySearchHit] }
        let response = try JSONCoding.decoder.decode(Response.self, from: json)
        XCTAssertEqual(response.results.first?.kind, "messages")
        XCTAssertEqual(response.results.first?.snippet, "Hello Rally")
        XCTAssertEqual(response.results.first?.workstreamId, "wsr_9")
        XCTAssertEqual(response.results.first?.substreamId, "child-1")
    }
}

final class ConversationBootTests: XCTestCase {
    func testDecodesRestBoot() throws {
        let json = """
        {
          "id": "wsr_1",
          "title": "Ship iOS",
          "transcript": {
            "ranges": [{
              "turns": [{
                "turnId": "t1",
                "actor": "human",
                "createdAtUtc": "2026-09-11T12:00:00Z",
                "blocks": [{ "type": "text", "text": "Hi" }]
              }]
            }],
            "activeTurns": []
          }
        }
        """.data(using: .utf8)!
        let boot = try JSONCoding.decoder.decode(ConversationBoot.self, from: json)
        XCTAssertEqual(boot.id, "wsr_1")
        XCTAssertEqual(boot.title, "Ship iOS")
        XCTAssertEqual(boot.transcript?.ranges?.first?.turns?.count, 1)
    }

    func testDecodesNestedSocketSnapshot() throws {
        let json = """
        {
          "type": "snapshot",
          "workstream": { "id": "wsr_2", "title": "From socket" },
          "transcript": { "ranges": [], "activeTurns": [] }
        }
        """.data(using: .utf8)!
        let boot = try JSONCoding.decoder.decode(ConversationBoot.self, from: json)
        XCTAssertEqual(boot.id, "wsr_2")
        XCTAssertEqual(boot.title, "From socket")
    }
}

final class SubstreamDecodeTests: XCTestCase {
    func testDecodesPreparationPreview() throws {
        let json = """
        { "operationId": "op-1", "substreamId": "child-1", "title": "Branch" }
        """.data(using: .utf8)!
        let prepared = try JSONCoding.decoder.decode(SubstreamPreparationPreview.self, from: json)
        XCTAssertEqual(prepared.substreamId, "child-1")
        XCTAssertEqual(prepared.title, "Branch")
    }

    func testDecodesCreationResult() throws {
        let json = """
        {
          "substreamId": "child-1",
          "title": "Branch",
          "opening": {
            "turnId": "t1",
            "clientMessageId": "c1",
            "createdAt": "2026-09-12T12:00:00.000Z"
          }
        }
        """.data(using: .utf8)!
        let created = try JSONCoding.decoder.decode(SubstreamCreationResult.self, from: json)
        XCTAssertEqual(created.substreamId, "child-1")
        XCTAssertEqual(created.opening?.turnId, "t1")
    }

    func testDecodesControlMetadataChildren() throws {
        let json = """
        {
          "title": "Ship iOS",
          "scope": "personal",
          "privateChildren": [{
            "substreamId": "child-1",
            "title": "Investigate crash",
            "createdByUserId": "u1",
            "createdAt": "2026-09-12T12:00:00.000Z",
            "updatedAt": "2026-09-12T12:00:01.000Z"
          }]
        }
        """.data(using: .utf8)!
        let metadata = try JSONCoding.decoder.decode(RallyWorkstreamControlMetadata.self, from: json)
        XCTAssertEqual(metadata.title, "Ship iOS")
        XCTAssertEqual(metadata.privateChildren?.first?.substreamId, "child-1")
        XCTAssertEqual(metadata.privateChildren?.first?.title, "Investigate crash")
    }
}
