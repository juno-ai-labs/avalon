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
