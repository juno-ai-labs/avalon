import XCTest

final class LaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testIntroAndSignInChrome() throws {
        let app = XCUIApplication()
        app.launch()

        let next = app.buttons["Next intro screen"]
        if next.waitForExistence(timeout: 4) {
            next.tap()
            XCTAssertTrue(next.waitForExistence(timeout: 2))
            next.tap()
            let start = app.buttons["Get started"]
            XCTAssertTrue(start.waitForExistence(timeout: 2))
            start.tap()
        }

        let google = app.buttons["Continue with Google"]
        XCTAssertTrue(google.waitForExistence(timeout: 6), "Sign-in CTA must be visible after the intro")
        XCTAssertTrue(app.staticTexts["Rally"].exists)
        XCTAssertTrue(app.links["Privacy"].exists)
        XCTAssertTrue(app.links["Terms"].exists)
    }
}
