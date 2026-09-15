import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const iosRoot = join(repoRoot, "apps/ios");

function walkFiles(directory, acc = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "DerivedData" || entry.name === "build" || entry.name === "xcuserdata") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path, acc);
    } else {
      acc.push(path);
    }
  }
  return acc;
}

function read(relative) {
  return readFileSync(join(iosRoot, relative), "utf8");
}

test("apps/ios is a native Xcode project, not a cross-platform shell", () => {
  assert.equal(existsSync(join(iosRoot, "package.json")), false, "a package.json would be picked up by pnpm apps/*");
  assert.equal(existsSync(join(iosRoot, "Podfile")), false);
  assert.equal(existsSync(join(iosRoot, "pubspec.yaml")), false);
  assert.equal(existsSync(join(iosRoot, "app.json")), false);
  assert.equal(existsSync(join(iosRoot, "metro.config.js")), false);

  const files = walkFiles(iosRoot);
  const forbidden = files.filter((path) => {
    const name = path.toLowerCase();
    return (
      name.endsWith("package.json") ||
      name.includes("node_modules") ||
      name.includes("react-native") ||
      name.includes("/expo/") ||
      name.endsWith("pubspec.yaml")
    );
  });
  assert.deepEqual(forbidden, []);

  const sources = files.filter((path) => path.endsWith(".swift")).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /expo|react-native|Flutter|Capacitor/i);
});

test("TestFlight identity is pinned in xcconfig and entitlements", () => {
  const shared = read("Config/Shared.xcconfig");
  assert.match(shared, /PRODUCT_BUNDLE_IDENTIFIER = ai\.rallywith\.ios/);
  assert.match(shared, /DEVELOPMENT_TEAM = 7ZLT6A8W25/);
  assert.match(shared, /MARKETING_VERSION = 1\.0\.0/);
  assert.match(shared, /CURRENT_PROJECT_VERSION = 1/);
  assert.match(shared, /IPHONEOS_DEPLOYMENT_TARGET = 26\.0/);
  assert.match(shared, /SWIFT_VERSION = 6\.0/);

  const releaseEntitlements = read("Rally/Rally.entitlements");
  assert.match(releaseEntitlements, /<string>production<\/string>/);
  assert.match(releaseEntitlements, /applinks:rallywith\.ai/);
  assert.match(releaseEntitlements, /applinks:www\.rallywith\.ai/);

  const debugEntitlements = read("Rally/RallyDebug.entitlements");
  assert.match(debugEntitlements, /<string>development<\/string>/);

  const info = read("Rally/Info.plist");
  assert.match(info, /<string>rallywithai<\/string>/);
  assert.match(info, /ITSAppUsesNonExemptEncryption/);
  assert.match(info, /NSAllowsLocalNetworking/);
});

