# Rally iOS

Native SwiftUI client for Rally. It is not Expo, React Native, or Flutter.
The product surface is a Grok Bot–style work-stream list, then substreams, then
the transcript, plus Sidekicks. Projects and Notes stay on the Mac. Auth and the
regional
API are the same contracts the desktop client uses (`rallywithai://auth/complete`
plus `/auth/desktop/exchange`). The App Store icon is the Electron Dark mark.
In-app chrome uses the shared Rally loop, not the retired four-pointed spark.

The owning document is [`docs/ios-client.md`](../../docs/ios-client.md).
Apple push registration is the same Worker registry as the Mac
([`docs/push-notifications.md`](../../docs/push-notifications.md)).

## Requirements

- macOS with **Xcode 26** (iOS 26 SDK)
- Apple team **7ZLT6A8W25** (Juno AI Labs Inc)
- Automatic signing. Bundle ID `ai.rallywith.ios`

This Linux sandbox cannot compile or archive the app. Open
`apps/ios/Rally.xcodeproj` on a Mac.

## Run

```bash
open apps/ios/Rally.xcodeproj
```

Scheme **Rally**, destination an iPhone simulator or device. Debug uses
`Rally/RallyDebug.entitlements` (development APNs). Release uses production
APNs.

Override the Global API with the scheme environment variable
`RALLY_API_GLOBAL_URL`, or in a Debug build from Settings → Developer.
`Info.plist` allows local HTTP (`NSAllowsLocalNetworking`) so a Debug build
can talk to `http://127.0.0.1:8787`. The scheme still points at production;
for a local Worker, set that URL (or the UserDefaults key `rally.api.global`)
and use **Use local development account** on the sign-in screen — Google
OAuth cannot complete against wrangler.

## TestFlight

1. In Xcode, select the Rally target → Signing & Capabilities. Confirm Team
   `7ZLT6A8W25` and Automatic signing. Create the App ID `ai.rallywith.ios` in
   the developer portal if it does not exist, with Push Notifications and
   Associated Domains.
2. In App Store Connect, create the iOS app Rally, bundle ID `ai.rallywith.ios`,
   SKU `rally-ios`. Privacy policy `https://rallywith.ai/trust/privacy`.
3. Archive:

   ```bash
   cd apps/ios
   ./scripts/archive-testflight.sh
   ```

   or `fastlane beta` from `apps/ios` after installing Fastlane. Marketing
   version is `1.0.0`, build `1` (`Config/Shared.xcconfig`).
4. Upload the IPA to App Store Connect (Transporter, Organizer, or
   `upload_to_testflight`). Submit to TestFlight internal testing.

`ITSAppUsesNonExemptEncryption` is `false`. The privacy manifest is
`Rally/PrivacyInfo.xcprivacy`. The 1024×1024 App Store icon is
`Rally/Assets.xcassets/AppIcon.appiconset/AppIcon.png`.

## What this client does not do yet

- Push delivery: the token is stored on-device; the Worker iOS APNs topic is
  still a PRD, not a shipped route.
- Member-facing account erasure: Settings leaves the workspace, signs out, and
  points at the privacy URL. Operator erasure is out of band.
- Projects, Notes (Control Tower capture), connectors, workspace search, starting
  a new work stream or Sidekick, and the desktop Settings window. This client
  is the conversation surface.
