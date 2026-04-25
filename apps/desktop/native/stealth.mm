#include <node_api.h>

#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>

namespace {

void ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
}

void ThrowError(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
}

bool ReadHandleBuffer(napi_env env, napi_value value, void** out) {
  bool is_buffer = false;
  napi_status status = napi_is_buffer(env, value, &is_buffer);
  if (status != napi_ok || !is_buffer) {
    ThrowTypeError(env, "nativeHandle must be a Buffer");
    return false;
  }

  void* data = nullptr;
  size_t length = 0;
  status = napi_get_buffer_info(env, value, &data, &length);
  if (status != napi_ok || data == nullptr || length < sizeof(void*)) {
    ThrowTypeError(env, "nativeHandle must contain a native pointer");
    return false;
  }

  *out = *reinterpret_cast<void**>(data);
  if (*out == nullptr) {
    ThrowError(env, "nativeHandle pointer is null");
    return false;
  }
  return true;
}

NSWindow* ResolveWindow(void* handle) {
  id candidate = (__bridge id)handle;
  if ([candidate isKindOfClass:[NSWindow class]]) {
    return static_cast<NSWindow*>(candidate);
  }
  if ([candidate isKindOfClass:[NSView class]]) {
    return static_cast<NSView*>(candidate).window;
  }
  return nil;
}

void SetBoolResult(napi_env env, bool value, napi_value* result) {
  napi_get_boolean(env, value, result);
}

}  // namespace

napi_value SetWindowStealth(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (status != napi_ok || argc < 2) {
    ThrowTypeError(env, "Expected nativeHandle Buffer and enabled boolean");
    return nullptr;
  }

  void* handle = nullptr;
  if (!ReadHandleBuffer(env, argv[0], &handle)) {
    return nullptr;
  }

  bool enabled = false;
  status = napi_get_value_bool(env, argv[1], &enabled);
  if (status != napi_ok) {
    ThrowTypeError(env, "enabled must be a boolean");
    return nullptr;
  }

  __block bool applied = false;
  auto apply = ^{
    NSWindow* window = ResolveWindow(handle);
    if (!window) return;
    window.sharingType = enabled ? NSWindowSharingNone : NSWindowSharingReadOnly;
    applied = true;
  };

  if ([NSThread isMainThread]) {
    apply();
  } else {
    dispatch_sync(dispatch_get_main_queue(), apply);
  }

  napi_value result;
  SetBoolResult(env, applied, &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"setWindowStealth", nullptr, SetWindowStealth, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(*descriptors), descriptors);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
