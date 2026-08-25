ObjC.import('AppKit');

const notificationName = 'ai.rallywith.desktop.application-icon-changed';

function refreshDockIconCache() {
  try {
    const configurationClass = $.NSClassFromString('SLSIconAppearanceConfiguration');
    if (!configurationClass) return false;
    // JXA invokes zero-argument Objective-C selectors through property access.
    // Calling either value with `()` throws because the bridged result is not a
    // JavaScript function.
    const configuration = configurationClass.fetchCurrentIconAppearanceConfiguration;
    if (!configuration) return false;
    const saveResult = configuration.save;
    void saveResult;
    return true;
  } catch {
    // The cache refresh uses the same private selector as System Settings.
    // Icon selection still succeeds if Apple removes it in a later release.
    return false;
  }
}

function notifyDockTilePlugin() {
  $.NSDistributedNotificationCenter.defaultCenter
    .postNotificationNameObjectUserInfoDeliverImmediately(
      $(notificationName),
      $('Rally'),
      $(),
      true,
    );
}

function run(arguments_) {
  if (arguments_.length !== 2) {
    throw new Error('Expected an icon path and application bundle path, or --reset and an application bundle path');
  }
  const isReset = String(arguments_[0]) === '--reset';
  const iconPath = isReset ? null : String(arguments_[0]);
  const applicationPath = String(arguments_[1]);
  const icon = isReset ? $() : $.NSImage.alloc.initWithContentsOfFile($(iconPath));
  if (!isReset && !icon) throw new Error(`Could not decode application icon: ${iconPath}`);

  const didSetFinderIcon = $.NSWorkspace.sharedWorkspace.setIconForFileOptions(
    icon,
    $(applicationPath),
    0,
  );
  if (!didSetFinderIcon) throw new Error(`Could not set the Finder icon for ${applicationPath}`);

  // Distributed notifications are normally queued. The Dock plug-in needs to
  // clear or replace its content view before this short-lived JXA process exits.
  notifyDockTilePlugin();
  const didRefreshDockCache = refreshDockIconCache();
  // The cache refresh may recreate the tile or load the plug-in for the first
  // time, so deliver the selected state once more after the refresh.
  notifyDockTilePlugin();
  return JSON.stringify({ didSetFinderIcon: true, didRefreshDockCache, reset: isReset });
}