test("privacy manifest and 1024 App Store icon are present", () => {
  const privacy = read("Rally/PrivacyInfo.xcprivacy");
  assert.match(privacy, /NSPrivacyTracking/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeEmailAddress/);

  const iconPath = join(iosRoot, "Rally/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
  assert.equal(existsSync(iconPath), true);
  const icon = readFileSync(iconPath);
  assert.equal(icon[0], 0x89);
  assert.equal(icon.toString("ascii", 1, 4), "PNG");
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
  assert.notEqual(icon[25], 6, "App Store icons cannot carry an alpha channel");
  assert.ok(statSync(iconPath).size > 10_000);

  const markPath = join(iosRoot, "Rally/Assets.xcassets/RallyMark.imageset/RallyMark.png");
  assert.equal(existsSync(markPath), true, "in-app Rally mark is the shared loop PNG");
  const mark = readFileSync(markPath);
  assert.equal(mark[0], 0x89);
  assert.equal(mark.toString("ascii", 1, 4), "PNG");
  const markContents = read("Rally/Assets.xcassets/RallyMark.imageset/Contents.json");
  assert.match(markContents, /template-rendering-intent/);
  const canonicalMark = join(repoRoot, "assets/brand/rally-mark.png");
  assert.equal(existsSync(canonicalMark), true);
  assert.deepEqual(mark, readFileSync(canonicalMark));

  const darkDesktop = join(repoRoot, "apps/desktop/resources/app-icons/dark.png");
  assert.equal(existsSync(darkDesktop), true, "iOS App Icon is the Electron dark selectable icon");
});

test("required Swift surfaces exist for a complete conversation client", () => {
  const required = [
    "Rally/RallyApp.swift",
    "Rally/App/AppModel.swift",
    "Rally/App/RallyDeepLink.swift",
    "Rally/App/RallyAppDelegate.swift",
    "Rally/App/RallyPush.swift",
    "Rally/Auth/PKCE.swift",
    "Rally/Auth/KeychainStore.swift",
    "Rally/Network/RallyClient.swift",
    "Rally/Network/ConversationSocket.swift",
    "Rally/Features/Onboarding/SignInView.swift",
    "Rally/Features/Workspaces/WorkspacePickerView.swift",
    "Rally/Features/Chat/ConversationScreen.swift",
    "Rally/Features/Chat/ComposerBar.swift",
    "Rally/Features/Chat/SubstreamSwitcher.swift",
    "Rally/Features/History/HistoryPanel.swift",
    "Rally/Features/History/WorkstreamDirectory.swift",
    "Rally/Features/Settings/SettingsScreen.swift",
    "Rally/Features/Voice/VoiceBar.swift",
    "Rally/Features/Chat/FeedProjection.swift",
    "Rally/Network/WorkspaceSocket.swift",
    "Rally/Network/WorkstreamControlSocket.swift",
    "Rally/Network/RallySocketPolicy.swift",
    "Rally/Network/RallySocketPool.swift",
    "Rally/Network/RallyPagedDirectory.swift",
    "Rally/Network/RallyTicketedSocket.swift",
    "Rally/Design/RallyInfiniteScroll.swift",
    "Rally/App/MainShell.swift",
    "Rally/Features/Sidekicks/SidekicksScreen.swift",
    "Rally/Features/Workspace/DirectorySheets.swift",
    "Rally/Design/RallyAppearance.swift",
    "RallyTests/RallyContractTests.swift",
    "RallyTests/RallyPushTests.swift",
    "RallyTests/RallySocketPolicyTests.swift",
    "RallyTests/RallyPagedDirectoryTests.swift",
    "RallyTests/RallyTicketedSocketTests.swift",
    "RallyUITests/LaunchUITests.swift",
    "Config/Tests.xcconfig",
    "Config/TestsRelease.xcconfig",
    "fastlane/ExportOptions.plist",
    "scripts/archive-testflight.sh",
    "README.md",
  ];
  for (const relative of required) {
    assert.equal(existsSync(join(iosRoot, relative)), true, relative);
  }

  const pkce = read("Rally/Auth/PKCE.swift");
  assert.match(pkce, /random\(32\)/);
  assert.match(pkce, /random\(48\)/);

  const model = read("Rally/App/AppModel.swift");
  assert.doesNotMatch(model, /openingMessage: text\.isEmpty \? " " : text/);
  assert.match(model, /openingMessage: text/);
});

test("iOS feed kinds and shell cover the Electron conversation and directory", () => {
  const conversation = read("Rally/Features/Chat/ConversationScreen.swift");
  for (const kind of [
    "text",
    "thought",
    "toolEvent",
    "pluginActivity",
    "workAccordion",
    "elicitation",
    "system",
    "automationActivation",
    "omitted",
  ]) {
    assert.match(conversation, new RegExp(`case \\.${kind}`), kind);
  }
  const feed = read("Rally/Features/Chat/FeedProjection.swift");
  assert.match(feed, /messageType == "suggestion"/);
  assert.match(feed, /kind: \.workAccordion/);
  assert.match(feed, /\.pluginActivity/);
  const shell = read("Rally/App/MainShell.swift");
  assert.match(shell, /ConversationScreen/);
  assert.match(shell, /SidekicksScreen/);
  assert.match(shell, /tabBarMinimizeBehavior/);
  assert.match(shell, /hexagon\.fill/);
  assert.match(shell, /Tab\("Work streams"/);
  assert.doesNotMatch(shell, /Tab\("Chats"/);
  assert.doesNotMatch(shell, /sparkles/);
  assert.doesNotMatch(shell, /ProjectsScreen/);
  assert.doesNotMatch(shell, /NotesScreen/);
  const history = read("Rally/Features/History/HistoryPanel.swift");
  assert.match(history, /WorkstreamListScreen/);
  assert.match(history, /Pin/);
  assert.match(history, /Archive/);
  assert.match(history, /Unread/);
  assert.match(history, /Rename/);
  assert.doesNotMatch(history, /searchable/);
  assert.doesNotMatch(history, /New chat/);
  assert.match(history, /navigationTitle\("Work streams"\)/);
  assert.doesNotMatch(history, /navigationTitle\("Chats"\)/);
  assert.match(history, /WorkstreamGlyph/);
  assert.match(history, /AccountAvatar/);
  assert.match(history, /RallyWorkstreamDirectory/);
  assert.match(history, /Section\(section\.title\)/);
  assert.doesNotMatch(history, /WorkstreamAvatar/);
  assert.doesNotMatch(history, /name\.prefix\(1\)/);
  const directory = read("Rally/Features/History/WorkstreamDirectory.swift");
  assert.match(directory, /recency-groups\.ts/);
  assert.match(directory, /Last hour/);
  assert.match(read("Rally/Models/Models.swift"), /lastAccessedAt/);
  const sidekicksScreen = read("Rally/Features/Sidekicks/SidekicksScreen.swift");
  assert.doesNotMatch(sidekicksScreen, /New Sidekick/);
  assert.match(sidekicksScreen, /SidekickGlyph/);
  const appearance = read("Rally/Design/RallyAppearance.swift");
  assert.match(appearance, /2_166_136_261/);
  assert.match(appearance, /SidekickHexagon/);
  assert.match(appearance, /smallcircle\.filled\.circle/);
  assert.match(appearance, /struct AccountAvatar/);
  assert.match(appearance, /clipShape\(Circle\(\)\)/);
  assert.match(appearance, /personalAliases/);
  assert.match(read("Rally/Network/RallyClient.swift"), /\/onboarding\/account/);
  assert.match(read("Rally/App/AppModel.swift"), /fetchAccountOnboarding/);
  const settings = read("Rally/Features/Settings/SettingsScreen.swift");
  assert.match(settings, /Digest/);
  assert.match(settings, /Connections/);
  const signIn = read("Rally/Features/Onboarding/SignInView.swift");
  assert.match(signIn, /Use local development account/);
  assert.match(read("Rally/Network/RallyClient.swift"), /\/auth\/dev\/session/);
  assert.match(read("Rally/App/AppModel.swift"), /startLocalDevelopmentSession/);
  assert.match(read("RallyUITests/LaunchUITests.swift"), /RALLY_LOCAL_UI/);
  assert.match(read("RallyUITests/LaunchUITests.swift"), /tabBars\.buttons\["Work streams"\]/);
  assert.doesNotMatch(read("RallyUITests/LaunchUITests.swift"), /tabBars\.buttons\["Chats"\]/);
  const substreams = read("Rally/Features/Chat/SubstreamSwitcher.swift");
  assert.match(substreams, /New substream/);
  assert.doesNotMatch(substreams, /ToolbarItem/);
  assert.match(substreams, /Copy substream link/);
  assert.match(substreams, /Archive substream/);
  assert.match(substreams, /Start a substream/);
  const model = read("Rally/App/AppModel.swift");
  assert.match(model, /prepareSubstream/);
  assert.match(model, /confirmSubstream/);
  assert.match(model, /startSubstream/);
  assert.match(model, /chatPath/);
  assert.match(model, /revealSubstreams/);
  assert.match(conversation, /safeAreaBar/);
  assert.match(conversation, /ConversationSkeleton/);
  assert.doesNotMatch(conversation, /GeometryReader/);
  assert.doesNotMatch(conversation, /navigationTransition/);
  assert.doesNotMatch(conversation, /rallyZoom/);
  assert.match(model, /disablesAnimations = true/);
  assert.match(conversation, /RallyFeedChrome/);
  assert.match(feed, /enum RallyFeedChrome/);
  assert.doesNotMatch(substreams, /SubstreamListSkeletonRows/);
  assert.match(substreams, /Loading substreams/);
  assert.match(substreams, /RallySubstreamListChrome/);
  assert.match(feed, /enum RallySubstreamListChrome/);
  assert.match(feed, /awaitingChildren/);
  const control = read("Rally/Network/WorkstreamControlSocket.swift");
  assert.match(control, /RallyTicketedSocket/);
  assert.doesNotMatch(control, /URLSessionWebSocketTask/);
  const ticketed = read("Rally/Network/RallyTicketedSocket.swift");
  assert.match(ticketed, /didOpenWithProtocol/);
  assert.match(ticketed, /func isBusy/);
  assert.match(ticketed, /socketOrigin/);
  assert.match(read("Rally/Network/APIConfiguration.swift"), /app:\/\/rallywithai/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /RallyTicketedSocket/);
  assert.doesNotMatch(read("Rally/Network/ConversationSocket.swift"), /URLSessionWebSocketTask/);
  assert.match(read("Rally/Network/WorkspaceSocket.swift"), /RallyTicketedSocket/);
  assert.doesNotMatch(read("Rally/Network/WorkspaceSocket.swift"), /URLSessionWebSocketTask/);
  assert.doesNotMatch(model, /getConversation/);
  assert.doesNotMatch(model, /listSidekicks/);
  assert.doesNotMatch(model, /client\.listWorkstreams/);
  assert.match(read("Rally/Models/Models.swift"), /parseSocketFrame/);
  assert.match(read("RallyTests/RallyContractTests.swift"), /testControlFrameKeepsChildrenWhenAppearanceDoesNotDecode/);
  assert.match(model, /beginFeed/);
  assert.match(
    model,
    /beginFeed\(workstreamId: parent.id, substreamId: substreamId\)\s+showConversationRoute/,
  );
  assert.match(read("Rally/Design/RallyGlass.swift"), /glassEffect/);
  const theme = read("Rally/Design/RallyTheme.swift");
  assert.match(theme, /struct RallyMark: View/);
  assert.match(theme, /Image\("RallyMark"\)/);
  assert.doesNotMatch(theme, /struct RallyMark: Shape/);
  const client = read("Rally/Network/RallyClient.swift");
  assert.match(client, /substreams\/prepare/);
  assert.match(client, /control-socket/);
  assert.doesNotMatch(client, /get\(path: "\/workspace"/);
  assert.doesNotMatch(client, /\/workstreams\?limit/);
  assert.doesNotMatch(client, /\/conversations\/\\\$\(id\)"/);
  assert.doesNotMatch(client, /get\(path: "\/sidekicks"/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /transcript_turn_upserted/);
  assert.doesNotMatch(read("Rally/Network/ConversationSocket.swift"), /case "turn_upserted"/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /stream_started/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /stream_delta/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /stream_completed/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /load_transcript_range/);
  assert.doesNotMatch(read("Rally/Network/ConversationSocket.swift"), /beforeSequence/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /snapshotId/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /resumeAfterEventSequence/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /request_snapshot/);
  assert.match(read("Rally/Design/RallyInfiniteScroll.swift"), /onChange\(of: isLoading\)/);
  assert.match(read("Rally/Network/RallyPagedDirectory.swift"), /transcriptRangeBlockSize = 20/);
  assert.match(read("RallyTests/RallyPagedDirectoryTests.swift"), /testOlderTranscriptRangeAsksTheDesktopBlock/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /mark_opened/);
  assert.match(read("Rally/Network/ConversationSocket.swift"), /publishPresence/);
  const policy = read("Rally/Network/RallySocketPolicy.swift");
  assert.match(policy, /RallySocketPolicy/);
  assert.match(policy, /hoverWarmupSeconds/);
  assert.match(policy, /warmedFeeds/);
  assert.doesNotMatch(policy, /pinned/);
  const pool = read("Rally/Network/RallySocketPool.swift");
  assert.match(pool, /RallySocketPool/);
  assert.match(pool, /listWorkstreams/);
  assert.match(pool, /pendingSet/);
  assert.match(pool, /pendingSet\?\.feeds\.first/);
  assert.match(pool, /isBusy\(\)/);
  assert.match(model, /syncPool/);
  assert.match(model, /fetchMoreWorkstreams/);
  assert.match(model, /fetchMoreSearch/);
  assert.doesNotMatch(model, /func ensureSocket/);
  assert.match(read("Rally/Network/WorkspaceSocket.swift"), /list_workstreams/);
  assert.match(read("Rally/Network/WorkspaceSocket.swift"), /workspace_workstream_recency/);
  assert.match(read("Rally/Network/RallyPagedDirectory.swift"), /workstreamPageSize = 250/);
  assert.match(read("Rally/Design/RallyInfiniteScroll.swift"), /rallyInfiniteScroll/);
  assert.match(history, /fetchMoreWorkstreams/);
  assert.doesNotMatch(conversation, /Load earlier messages/);
  assert.doesNotMatch(conversation, /rallyInfiniteScroll/);
  assert.match(conversation, /RallyScrollEdge/);
  assert.match(conversation, /settledAtBottom/);
  assert.match(read("Rally/Design/RallyInfiniteScroll.swift"), /struct RallyScrollEdge/);
  assert.match(read("RallyTests/RallyScrollEdgeTests.swift"), /testPulledToOldestRowIsAtTop/);
  assert.match(read("Rally/Features/Chat/SubstreamSwitcher.swift"), /warmupSeconds: 0/);
  assert.match(conversation, /defaultScrollAnchor\(\.bottom\)/);
  assert.match(read("RallyTests/RallySocketPolicyTests.swift"), /testVisibleChildKeepsPresenceFreeMain/);
  assert.match(read("RallyTests/RallySocketPolicyTests.swift"), /testWarmedDirectoryRowAddsPresenceFreeFeed/);
  assert.match(read("RallyTests/RallyPagedDirectoryTests.swift"), /testSubscribeWithCursorKeepsLaterPagesAndRefreshesPageOne/);
  assert.match(read("RallyTests/RallyTicketedSocketTests.swift"), /testInvalidTicketURLClosesWithoutConnecting/);
  assert.match(read("RallyTests/RallyContractTests.swift"), /testDerivedAppearanceMatchesDesktopHash/);
  const push = read("Rally/App/RallyPush.swift");
  assert.match(push, /ai\.rallywith\.ios|bundleIdentifier/);
  assert.match(push, /apnsEnvironment/);
  assert.match(push, /sandbox/);
  assert.match(read("Rally/Network/RallyClient.swift"), /\/push-devices\//);
  assert.match(read("Rally/Network/RallyClient.swift"), /\/feature-flags/);
  assert.match(read("Rally/App/AppModel.swift"), /registerPushDevice/);
  assert.match(read("Rally/App/AppModel.swift"), /deletePushDevice/);
  assert.doesNotMatch(read("Rally/App/RallyAppDelegate.swift"), /rally\.apns\.deviceToken/);
  assert.doesNotMatch(read("Rally/App/RallyAppDelegate.swift"), /Worker does not yet accept/);
  assert.match(read("Rally/Features/Settings/SettingsScreen.swift"), /Notify me on this iPhone/);
  assert.match(read("RallyTests/RallyPushTests.swift"), /testParsesMentionPayloadURL/);
  assert.match(conversation, /New substream/);
  assert.match(conversation, /SubstreamLaunchView/);
  const deepLink = read("Rally/App/RallyDeepLink.swift");
  assert.match(deepLink, /substreams/);
  assert.match(deepLink, /workspaceId/);
  assert.match(feed, /branchProvenance/);
  assert.match(conversation, /multi_select/);
  assert.match(conversation, /\.list\(selected\.sorted\(\)\)/);
  assert.match(history, /scope == "workspace"/);
  assert.doesNotMatch(history, /scope == "public"/);
  assert.match(read("Rally/Network/RallyClient.swift"), /deliveryTargets/);
  assert.match(read("Rally/Network/RallyClient.swift"), /refreshCurrentSession/);
  assert.match(read("Rally/App/AppModel.swift"), /ASWebAuthenticationSessionError\.errorDomain/);
  assert.match(read("Rally/App/AppModel.swift"), /bindIdentity\(identitySession\)/);
  assert.match(read("fastlane/ExportOptions.plist"), /<string>export<\/string>/);
  assert.doesNotMatch(read("fastlane/ExportOptions.plist"), /<string>upload<\/string>/);
  assert.match(read("Config/Tests.xcconfig"), /INFOPLIST_FILE =/);
  assert.match(read("Config/Tests.xcconfig"), /CODE_SIGN_ENTITLEMENTS =/);
  assert.match(read("Rally.xcodeproj/project.pbxproj"), /Tests\.xcconfig/);
  assert.match(read("RallyTests/RallyContractTests.swift"), /testLiveTurnUsesTranscriptTurnUpserted/);
  assert.match(conversation, /onChange\(of: messages\.last\?\.id, initial: true\)/);
  assert.match(conversation, /\.task\(id: message\.isStreaming\)/);
  assert.match(read("Rally/App/RootView.swift"), /coordinator\.resolved == nil/);
  const desktopApp = readFileSync(join(repoRoot, "apps/desktop/src/renderer/App.tsx"), "utf8");
  for (const route of [
    "/workstreams/new",
    "/workstreams/:id",
    "/projects/:projectId",
    "/sidekicks",
    "/sidekicks/:id",
    "/automations/:id",
    "/settings",
  ]) {
    assert.match(desktopApp, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
