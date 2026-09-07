#import <Cocoa/Cocoa.h>

@interface RallyDockTilePluginV2 : NSObject <NSDockTilePlugIn>
@property(nonatomic, strong) NSImageView *imageView;
- (NSString *)applicationSupportDirectory;
- (NSURL *)iconDirectoryURL;
- (void)applicationIconChanged:(NSNotification *)notification;
@end

// Redirect only the installation and user-data locations. All preference,
// manifest, image loading and tile refresh code runs unchanged against real files.
@interface FixtureDockTilePlugin : RallyDockTilePluginV2
@property(nonatomic, copy) NSString *fixtureSupport;
@property(nonatomic, strong) NSURL *fixtureIcons;
@end
@implementation FixtureDockTilePlugin
- (NSString *)applicationSupportDirectory { return self.fixtureSupport; }
- (NSURL *)iconDirectoryURL { return self.fixtureIcons; }
@end

static void require(BOOL condition, NSString *message) {
  if (!condition) [NSException raise:@"IconUpgradeRegression" format:@"%@", message];
}

static void writeJSON(id object, NSString *path) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];
  require([data writeToFile:path atomically:YES], @"Could not write fixture JSON");
}

static void validateUpgrade(NSString *firstArtwork, NSString *secondArtwork) {
  NSFileManager *files = [NSFileManager defaultManager];
  NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  NSString *support = [root stringByAppendingPathComponent:@"Support"];
  NSString *preference = [support stringByAppendingPathComponent:@"Rally/application-icon.json"];
  NSString *icons = [root stringByAppendingPathComponent:@"Installed.app/Contents/Resources/app-icons"];
  NSString *manifest = [icons stringByAppendingPathComponent:@"manifest.json"];
  @try {
    require([files createDirectoryAtPath:[preference stringByDeletingLastPathComponent]
        withIntermediateDirectories:YES attributes:nil error:NULL], @"Create preferences");
    require([files createDirectoryAtPath:icons withIntermediateDirectories:YES attributes:nil error:NULL], @"Create icons");
    require([files copyItemAtPath:firstArtwork toPath:[icons stringByAppendingPathComponent:@"light.icns"] error:NULL], @"Copy first image");
    writeJSON(@{ @"version": @1, @"icons": @[ @"light" ] }, manifest);
    writeJSON(@{ @"version": @1, @"icon": @"light" }, preference);
    FixtureDockTilePlugin *plugin = [[FixtureDockTilePlugin alloc] init];
    plugin.fixtureSupport = support;
    plugin.fixtureIcons = [NSURL fileURLWithPath:icons];
    [plugin setDockTile:nil];
    require(plugin.imageView.image != nil, @"Initial selected image must load");
    NSData *firstImage = plugin.imageView.image.TIFFRepresentation;

    // Replace the installed resources while retaining the exact same plugin.
    require([files moveItemAtPath:icons toPath:[root stringByAppendingPathComponent:@"OldResources"] error:NULL], @"Move old installation");
    require([files createDirectoryAtPath:icons withIntermediateDirectories:YES attributes:nil error:NULL], @"Replace installation");
    require([files copyItemAtPath:secondArtwork toPath:[icons stringByAppendingPathComponent:@"future-artwork.icns"] error:NULL], @"Copy new image");
    writeJSON(@{ @"version": @1, @"icons": @[ @"future-artwork" ] }, manifest);
    writeJSON(@{ @"version": @1, @"icon": @"future-artwork" }, preference);
    [plugin applicationIconChanged:nil];
    NSData *updatedImage = plugin.imageView.image.TIFFRepresentation;
    require(updatedImage != nil && ![updatedImage isEqual:firstImage], @"A surviving plugin must display newly installed artwork");

    // Removing an ID from a later catalog must clear even a still-present file.
    writeJSON(@{ @"version": @1, @"icons": @[] }, manifest);
    [plugin applicationIconChanged:nil];
    require(plugin.imageView == nil, @"Retired artwork must clear the tile");
    writeJSON(@{ @"version": @1, @"icons": @[ @"../escape" ] }, manifest);
    writeJSON(@{ @"version": @1, @"icon": @"../escape" }, preference);
    require([files copyItemAtPath:firstArtwork toPath:[[icons stringByDeletingLastPathComponent]
        stringByAppendingPathComponent:@"escape.icns"] error:NULL], @"Copy traversal trap");
    [plugin applicationIconChanged:nil];
    require(plugin.imageView == nil, @"Preferences must not traverse out of the icon directory");
    writeJSON(@{ @"version": @1, @"icon": @"future-artwork" }, preference);
    writeJSON(@{ @"version": @2, @"icons": @[ @"future-artwork" ] }, manifest);
    [plugin applicationIconChanged:nil];
    require(plugin.imageView == nil, @"Unsupported catalog must fall back to system icon");
    require([files removeItemAtPath:manifest error:NULL], @"Remove catalog");
    [plugin applicationIconChanged:nil];
    require(plugin.imageView == nil, @"Missing catalog must fall back to system icon");
    writeJSON(@{ @"version": @1, @"icons": @[ @"future-artwork" ] }, manifest);
    [plugin applicationIconChanged:nil];
    require(plugin.imageView.image != nil, @"A later notification must recover after missing resources");
    require([files removeItemAtPath:preference error:NULL], @"Reset preference");
    [plugin applicationIconChanged:nil];
    require(plugin.imageView == nil, @"System selection must clear custom artwork");
  } @finally {
    [files removeItemAtPath:root error:NULL];
  }
}

static BOOL validateArtwork(NSString *path) {
  NSBitmapImageRep *image = [NSBitmapImageRep imageRepWithData:[NSData dataWithContentsOfFile:path]];
  if (!image || image.pixelsWide != 1024 || image.pixelsHigh != 1024) {
    NSLog(@"App icon source must be a 1024x1024 bitmap: %@", path);
    return NO;
  }
  if (!image.hasAlpha) return YES;
  for (NSInteger y = 0; y < image.pixelsHigh; y++) {
    @autoreleasepool {
      for (NSInteger x = 0; x < image.pixelsWide; x++) {
        if ([image colorAtX:x y:y].alphaComponent != 1.0) {
          NSLog(@"App icon source must be opaque and full-bleed: %@", path);
          return NO;
        }
      }
    }
  }
  return YES;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    for (int i = 1; i < argc; i++) {
      if (!validateArtwork([NSString stringWithUTF8String:argv[i]])) return 1;
    }
    if (argc >= 3) validateUpgrade([NSString stringWithUTF8String:argv[1]], [NSString stringWithUTF8String:argv[2]]);
    RallyDockTilePluginV2 *plugin = [[RallyDockTilePluginV2 alloc] init];
    [plugin setDockTile:nil];
  }
  return 0;
}
