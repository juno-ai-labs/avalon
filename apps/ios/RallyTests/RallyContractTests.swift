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
        let target = try XCTUnwrap(RallyDeepLink.workstreamTarget(from: url))
        XCTAssertEqual(target.workstreamId, "wsr_9")
        XCTAssertEqual(target.substreamId, "0")
        XCTAssertEqual(target.workspaceId, "ws_1")
        XCTAssertNil(target.region)
    }

    func testWorkstreamChildPath() throws {
        let url = try XCTUnwrap(URL(string: "https://rallywith.ai/app/workspaces/global/ws_1/workstreams/00000000-0000-4000-8000-000000000009/substreams/00000000-0000-4000-8000-00000000000a"))
        let target = try XCTUnwrap(RallyDeepLink.workstreamTarget(from: url))
        XCTAssertEqual(target.workstreamId, "00000000-0000-4000-8000-000000000009")
        XCTAssertEqual(target.substreamId, "00000000-0000-4000-8000-00000000000a")
        XCTAssertEqual(target.workspaceId, "ws_1")
        XCTAssertEqual(target.region, .global)
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
            workspaceId: "00000000-0000-7000-8000-000000000009",
            spaceId: "00000000-0000-7000-8000-0000000000a9",
            workstreamId: "019fec70-fba0-7b0e-9f7a-3dd1ef56520f",
            substreamId: "00000000-0000-7000-8000-000000000099"
        ))
        XCTAssertEqual(url.absoluteString, "https://rallywith.ai/app/global/1111117Hxt1fAWDjN7Te/s/1111117Hxt1fAWDjN7WQ/c/CduMrko5vpzwph2okTVLJ/b/1111117Hxt1fAWDjN7W8")
        let parsed = try XCTUnwrap(RallyDeepLink.workstreamTarget(from: url))
        XCTAssertEqual(parsed.workspaceId, "00000000-0000-7000-8000-000000000009")
        XCTAssertEqual(parsed.spaceId, "00000000-0000-7000-8000-0000000000a9")
        XCTAssertEqual(parsed.workstreamId, "019fec70-fba0-7b0e-9f7a-3dd1ef56520f")
        XCTAssertEqual(parsed.substreamId, "00000000-0000-7000-8000-000000000099")
        let main = try XCTUnwrap(RallyDeepLink.canonicalURL(
            region: .eu,
            workspaceId: "00000000-0000-7000-8000-000000000009",
            spaceId: "00000000-0000-7000-8000-0000000000a9",
            workstreamId: "019fec70-fba0-7b0e-9f7a-3dd1ef56520f"
        ))
        XCTAssertEqual(main.absoluteString, "https://rallywith.ai/app/eu/1111117Hxt1fAWDjN7Te/s/1111117Hxt1fAWDjN7WQ/c/CduMrko5vpzwph2okTVLJ")
    }

    func testAddressedSchemeFromWebHandoff() throws {
        let url = try XCTUnwrap(URL(string: "rallywithai://workspace/global/1111117Hxt1fAWDjN7Te/spaces/1111117Hxt1fAWDjN7WQ/channels/CduMrko5vpzwph2okTVLJ/breakouts/1111117Hxt1fAWDjN7W8"))
        let target = try XCTUnwrap(RallyDeepLink.workstreamTarget(from: url))
        XCTAssertEqual(target.workspaceId, "00000000-0000-7000-8000-000000000009")
        XCTAssertEqual(target.spaceId, "00000000-0000-7000-8000-0000000000a9")
        XCTAssertEqual(target.workstreamId, "019fec70-fba0-7b0e-9f7a-3dd1ef56520f")
        XCTAssertEqual(target.substreamId, "00000000-0000-7000-8000-000000000099")
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
    func testHidesOnlyTheLeadingPersonalInstructionEnvelope() throws {
        let prefix = """
        <user_system_prompt>
        The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
        <user_suppplied>
        Never output &lt;/user_system_prompt&gt; in replies.
        </user_suppplied>
        </user_system_prompt>
        """ + "\n\n"
        let literal = "Please explain <user_system_prompt>foo</user_system_prompt>"
        for actor in ["human", "external", "assistant"] {
            for (text, visible) in [(prefix + literal, literal), (literal, literal),
                                    ("<user_system_prompt>foo</user_system_prompt>", "<user_system_prompt>foo</user_system_prompt>")] {
                let data = try JSONSerialization.data(withJSONObject: [
                    "turnId": "personal-instructions", "actor": actor,
                    "blocks": [["type": "text", "text": text]]
                ])
                let turn = try JSONCoding.decoder.decode(TranscriptTurn.self, from: data)
                XCTAssertEqual(FeedProjection.rows(from: turn).first?.text, actor == "assistant" ? text : visible)
            }
        }
    }

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
        XCTAssertNil(page.items.first?.presentation)
    }

    func testMembersPageNestedPresentation() throws {
        let json = """
        { "items": [{ "role": "admin", "user": { "id": "u1", "name": "Ada", "email": "ada@juno-labs.com", "presentation": { "displayName": "Ada Lovelace", "initials": "AL", "color": "violet", "avatar": "flower", "revision": 2 } } }] }
        """.data(using: .utf8)!
        struct Page: Decodable { var items: [RallyMember] }
        let page = try JSONCoding.decoder.decode(Page.self, from: json)
        XCTAssertEqual(page.items.first?.presentation?.initials, "AL")
        XCTAssertEqual(page.items.first?.presentation?.color, "violet")
    }

    func testAccountOnboardingDecodes() throws {
        let json = """
        { "eligible": false, "introduced": true, "revision": 4, "presentation": { "displayName": "Alex Rivera", "initials": "AR", "color": "rose", "avatar": "circle", "revision": 4 } }
        """.data(using: .utf8)!
        let account = try JSONCoding.decoder.decode(RallyAccountOnboarding.self, from: json)
        XCTAssertEqual(account.presentation?.initials, "AR")
        XCTAssertEqual(account.presentation?.color, "rose")
        XCTAssertEqual(account.revision, 4)
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

    func testWorkstreamAppearanceDecodes() throws {
        let json = """
        {
          "id": "00000000-0000-7000-8000-000000000001",
          "title": "Ship iOS",
          "appearance": { "icon": "megaphone", "color": "blue" }
        }
        """.data(using: .utf8)!
        let stream = try JSONCoding.decoder.decode(RallyWorkstream.self, from: json)
        XCTAssertEqual(stream.appearance?.icon, "megaphone")
        XCTAssertEqual(stream.appearance?.color, "blue")
    }

    func testSidekickAppearanceDecodes() throws {
        let json = """
        {
          "id": "auto-1",
          "name": "Digest",
          "status": "active",
          "appearance": { "icon": "rocket", "color": "lime" }
        }
        """.data(using: .utf8)!
        let sidekick = try JSONCoding.decoder.decode(RallySidekick.self, from: json)
        XCTAssertEqual(sidekick.appearance?.icon, "rocket")
        XCTAssertEqual(sidekick.appearance?.color, "lime")
        XCTAssertEqual(sidekick.status, "active")
    }
}

