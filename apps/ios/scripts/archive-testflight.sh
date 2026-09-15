#!/usr/bin/env bash
# Archive Rally for TestFlight. Must run on macOS with Xcode 26 and the
# Juno Labs team (7ZLT6A8W25) available to the signed-in Apple ID.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DERIVED="${ROOT}/build/DerivedData"
ARCHIVE="${ROOT}/build/Rally.xcarchive"
EXPORT="${ROOT}/build/export"

mkdir -p "$ROOT/build"

xcodebuild \
  -project Rally.xcodeproj \
  -scheme Rally \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  archive

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist fastlane/ExportOptions.plist \
  -allowProvisioningUpdates

echo "IPA at ${EXPORT}/Rally.ipa"
echo "Upload with: xcrun altool --upload-app -f ${EXPORT}/Rally.ipa -t ios --apiKey \$APP_STORE_CONNECT_KEY_ID --apiIssuer \$APP_STORE_CONNECT_ISSUER_ID"
