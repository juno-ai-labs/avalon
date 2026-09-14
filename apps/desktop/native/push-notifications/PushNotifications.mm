#include <node_api.h>
#import <UserNotifications/UserNotifications.h>
#include <string>

static napi_threadsafe_function callback;
static void Emit(NSDictionary *event) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!json || !callback) return;
  auto *text = new std::string((const char *)json.bytes, json.length);
  if (napi_call_threadsafe_function(callback, text, napi_tsfn_nonblocking) != napi_ok) delete text;
}
static void CallJs(napi_env env, napi_value cb, void *, void *data) {
  auto *text = static_cast<std::string *>(data);
  if (env) {
    napi_value value, receiver, result;
    napi_create_string_utf8(env, text->c_str(), text->size(), &value);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, cb, 1, &value, &result);
  }
  delete text;
}

// Forward unrelated local notification callbacks to Electron's delegate.
@interface RallyPushDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, strong) id<UNUserNotificationCenterDelegate> previous;
@end
@implementation RallyPushDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completion {
  NSDictionary *rally = response.notification.request.content.userInfo[@"rally"];
  if (rally) {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) Emit(@{ @"response": rally });
    completion();
  } else if ([self.previous respondsToSelector:_cmd]) {
    [self.previous userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completion];
  } else completion();
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  if (notification.request.content.userInfo[@"rally"]) {
    completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
  } else if ([self.previous respondsToSelector:_cmd]) {
    [self.previous userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completion];
  } else completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}
@end
static RallyPushDelegate *delegate;
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], name, result;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_create_string_utf8(env, "RallyPush", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs, &callback);
  napi_unref_threadsafe_function(env, callback);
  delegate = [RallyPushDelegate new];
  delegate.previous = UNUserNotificationCenter.currentNotificationCenter.delegate;
  UNUserNotificationCenter.currentNotificationCenter.delegate = delegate;
  napi_get_undefined(env, &result); return result;
}
static void ReadPermission(void) {
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    NSString *value = settings.authorizationStatus == UNAuthorizationStatusDenied ? @"denied"
      : settings.authorizationStatus == UNAuthorizationStatusNotDetermined ? @"not_determined" : @"enabled";
    Emit(@{ @"permission": value });
  }];
}
static napi_value Permission(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], result; bool request = false;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_get_value_bool(env, args[0], &request);
  if (request) {
    [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL, NSError *) { ReadPermission(); }];
  } else ReadPermission();
  napi_get_undefined(env, &result); return result;
}
static napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"permission", nullptr, Permission, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