final class PersonalAppearanceTests: XCTestCase {
    func testStoredInitialsBeatNameFallback() {
        XCTAssertEqual(
            RallyPersonalPresentation.initials(stored: "AJ", fallbackName: "Ada Lovelace"),
            "AJ"
        )
    }

    func testNameFallbackTakesTwoLetters() {
        XCTAssertEqual(
            RallyPersonalPresentation.initials(stored: nil, fallbackName: "Ada Lovelace"),
            "AL"
        )
        XCTAssertEqual(
            RallyPersonalPresentation.initials(stored: "  ", fallbackName: "Ada"),
            "A"
        )
    }

    func testPersonalColorAliasesAndDefault() {
        XCTAssertEqual(RallyPaletteKey.personal(from: "rose"), .rose)
        XCTAssertEqual(RallyPaletteKey.personal(from: "teal"), .emerald)
        XCTAssertEqual(RallyPaletteKey.personal(from: "green"), .emerald)
        XCTAssertEqual(RallyPaletteKey.personal(from: "amber"), .orange)
        XCTAssertEqual(RallyPaletteKey.personal(from: "slate"), .black)
        XCTAssertEqual(RallyPaletteKey.personal(from: nil), .blue)
        XCTAssertEqual(RallyPaletteKey.personal(from: "not-a-color"), .blue)
    }
}

