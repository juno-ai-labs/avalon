#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// Load the built bundle rather than linking its class into this executable.
// Only preferences are isolated; bundle and resource resolution run unchanged.
@interface NSObject (DockPluginSmoke)
- (void)setDockTile:(NSDockTile *)tile;
- (void)applicationIconChanged:(NSNotification *)notification;
- (NSImageView *)imageView;
@end

static NSString *fixtureSupport;
static id applicationSupport(id self, SEL selector) {
  (void)self;
  (void)selector;
  return fixtureSupport;
}
static void require(BOOL condition, NSString *message) {
  if (!condition) [NSException raise:@"BundleUpgradeRegression" format:@"%@", message];
}
static void writeJSON(id value, NSString *path) {
  require([[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL]
      writeToFile:path atomically:YES], @"Write fixture JSON");
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    if (argc != 4) return 1;
    NSFileManager *files = NSFileManager.defaultManager;
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString *installed = [root stringByAppendingPathComponent:@"Installed.app"];
    NSString *old = [root stringByAppendingPathComponent:@"ShipIt/Old.app"];
    NSString *pluginPath = [installed stringByAppendingPathComponent:@"Contents/PlugIns/RallyDockTilePluginV2.docktileplugin"];
    NSString *icons = [installed stringByAppendingPathComponent:@"Contents/Resources/app-icons"];
    fixtureSupport = [root stringByAppendingPathComponent:@"Support"];
    NSString *preference = [fixtureSupport stringByAppendingPathComponent:@"Rally/application-icon.json"];
    @try {
      for (NSString *directory in @[ [pluginPath stringByDeletingLastPathComponent], icons,
          [preference stringByDeletingLastPathComponent], [old stringByDeletingLastPathComponent] ]) {
        require([files createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL], @"Create fixture directory");
      }
      require([files copyItemAtPath:[NSString stringWithUTF8String:argv[1]] toPath:pluginPath error:NULL], @"Stage plugin");
      require([files copyItemAtPath:[NSString stringWithUTF8String:argv[2]] toPath:[icons stringByAppendingPathComponent:@"light.icns"] error:NULL], @"Stage original artwork");
      writeJSON(@{ @"version": @1, @"icons": @[ @"light" ] }, [icons stringByAppendingPathComponent:@"manifest.json"]);
      writeJSON(@{ @"version": @1, @"icon": @"light" }, preference);
      NSBundle *bundle = [NSBundle bundleWithPath:pluginPath];
      require([bundle load], @"Load the actual plugin bundle");
      Class isolated = objc_allocateClassPair(bundle.principalClass, "IsolatedBundlePlugin", 0);
      require(isolated != Nil, @"Create preference-isolated plugin class");
      class_addMethod(isolated, @selector(applicationSupportDirectory), (IMP)applicationSupport, "@@:");
      objc_registerClassPair(isolated);
      id plugin = [[isolated alloc] init];
      NSDockTile *tile = NSApplication.sharedApplication.dockTile;
      [plugin setDockTile:tile];
      require([plugin imageView].image != nil, @"Original installed image must load");
      NSData *originalImage = [plugin imageView].image.TIFFRepresentation;

      // Model ShipIt moving the complete old bundle away, replacing it at the
      // installation URL, then deleting the old binary while it remains loaded.
      require([files moveItemAtPath:installed toPath:old error:NULL], @"Move loaded app to ShipIt staging");
      require([files copyItemAtPath:old toPath:installed error:NULL], @"Install replacement app");
      require([files removeItemAtPath:old error:NULL], @"Delete the old loaded binary");
      require([files copyItemAtPath:[NSString stringWithUTF8String:argv[3]] toPath:[icons stringByAppendingPathComponent:@"future-artwork.icns"] error:NULL], @"Install new artwork");
      writeJSON(@{ @"version": @1, @"icons": @[ @"future-artwork" ] }, [icons stringByAppendingPathComponent:@"manifest.json"]);
      writeJSON(@{ @"version": @1, @"icon": @"future-artwork" }, preference);
      [plugin applicationIconChanged:nil];
      NSData *updated = [plugin imageView].image.TIFFRepresentation;
      require(updated != nil && ![updated isEqual:originalImage], @"Loaded bundle must read replacement installation after its binary is deleted");
      require(tile.contentView == [plugin imageView], @"Updated image must reach the native Dock tile");
      NSLog(@"Loaded bundle retained installation URL after ShipIt replacement: %@", [NSBundle bundleForClass:bundle.principalClass].bundleURL.path);
      [plugin setDockTile:nil];
    } @catch (NSException *exception) {
      NSLog(@"%@", exception.reason);
      return 1;
    } @finally {
      [files removeItemAtPath:root error:NULL];
    }
  }
  return 0;
}
