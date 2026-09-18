import XCTest
@testable import Rally

final class RallyPushTests: XCTestCase {
    func testParsesMentionPayloadURL() throws {
        let url = "https://rallywith.ai/app/workspaces/global/ws_1/workstreams/wsr_9/substreams/child-1"
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Mention", "body": "Hello"]],
            "rally": [
                "v": NSNumber(value: 1),
                "kind": "mention",
                "url": url,
                "workspaceId": "ws_1",
                "region": "global",
            ],
        ]
        let parsed = try XCTUnwrap(RallyPush.workstreamURL(from: userInfo))
        XCTAssertEqual(parsed.absoluteString, url)
        XCTAssertEqual(RallyDeepLink.workstreamTarget(from: parsed)?.substreamId, "child-1")
    }

    func testRejectsUnknownKindAndNonHttps() {
        XCTAssertNil(RallyPush.workstreamURL(from: [
            "rally": [
                "v": 1,
                "kind": "digest",
                "url": "https://rallywith.ai/app/workspaces/global/ws_1/workstreams/wsr_9",
                "workspaceId": "ws_1",
                "region": "global",
            ],
        ]))
        XCTAssertNil(RallyPush.workstreamURL(from: [
            "rally": [
                "v": 1,
                "kind": "mention",
                "url": "rallywithai://workstreams/wsr_9",
                "workspaceId": "ws_1",
                "region": "global",
            ],
        ]))
    }

    func testRegistrationBodyMatchesWorkerContract() throws {
        let body = RallyPushDeviceRegistration(
            platform: RallyPush.platform,
            transport: RallyPush.transport,
            topic: RallyPush.topic,
            apnsEnvironment: "sandbox",
            token: String(repeating: "ab", count: 32),
            appVersion: "1.0.0"
        )
        let data = try JSONCoding.encoder.encode(body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["platform"] as? String, "ios")
        XCTAssertEqual(json["transport"] as? String, "apns")
        XCTAssertEqual(json["topic"] as? String, "ai.rallywith.ios")
        XCTAssertEqual(json["apnsEnvironment"] as? String, "sandbox")
        XCTAssertEqual(RallyPush.topic, APIConfiguration.bundleIdentifier)
        XCTAssertEqual(RallyPush.hexDeviceToken(Data([0x0A, 0xFF])), "0aff")
    }
}