final class WorkstreamDirectoryTests: XCTestCase {
    func testRecencyGroupsMatchElectronHeadings() {
        let now = localDate(2026, 8, 7, 10, 30)
        let streams: [RallyWorkstream] = [
            stream("month-old-running", at: localDate(2026, 8, 1, 12)),
            stream("today-failed", at: localDate(2026, 8, 7, 8)),
            stream("before-month", at: localDate(2026, 7, 31, 23, 59)),
            stream("hour-older", at: localDate(2026, 8, 7, 10)),
            stream("yesterday", at: localDate(2026, 8, 6, 12)),
            stream("week", at: localDate(2026, 8, 2, 12)),
            stream("hour-newer", at: localDate(2026, 8, 7, 10, 25)),
        ]
        let groups = RallyWorkstreamDirectory.recencyGroups(from: streams, now: now)
        XCTAssertEqual(groups.map(\.title), [
            "Last hour", "Today", "Yesterday", "This week", "This month", "Before this month",
        ])
        XCTAssertEqual(groups.flatMap(\.items).map(\.id), [
            "hour-newer", "hour-older", "today-failed", "yesterday", "week", "month-old-running", "before-month",
        ])
    }

    func testLastAccessedAtWinsOverSharedActivity() {
        var visited = RallyWorkstream(id: "visited", title: "Visited")
        visited.lastActivityAt = iso(localDate(2026, 1, 1))
        visited.lastAccessedAt = iso(localDate(2026, 8, 7, 10, 25))
        visited.lastAccessedAtOmitted = false
        var noisy = RallyWorkstream(id: "noisy", title: "Noisy")
        noisy.lastActivityAt = iso(localDate(2026, 8, 7, 10, 20))
        noisy.lastAccessedAtOmitted = true

        let groups = RallyWorkstreamDirectory.recencyGroups(
            from: [noisy, visited],
            now: localDate(2026, 8, 7, 10, 30)
        )
        XCTAssertEqual(groups.first?.items.map(\.id), ["visited", "noisy"])
    }

    func testExplicitNullAccessFallsBackToCreatedAt() throws {
        let json = """
        { "id": "u", "title": "Unvisited", "lastActivityAt": "2026-08-01T00:00:00Z", "createdAt": "2026-08-07T17:20:00Z", "lastAccessedAt": null }
        """.data(using: .utf8)!
        let item = try JSONCoding.decoder.decode(RallyWorkstream.self, from: json)
        XCTAssertFalse(item.lastAccessedAtOmitted)
        XCTAssertNil(item.lastAccessedAt)
        XCTAssertEqual(item.recencyRaw, "2026-08-07T17:20:00Z")
    }

    func testOmittedAccessFallsBackToLastActivity() throws {
        let json = """
        { "id": "old", "title": "Older server", "lastActivityAt": "2026-08-07T17:10:00Z", "createdAt": "2026-01-01T00:00:00Z" }
        """.data(using: .utf8)!
        let item = try JSONCoding.decoder.decode(RallyWorkstream.self, from: json)
        XCTAssertTrue(item.lastAccessedAtOmitted)
        XCTAssertEqual(item.recencyRaw, "2026-08-07T17:10:00Z")
    }

    private func stream(_ id: String, at date: Date) -> RallyWorkstream {
        var item = RallyWorkstream(id: id, title: id)
        item.lastActivityAt = iso(date)
        item.lastAccessedAtOmitted = true
        return item
    }

