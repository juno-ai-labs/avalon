import XCTest

final class LaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        addUIInterruptionMonitor(withDescription: "System permission alerts") { alert in
            if alert.buttons["Allow"].exists {
                alert.buttons["Allow"].tap()
                return true
            }
            if alert.buttons["Don’t Allow"].exists {
                alert.buttons["Don’t Allow"].tap()
                return true
            }
            return false
        }
    }

    private func dismissIntro(in app: XCUIApplication) {
        app.tap() // delivers pending interruption monitors
        let next = app.buttons["Next intro screen"]
        if next.waitForExistence(timeout: 6) {
            next.tap()
            XCTAssertTrue(next.waitForExistence(timeout: 2))
            next.tap()
            let start = app.buttons["Get started"]
            XCTAssertTrue(start.waitForExistence(timeout: 2))
            start.tap()
        }
    }

    func testIntroAndSignInChrome() throws {
        let app = XCUIApplication()
        app.launch()
        if app.tabBars.buttons["Work streams"].waitForExistence(timeout: 3) {
            return // already signed in from a prior local session
        }
        dismissIntro(in: app)

        let google = app.buttons["Continue with Google"]
        let local = app.buttons["Use local development account"]
        XCTAssertTrue(
            google.waitForExistence(timeout: 6) || local.waitForExistence(timeout: 2),
            "Sign-in CTA must be visible after the intro"
        )
        if google.exists {
            XCTAssertTrue(app.staticTexts["Rally"].exists)
            XCTAssertTrue(app.links["Privacy"].exists)
            XCTAssertTrue(app.links["Terms"].exists)
        }
    }

    /// Skipped unless `RALLY_LOCAL_UI=1` and a local Worker is listening. CI never sets that.
    func testLocalDevelopmentAccountReachesChats() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["RALLY_LOCAL_UI"] == "1",
            "Needs a running `pnpm dev:api:local` Worker"
        )
        let app = XCUIApplication()
        app.launchEnvironment["RALLY_API_GLOBAL_URL"] = ProcessInfo.processInfo.environment["RALLY_API_GLOBAL_URL"]
            ?? "http://127.0.0.1:8787"
        app.launch()
        dismissIntro(in: app)

        if app.buttons["Use local development account"].waitForExistence(timeout: 4) {
            app.buttons["Use local development account"].tap()
        }

        let workStreams = app.tabBars.buttons["Work streams"]
        XCTAssertTrue(workStreams.waitForExistence(timeout: 20), "Local session should land in the tab shell")
        XCTAssertTrue(app.tabBars.buttons["Sidekicks"].exists)
        XCTAssertFalse(app.tabBars.buttons["Projects"].exists)
        XCTAssertFalse(app.tabBars.buttons["Notes"].exists)
        XCTAssertTrue(app.buttons["Workspace and settings"].waitForExistence(timeout: 6))
        XCTAssertFalse(app.buttons["History"].exists)
        XCTAssertFalse(app.buttons["New chat"].exists)
        XCTAssertFalse(app.searchFields["Search"].exists)

        let firstStream = app.tables.cells.firstMatch
        if firstStream.waitForExistence(timeout: 4) {
            firstStream.tap()
            XCTAssertTrue(
                app.navigationBars.firstMatch.waitForExistence(timeout: 6),
                "Selecting a work stream should push the substream list"
            )
            let main = app.descendants(matching: .any)["Main"]
            if main.waitForExistence(timeout: 4) {
                main.tap()
                XCTAssertTrue(app.buttons["Details"].waitForExistence(timeout: 6))
            }
        }

        app.tabBars.buttons["Sidekicks"].tap()
        XCTAssertFalse(app.buttons["New Sidekick"].exists)
        app.tabBars.buttons["Work streams"].tap()
        XCTAssertTrue(app.buttons["Workspace and settings"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["New chat"].exists)
    }
}
