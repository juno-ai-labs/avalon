#import <Cocoa/Cocoa.h>

@interface RallyDockTilePlugin : NSObject <NSDockTilePlugIn>
@end

int main(void) {
  @autoreleasepool {
    RallyDockTilePlugin *plugin = [[RallyDockTilePlugin alloc] init];
    [plugin setDockTile:nil];
  }
  return 0;
}
