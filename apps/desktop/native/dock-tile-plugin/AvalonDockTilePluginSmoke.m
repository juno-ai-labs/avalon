#import <Cocoa/Cocoa.h>

@interface AvalonDockTilePlugin : NSObject <NSDockTilePlugIn>
@end

int main(void) {
  @autoreleasepool {
    AvalonDockTilePlugin *plugin = [[AvalonDockTilePlugin alloc] init];
    [plugin setDockTile:nil];
  }
  return 0;
}
