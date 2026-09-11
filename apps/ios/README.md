# Rally iOS

Native SwiftUI client for Rally. It is not Expo, React Native, or Flutter.
The product surface is a Grok Bot–style transcript plus the same directory the
Mac sidebar holds: Chats, Projects, Notes, and Sidekicks. Auth and the regional
API are the same contracts the desktop client uses (`rallywithai://auth/complete`
plus `/auth/desktop/exchange`). The App Store icon is the Electron Dark mark.

The owning document is [`docs/ios-client.md`](../../docs/ios-client.md).

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
- Connectors, automations, projects, and the desktop Settings window. This
  client is the conversation surface.
