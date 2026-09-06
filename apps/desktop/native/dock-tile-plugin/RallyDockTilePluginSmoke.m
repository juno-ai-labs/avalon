#import <Cocoa/Cocoa.h>

@interface RallyDockTilePlugin : NSObject <NSDockTilePlugIn>
@end

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
    RallyDockTilePlugin *plugin = [[RallyDockTilePlugin alloc] init];
    [plugin setDockTile:nil];
  }
  return 0;
}
