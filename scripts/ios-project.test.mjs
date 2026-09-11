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

  const darkDesktop = join(repoRoot, "apps/desktop/resources/app-icons/dark.png");
  assert.equal(existsSync(darkDesktop), true, "iOS App Icon is the Electron dark selectable icon");
});

test("required Swift surfaces exist for a complete conversation client", () => {
  const required = [
    "Rally/RallyApp.swift",
    "Rally/App/AppModel.swift",
    "Rally/App/RallyDeepLink.swift",
    "Rally/App/RallyAppDelegate.swift",
    "Rally/Auth/PKCE.swift",
    "Rally/Auth/KeychainStore.swift",
    "Rally/Network/RallyClient.swift",
    "Rally/Network/ConversationSocket.swift",
    "Rally/Features/Onboarding/SignInView.swift",
    "Rally/Features/Workspaces/WorkspacePickerView.swift",
    "Rally/Features/Chat/ConversationScreen.swift",
    "Rally/Features/Chat/ComposerBar.swift",
    "Rally/Features/History/HistoryPanel.swift",
    "Rally/Features/Settings/SettingsScreen.swift",
    "Rally/Features/Voice/VoiceBar.swift",
    "Rally/Features/Chat/FeedProjection.swift",
    "Rally/Network/WorkspaceSocket.swift",
    "Rally/App/MainShell.swift",
    "Rally/Features/Projects/ProjectsScreen.swift",
    "Rally/Features/Notes/NotesScreen.swift",
    "Rally/Features/Sidekicks/SidekicksScreen.swift",
    "Rally/Features/Workspace/DirectorySheets.swift",
    "RallyTests/RallyContractTests.swift",
    "RallyUITests/LaunchUITests.swift",
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
  assert.match(shell, /ProjectsScreen/);
  assert.match(shell, /NotesScreen/);
  assert.match(shell, /SidekicksScreen/);
  const history = read("Rally/Features/History/HistoryPanel.swift");
  assert.match(history, /Pin/);
  assert.match(history, /Archive/);
  assert.match(history, /Unread/);
  assert.match(history, /Rename/);
  const settings = read("Rally/Features/Settings/SettingsScreen.swift");
  assert.match(settings, /Digest/);
  assert.match(settings, /Connections/);
  const desktopApp = readFileSync(join(repoRoot, "apps/desktop/src/renderer/App.tsx"), "utf8");
  for (const route of [
    "/workstreams/new",
    "/workstreams/:id",
    "/projects/:projectId",
    "/notes/:id",
    "/sidekicks",
    "/sidekicks/:id",
    "/automations/:id",
    "/settings",
    "/meeting",
  ]) {
    assert.match(desktopApp, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
