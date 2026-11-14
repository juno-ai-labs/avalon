# App Store screenshots

How to capture Rally's native iOS screens and attach them to its App Store
listing. Use this for a new release or when navigation, branding, or the sample
canvases change. The app and release configuration are covered by
[mobile-canvas-client.md](mobile-canvas-client.md); release copy lives in
[the metadata folder](../apps/mobile/metadata/README.md).

## Prepare before starting a simulator

Use the existing Expo project, `@juno-ai-labs/rally-mobile`, and App Store Connect
app [6834593399](https://appstoreconnect.apple.com/apps/6834593399/distribution/ios/version/inflight).
Do not create another app record for screenshots.

1. Pick the release commit and a matching iOS Simulator build. Prefer the
   `simulator-release` EAS profile for final captures: it has no development menu
   and uses the production update channel. A physical-device IPA cannot run in
   the simulator. Check the installed build and loaded update before capturing;
   a production-channel update can change what a compatible build displays.
2. Prepare the account, organization, canvases, and shot list before paying for
   device time. Use the dedicated review organization or approved public-safe
   canvases in production Juno Labs. Production edits are real shared edits.
   Keep passwords and session credentials in secrets, never in this document,
   shell history, image filenames, or committed capture scripts.
3. Open each canvas and confirm its hosted artifact works. Use recognizable,
   realistic content: a grocery list, a plan, or a small shared tool. Avoid private
   chats, email addresses, customer information, and third-party editorial content.
4. Plan a short sequence: the finished artifact first, Home with useful canvases,
   then the sidebar or conversation if it helps explain the app. A populated
   grocery list should contain believable quantities, not placeholder text.

Capture the actual native app. Expo web previews, desktop browser screenshots,
and screenshots of the remote simulator's browser frame are not substitutes.

## Choose devices and output sizes

Recheck Apple's [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
before each release. The following were checked on **2026-11-14**. Apple accepts
PNG or JPEG, without alpha channels or transparency, and up to ten screenshots
per device size. Its current required-size summary calls for at least one medium
Dynamic Island iPhone screenshot and, because Rally supports iPad, one 13-inch
iPad screenshot.

| Capture | Native pixel dimensions used for Rally | Destination |
| --- | --- | --- |
| iPhone 17, portrait | 1206 × 2622 | Medium Dynamic Island iPhone screenshot set |
| 13-inch iPad, portrait | 2064 × 2752 | 13-inch iPad screenshot set |
| iPhone Duo, closed outer display | 1398 × 2034 | Duo profile, outer display |
| iPhone Duo, open inner display | 2853 × 2007 landscape, or 2007 × 2853 portrait | Duo profile, inner display |

These are pixel sizes, not React Native layout points. Apple lists other accepted
sizes too; use a matching simulator instead of stretching or upscaling a smaller
capture. Duo's inner display does not replace the iPad screenshot. Apple's current
page says Duo screenshots become required in April 2027 for apps using the
iOS 27.1 SDK or later; include both displays now when showing Duo support.

## Capture with Expo Simulators

Read the [Expo simulator setup guide](https://docs.expo.dev/eas/simulators/get-started/)
and, for agent-driven work, its [simulator skill](https://github.com/expo/skills/blob/main/plugins/expo/skills/eas-simulator/SKILL.md).
The repository's [remote simulator instructions](mobile-canvas-client.md#expo-simulators)
cover authentication, development clients, and Metro networking. Check current CLI
help before running a session; do not assume old device identifiers still exist.

From `apps/mobile`:

```sh
npx --yes eas-cli@latest whoami
npx --yes eas-cli@latest simulator:availability --json
npx --yes eas-cli@latest simulator:devices
npx --yes eas-cli@latest simulator:start --help
```

If a matching release simulator build is not already available, build it before
starting a paid session:

```sh
npx --yes eas-cli@latest build --platform ios --profile simulator-release --non-interactive
```

Set `SCREENSHOT_BUILD_ID` to that completed build's ID. For example, this creates
one short iPhone session; the duration settings are a capture budget, not a reason
to leave an unused device running:

```sh
npx --yes eas-cli@latest simulator:start \
  --platform ios --device 'iPhone 17' --type agent-device \
  --build-id "$SCREENSHOT_BUILD_ID" --name 'App Store screenshots' \
  --max-duration-minutes 15 --max-idle-time-minutes 3
```

Record the returned session ID privately. Wait for the session to be ready, then
use the controller through `simulator:exec`. It reads the local ignored
`.env.eas-simulator` connection file; keep the commands in the same app directory.
Attach to the running app before taking a snapshot. After signing in and preparing
the view as described below, capture the image:

```sh
npx --yes eas-cli@latest simulator:exec npx agent-device@latest open ai.rallywith.mobile --foreground --platform ios
npx --yes eas-cli@latest simulator:exec npx agent-device@latest snapshot --json
npx --yes eas-cli@latest simulator:exec npx agent-device@latest screenshot /tmp/rally-iphone-grocery.png --pixel-density 3 --scale 1 --json
```

The iPhone and Duo commands explicitly request 3× native pixels and disable
downscaling. For iPad, use its native density (2×), then check output dimensions.

Sign in through Rally's normal system sign-in sheet. Select the intended
organization, open the canvas, dismiss the keyboard, and wait for fonts, images,
and live data to finish loading. Use accessibility labels from a fresh snapshot
to navigate. Confirm the screenshot command succeeded and produced the expected
native dimensions; retrieve the output file if the controller reports a remote
artifact instead of a local path.

For final images, remove development overlays, touch indicators, error banners,
and permission sheets by resolving or dismissing them in the app before capture.
Use consistent appearance, orientation, and status-bar presentation across a set.
Do not paint over broken controls or invent UI in an image editor.

### Capture Duo closed and open

Start a separate session using the Duo device name returned by `simulator:devices`
and a compatible SDK 58 build. Keep Rally running between poses:

```sh
npx --yes eas-cli@latest simulator:exec npx agent-device@latest fold closed --json
npx --yes eas-cli@latest simulator:exec npx agent-device@latest screenshot /tmp/rally-duo-outer-grocery.png --pixel-density 3 --scale 1 --json
npx --yes eas-cli@latest simulator:exec npx agent-device@latest fold open --json
npx --yes eas-cli@latest simulator:exec npx agent-device@latest snapshot --json
npx --yes eas-cli@latest simulator:exec npx agent-device@latest screenshot /tmp/rally-duo-inner-grocery.png --pixel-density 3 --scale 1 --json
```

Wait for each layout to settle before its screenshot. Element references and
coordinates from the closed pose are stale after opening; take a fresh snapshot
before interacting. Confirm that the same canvas stays open, its content reflows,
and the native navigation and conversation input remain accessible. Capture the
inner display at its actual orientation; do not rotate a narrow screenshot to
simulate the expanded layout. A static screenshot does not prove the transition:
inspect the running app during opening and closing too.

### Finish the session

Download and inspect the images, sign out, and stop each session explicitly:

```sh
npx --yes eas-cli@latest simulator:stop --id "$SCREENSHOT_SESSION_ID" --json
```

Confirm the session is stopped. Stop Metro too if a development client was used.
Closing the preview tab is not stopping the simulator. Never leave one running
while preparing copy, editing images, or waiting for Apple upload processing.

## Alternative: local Xcode Simulator

On a Mac with a compatible Xcode runtime, install the matching simulator build,
sign in, and prepare the same views. Capture with Simulator's **File → Save
Screen**, or use the selected simulator's UDID:

```sh
xcrun simctl io "$SCREENSHOT_UDID" screenshot /tmp/rally-iphone-grocery.png
```

Use the simulator's native screenshot output, not a macOS window capture. The
same size, content, Duo-pose, and visual checks apply.

## Inspect and save the approved files

Open every image at full size. Check text legibility, complete icons, correct
canvas colors, safe areas, and that the tab bar does not cover content. Reject
loading placeholders, clipped headings, stale data, and accidental private text.

Inspect pixel dimensions and alpha with an image inspector. On a Mac,
`sips -g pixelWidth -g pixelHeight -g hasAlpha /tmp/rally-iphone-grocery.png`
reports them. If a capture has an alpha channel, export an opaque RGB copy at the
same dimensions and inspect it again; do not change the UI or resize it.

Store approved public images under
`apps/mobile/metadata/screenshots/en-US/`, grouped by display, with numbered
names such as `iphone/01-grocery-list.png`, `ipad/01-grocery-list.png`,
`duo-outer/01-grocery-list.png`, and `duo-inner/01-grocery-list.png`. The iPhone and
iPad directories already exist; add Duo directories when checking in new files.
Keep raw captures, recordings, session output, and credentials outside Git.
Record the commit, build ID, loaded update, device/runtime, locale, and capture
date with the release's evidence so the images can be reproduced.

## Upload to App Store Connect

EAS Submit uploads the app binary. EAS Metadata manages the listing text in
`apps/mobile/store.config.json`; it does **not** capture or upload these images.
Screenshots belong to the selected App Store version and localization.

In App Store Connect, open Rally, select the editable iOS version and English
(US), then upload the approved iPhone and iPad files to their matching screenshot
sets. Use the media manager to inspect each device size, order the images, and
confirm processing completed. For Duo, attach the outer and inner images to its
profile using the asset library placement controls. Review the resulting preview,
not just the upload progress indicator.

For an API-driven upload, use the documented
[App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi)
with an authorized team API key supplied through secrets. The flow previously
used for Rally was:

1. Resolve app `6834593399`, the intended editable iOS version, and its `en-US`
   localization. Do not blindly select the first version returned.
2. For ordinary screenshots, find or create an `appScreenshotSet` for that
   localization and display type, then create `appScreenshots` upload reservations.
   Rally's existing sets use `APP_IPHONE_61` and `APP_IPAD_PRO_3GEN_129`.
3. Upload the exact byte ranges to the reservation's upload URLs with its supplied
   methods and headers. Commit the upload according to the resource's current
   API contract, then poll its delivery state and inspect errors.
4. Duo images use `appAssetLibraryImages` in category
   `APP_SCREENSHOTS_AND_PREVIEWS`. After upload, attach each image to the version
   localization with an `appAssetLibraryPlacement` of type `APP_SCREENSHOT` and
   group `IPHONE_DUO_PROFILE`. Verify both image dimensions and an active placement;
   a library upload alone is not a listing placement.
5. Read the records back and verify the version, locale, display, order, and
   processed image. Preserve existing assets until replacements are verified.

Those identifiers describe the successful November 2026 upload; recheck Apple's
current resource schemas before scripting another one. There is no checked-in
screenshot uploader. Do not depend on temporary workspace scripts or private
EAS CLI internals as a release interface.

TestFlight does not require screenshots. Its public invitation can use screenshots
from an approved App Store version; uploading files to an editable version does
not itself publish the listing or make screenshots appear on a first-beta invite.