    private func localDate(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Date {
        Calendar.current.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    private func iso(_ date: Date) -> String {
        date.ISO8601Format()
    }
}

final class FeedChromeTests: XCTestCase {
    func testConnectingEmptyShowsSkeleton() {
        XCTAssertEqual(
            RallyFeedChrome.resolve(isLaunch: false, isConnecting: true, hasMessages: false),
            .skeleton
        )
    }

    func testLaunchBeatsSkeleton() {
        XCTAssertEqual(
            RallyFeedChrome.resolve(isLaunch: true, isConnecting: true, hasMessages: false),
            .launch
        )
    }

    func testMessagesBeatConnecting() {
        XCTAssertEqual(
            RallyFeedChrome.resolve(isLaunch: false, isConnecting: true, hasMessages: true),
            .messages
        )
    }

    func testSettledEmptyShowsGreeting() {
        XCTAssertEqual(
            RallyFeedChrome.resolve(isLaunch: false, isConnecting: false, hasMessages: false),
            .emptyGreeting
        )
    }

    func testSubstreamListShowsMainBeforeDirectoryArrives() {
        XCTAssertEqual(RallySubstreamListChrome.resolve(hasChildDirectory: false), .awaitingChildren)
        XCTAssertEqual(RallySubstreamListChrome.resolve(hasChildDirectory: true), .directory)
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
          "transcript": {
            "snapshotId": "snap-1",
            "eventSequence": 4,
            "ranges": [],
            "activeTurns": []
          }
        }
        """.data(using: .utf8)!
        let boot = try JSONCoding.decoder.decode(ConversationBoot.self, from: json)
        XCTAssertEqual(boot.id, "wsr_2")
        XCTAssertEqual(boot.title, "From socket")
        XCTAssertEqual(boot.transcript?.snapshotId, "snap-1")
        XCTAssertEqual(boot.transcript?.eventSequence, 4)
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
          "appearance": { "icon": "atom", "color": "purple" },
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
        XCTAssertEqual(metadata.appearance?.icon, "atom")
        XCTAssertEqual(metadata.appearance?.color, "purple")
        XCTAssertEqual(metadata.privateChildren?.first?.substreamId, "child-1")
        XCTAssertEqual(metadata.privateChildren?.first?.title, "Investigate crash")
    }

    func testControlFrameKeepsChildrenWhenAppearanceDoesNotDecode() {
        let json = """
        {
          "type": "workstream_metadata",
          "metadata": {
            "appearance": "not-an-object",
            "privateChildren": [{ "substreamId": "child-1", "title": "Investigate crash" }]
          }
        }
        """.data(using: .utf8)!
        let metadata = RallyWorkstreamControlMetadata.parseSocketFrame(json)
        XCTAssertEqual(metadata?.privateChildren?.first?.substreamId, "child-1")
        XCTAssertEqual(metadata?.privateChildren?.first?.title, "Investigate crash")
    }

    func testControlFrameIgnoresUnknownMetadataKeys() {
        let json = """
        {
          "type": "workstream_metadata",
          "metadata": {
            "title": "Ship iOS",
            "stateVersion": 1,
            "revision": 0,
            "privateChildren": []
          }
        }
        """.data(using: .utf8)!
        let metadata = RallyWorkstreamControlMetadata.parseSocketFrame(json)
        XCTAssertEqual(metadata?.title, "Ship iOS")
        XCTAssertEqual(metadata?.privateChildren, [])
    }
}

final class AppearanceTests: XCTestCase {
    func testDerivedAppearanceMatchesDesktopHash() {
        let first = RallyResolvedAppearance.derived(from: "00000000-0000-7000-8000-000000000001")
        XCTAssertEqual(first.color, .red)
        XCTAssertEqual(first.icon, "aperture")

        let named = RallyResolvedAppearance.derived(from: "launch-room")
        XCTAssertEqual(named.color, .lime)
        XCTAssertEqual(named.icon, "orbit")
    }

    func testStoredAppearanceWinsOverGenerated() {
        let resolved = RallyResolvedAppearance.resolve(
            id: "launch-room",
            saved: RallySavedAppearance(icon: "megaphone", color: "blue")
        )
        XCTAssertEqual(resolved.colorKey, .blue)
        XCTAssertEqual(resolved.iconKey, "megaphone")
        XCTAssertEqual(resolved.systemImage, "megaphone")
    }

    func testUnknownIconFallsBackToGenerated() {
        let generated = RallyResolvedAppearance.resolve(id: "launch-room", saved: nil)
        let unknown = RallyResolvedAppearance.resolve(
            id: "launch-room",
            saved: RallySavedAppearance(icon: "not-in-this-build", color: "blue")
        )
        XCTAssertEqual(unknown.iconKey, generated.iconKey)
        XCTAssertEqual(unknown.colorKey, .blue)
    }

    func testLimeTakesDarkInkAndRedTakesLightInk() {
        XCTAssertFalse(RallyPaletteKey.lime.usesLightInk)
        XCTAssertTrue(RallyPaletteKey.red.usesLightInk)
        XCTAssertTrue(RallyPaletteKey.black.usesLightInk)
    }
}

final class ConversationFeedFrameTests: XCTestCase {
    func testLiveTurnUsesTranscriptTurnUpserted() throws {
        let json = """
        {"type":"transcript_turn_upserted","turn":{"turnId":"t1","transcriptSequence":2,"actor":"assistant","createdAtUtc":"2026-09-15T12:00:00.000Z","blocks":[{"type":"text","text":"Hello"}]}}
        """.data(using: .utf8)!
        guard case .turnUpserted(let turn) = ConversationSocket.incoming(from: json) else {
            return XCTFail("expected transcript_turn_upserted")
        }
        XCTAssertEqual(turn.turnId, "t1")
    }

    func testRangeProtocolTurnUpsertedIsIgnored() {
        let json = Data(#"{"type":"turn_upserted","turn":{"turnId":"t1"}}"#.utf8)
        XCTAssertNil(ConversationSocket.incoming(from: json))
    }

    func testStreamFramesAccumulateAndComplete() throws {
        let started = Data(#"{"type":"stream_started","turnId":"t9","streamId":"s1","reset":false}"#.utf8)
        guard case .streamStarted(let turnId, let streamId, let reset) = ConversationSocket.incoming(from: started) else {
            return XCTFail("expected stream_started")
        }
        XCTAssertEqual(turnId, "t9")
        XCTAssertEqual(streamId, "s1")
        XCTAssertFalse(reset)

        let delta = Data(#"{"type":"stream_delta","turnId":"t9","streamId":"s1","delta":"Hi","reset":true}"#.utf8)
        guard case .streamDelta(_, _, let text, let deltaReset) = ConversationSocket.incoming(from: delta) else {
            return XCTFail("expected stream_delta")
        }
        XCTAssertEqual(text, "Hi")
        XCTAssertTrue(deltaReset)

        let completed = Data(#"{"type":"stream_completed","streamId":"s1"}"#.utf8)
        guard case .streamCompleted(let done) = ConversationSocket.incoming(from: completed) else {
            return XCTFail("expected stream_completed")
        }
        XCTAssertEqual(done, "s1")
    }
}

final class DigestDecodeTests: XCTestCase {
    func testPreservesSlackDeliveryTargets() throws {
        let json = """
        {"enabled":true,"days":[1],"times":[540],"timezone":"America/Los_Angeles","deliveryTargets":[{"type":"slack_agent_dm","connectionId":"conn_1"}]}
        """.data(using: .utf8)!
        let digest = try JSONCoding.decoder.decode(RallyDigest.self, from: json)
        XCTAssertEqual(digest.deliveryTargets?.first?.type, "slack_agent_dm")
        XCTAssertEqual(digest.deliveryTargets?.first?.connectionId, "conn_1")
    }
}

#if RALLY_DEBUG
final class DevelopmentSessionTests: XCTestCase {
    func testAcceptsMatchingLocalSessions() throws {
        let local = URL(string: "http://127.0.0.1:8787")!
        try AppModel.validateDevelopmentSessions(
            workspace: Self.session(email: "dev@avalon.local", workspace: true, api: "http://127.0.0.1:8787"),
            identity: Self.session(email: "dev@avalon.local", workspace: false, api: "http://127.0.0.1:8787"),
            expectedGlobalURL: local
        )
    }

    func testRejectsIdentityThatCarriesAWorkspace() {
        let local = URL(string: "http://127.0.0.1:8787")!
        XCTAssertThrowsError(
            try AppModel.validateDevelopmentSessions(
                workspace: Self.session(email: "dev@avalon.local", workspace: true, api: "http://127.0.0.1:8787"),
                identity: Self.session(email: "dev@avalon.local", workspace: true, api: "http://127.0.0.1:8787"),
                expectedGlobalURL: local
            )
        )
    }

    func testRejectsMismatchedAPIOrigin() {
        let local = URL(string: "http://127.0.0.1:8787")!
        XCTAssertThrowsError(
            try AppModel.validateDevelopmentSessions(
                workspace: Self.session(email: "dev@avalon.local", workspace: true, api: "https://api.rallywith.ai"),
                identity: Self.session(email: "dev@avalon.local", workspace: false, api: "http://127.0.0.1:8787"),
                expectedGlobalURL: local
            )
        )
    }

    private static func session(email: String, workspace: Bool, api: String) -> RallySession {
        RallySession(
            accessToken: "a",
            refreshToken: "r",
            expiresAt: "2026-09-13T00:00:00.000Z",
            user: RallyUser(id: "u1", email: email, name: "Adam", avatarUrl: nil, timezone: "America/Los_Angeles"),
            workspace: workspace
                ? RallyWorkspace(id: "ws1", name: "Rally Development", slug: "avalon-development", region: .global, role: "owner", timezone: "America/Los_Angeles")
                : nil,
            apiBaseUrl: api
        )
    }
}
#endif
