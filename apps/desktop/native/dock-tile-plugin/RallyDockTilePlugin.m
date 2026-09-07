#import <Cocoa/Cocoa.h>

static NSString *const RallyApplicationIconNotification = @"ai.rallywith.desktop.application-icon-changed";

@interface RallyDockTilePluginV2 : NSObject <NSDockTilePlugIn> {
 @private
  NSDockTile *_dockTile;
}
@property(nonatomic, strong) NSDockTile *dockTile;
@property(nonatomic, strong) NSImageView *imageView;
@end

@implementation RallyDockTilePluginV2

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

- (NSString *)applicationSupportDirectory {
  return NSSearchPathForDirectoriesInDomains(
      NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
}

- (NSURL *)iconDirectoryURL {
  NSURL *pluginURL = [NSBundle bundleForClass:[RallyDockTilePluginV2 class]].bundleURL;
  NSURL *contentsURL = [[pluginURL URLByDeletingLastPathComponent] URLByDeletingLastPathComponent];
  return [contentsURL URLByAppendingPathComponent:@"Resources/app-icons"];
}

- (NSString *)selectedIconIdentifier {
  NSString *applicationSupport = [self applicationSupportDirectory];
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

  NSString *identifier = stored[@"icon"];
  // Preferences never supply paths, even if the installed manifest is malformed.
  NSCharacterSet *invalidCharacters = [[NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyz0123456789-"] invertedSet];
  if (identifier.length == 0 || [identifier rangeOfCharacterFromSet:invalidCharacters].location != NSNotFound) {
    return nil;
  }

  // Dock hosts survive app replacement. Read the installed catalog on every
  // notification: a compiled or cached allowlist silently rejects future icons.
  NSData *catalogData = [NSData dataWithContentsOfURL:
      [[self iconDirectoryURL] URLByAppendingPathComponent:@"manifest.json"]];
  if (!catalogData) return nil;
  id catalog = [NSJSONSerialization JSONObjectWithData:catalogData options:0 error:NULL];
  if (![catalog isKindOfClass:[NSDictionary class]] || ![catalog[@"version"] isEqual:@1] ||
      ![catalog[@"icons"] isKindOfClass:[NSArray class]]) return nil;
  return [catalog[@"icons"] containsObject:identifier] ? identifier : nil;
}

- (NSImage *)selectedIconImage {
  NSString *identifier = [self selectedIconIdentifier];
  if (!identifier) return nil;

  NSURL *iconURL = [[[self iconDirectoryURL] URLByAppendingPathComponent:identifier]
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
