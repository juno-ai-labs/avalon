#include <node_api.h>
#include <os/log.h>

#include <string>

namespace {

os_log_t PerformanceLog() {
  static os_log_t log = os_log_create("ai.rallywith.desktop", "performance");
  return log;
}

napi_value WritePerformance(napi_env env, napi_callback_info info) {
  size_t argument_count = 1;
  napi_value arguments[1];
  if (napi_get_cb_info(env, info, &argument_count, arguments, nullptr, nullptr) != napi_ok
      || argument_count != 1) {
    napi_throw_type_error(env, nullptr, "writePerformance requires one serialized event");
    return nullptr;
  }

  napi_valuetype type;
  if (napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, nullptr, "writePerformance requires a string");
    return nullptr;
  }

  size_t length = 0;
  if (napi_get_value_string_utf8(env, arguments[0], nullptr, 0, &length) != napi_ok) {
    napi_throw_error(env, nullptr, "could not read unified-log event length");
    return nullptr;
  }
  std::string encoded(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, arguments[0], encoded.data(), encoded.size(), &copied) != napi_ok) {
    napi_throw_error(env, nullptr, "could not read unified-log event");
    return nullptr;
  }
  encoded.resize(copied);

  // The TypeScript boundary admits only the content-free renderer performance
  // contract. Marking it public makes its indexed JSON visible in Console.app;
  // the default private interpolation would replace the whole record with
  // <private> and leave a durable log that answered nothing.
  // DEFAULT is persisted by Unified Logging's ordinary policy. INFO is useful
  // only to a live stream unless the subsystem has a custom profile, which
  // would recreate the session-to-session loss this bridge exists to remove.
  os_log_with_type(PerformanceLog(), OS_LOG_TYPE_DEFAULT, "%{public}s", encoded.c_str());
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "writePerformance", NAPI_AUTO_LENGTH, WritePerformance, nullptr, &function)
      != napi_ok
      || napi_set_named_property(env, exports, "writePerformance", function) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize unified-log binding");
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
