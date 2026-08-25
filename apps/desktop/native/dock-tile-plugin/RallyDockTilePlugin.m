#import <Cocoa/Cocoa.h>

static NSString *const RallyApplicationIconNotification = @"ai.rallywith.desktop.application-icon-changed";

@interface RallyDockTilePlugin : NSObject <NSDockTilePlugIn> {
 @private
  NSDockTile *_dockTile;
}
@property(nonatomic, strong) NSDockTile *dockTile;
@property(nonatomic, strong) NSImageView *imageView;
@end

@implementation RallyDockTilePlugin

@synthesize dockTile = _dockTile;

- (instancetype)init {
  self = [super init];
  if (self) {
    [[NSDistributedNotificationCenter defaultCenter]
        addObserver:self
           selector:@selector(applicationIconChanged:)
               name:RallyApplicationIconNotification
             object:nil
 suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  }
  return self;
}

- (void)dealloc {
  [[NSDistributedNotificationCenter defaultCenter] removeObserver:self];
}

- (void)setDockTile:(NSDockTile *)dockTile {
  _dockTile = dockTile;
  [self refreshDockTile];
}

- (void)applicationIconChanged:(NSNotification *)notification {
  (void)notification;
  [self refreshDockTile];
}

- (NSString *)selectedIconIdentifier {
  NSString *applicationSupport = NSSearchPathForDirectoriesInDomains(
      NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  // Both userData directory names, current first. The main process adopts
  // `Avalon` into `Rally` on launch, but when that rename fails it deliberately
  // keeps running out of the superseded directory — and it is exactly that
  // fallback where reading only the current path would drop the person's chosen
  // Dock icon. This plugin cannot see which one won, so it reads both.
  NSData *encoded = nil;
  for (NSString *directory in @[ @"Rally", @"Avalon" ]) {
    NSString *preferencePath = [applicationSupport stringByAppendingPathComponent:
        [directory stringByAppendingPathComponent:@"application-icon.json"]];
    encoded = [NSData dataWithContentsOfFile:preferencePath];
    if (encoded) break;
  }
  if (!encoded) return nil;

  NSError *error = nil;
  id decoded = [NSJSONSerialization JSONObjectWithData:encoded options:0 error:&error];
  if (error || ![decoded isKindOfClass:[NSDictionary class]]) return nil;
  NSDictionary *stored = (NSDictionary *)decoded;
  if (![stored[@"version"] isEqual:@1] || ![stored[@"icon"] isKindOfClass:[NSString class]]) {
    return nil;
  }

  static NSSet<NSString *> *allowedIdentifiers;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedIdentifiers = [NSSet setWithArray:@[
      @"light",
      @"dark",
      @"sunset-sherbet",
      @"ludicrous-speed",
      @"ruby",
      @"holographic",
      @"leather",
      @"blueprint",
    ]];
  });
  NSString *identifier = stored[@"icon"];
  return [allowedIdentifiers containsObject:identifier] ? identifier : nil;
}

- (NSImage *)selectedIconImage {
  NSString *identifier = [self selectedIconIdentifier];
  if (!identifier) return nil;

  NSURL *pluginURL = [NSBundle bundleForClass:self.class].bundleURL;
  NSURL *contentsURL = [[pluginURL URLByDeletingLastPathComponent] URLByDeletingLastPathComponent];
  NSURL *iconURL = [[[contentsURL URLByAppendingPathComponent:@"Resources/app-icons"]
      URLByAppendingPathComponent:identifier]
      URLByAppendingPathExtension:@"icns"];
  return [[NSImage alloc] initWithContentsOfURL:iconURL];
}

- (void)refreshDockTile {
  NSImage *image = [self selectedIconImage];
  if (!image) {
    self.dockTile.contentView = nil;
    self.imageView = nil;
    [self.dockTile display];
    return;
  }

  NSSize tileSize = self.dockTile.size;
  NSImageView *imageView = [[NSImageView alloc]
      initWithFrame:NSMakeRect(0, 0, tileSize.width, tileSize.height)];
  imageView.image = image;
  imageView.imageAlignment = NSImageAlignCenter;
  imageView.imageScaling = NSImageScaleAxesIndependently;
  imageView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.imageView = imageView;
  self.dockTile.contentView = imageView;
  [self.dockTile display];
}

@end
