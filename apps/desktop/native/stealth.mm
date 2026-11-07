#include <node_api.h>

#include <cstdlib>
#include <cstring>

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
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

napi_value MoveCursor(napi_env env, napi_callback_info info) {
  // Snaps the OS cursor to (x, y) in global screen coordinates. Called
  // from stealth.js when the user has opted into "move cursor to corner
  // on stealth enable" — keeps the cursor off the Friday window during
  // a screen-share so its position doesn't leak the overlay.
  size_t argc = 2;
  napi_value argv[2];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (status != napi_ok || argc < 2) {
    ThrowTypeError(env, "Expected x and y numbers");
    return nullptr;
  }

  double x = 0;
  double y = 0;
  if (napi_get_value_double(env, argv[0], &x) != napi_ok ||
      napi_get_value_double(env, argv[1], &y) != napi_ok) {
    ThrowTypeError(env, "x and y must be numbers");
    return nullptr;
  }

  // CGWarpMouseCursorPosition decouples the system cursor from mouse
  // input briefly; CGAssociateMouseAndMouseCursorPosition(true) restores
  // the linkage so subsequent mouse movement still moves the cursor.
  // Without the re-associate the cursor would freeze until the next
  // mouse event.
  CGPoint point = CGPointMake(x, y);
  CGError err = CGWarpMouseCursorPosition(point);
  CGAssociateMouseAndMouseCursorPosition(true);

  napi_value result;
  SetBoolResult(env, err == kCGErrorSuccess, &result);
  return result;
}

namespace {

// State for one open folder picker. The completion handler runs later on
// the main run loop, outside any JS call, so the result is handed back to
// JS through a thread-safe function, which resolves the promise.
struct FolderPick {
  napi_deferred deferred = nullptr;
  napi_threadsafe_function tsfn = nullptr;
};

void ResolveFolderPick(napi_env env, napi_value /*js_cb*/, void* context, void* data) {
  auto* pick = static_cast<FolderPick*>(context);
  char* path = static_cast<char*>(data);
  if (env != nullptr) {
    napi_value value;
    if (path != nullptr) {
      napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &value);
    } else {
      napi_get_null(env, &value);
    }
    napi_resolve_deferred(env, pick->deferred, value);
  }
  free(path);
  napi_release_threadsafe_function(pick->tsfn, napi_tsfn_release);
  delete pick;
}

// While a stealth picker is open, the panel spawns more windows of its
// own (the Cmd+Shift+G "Go to folder" box, sheets, popovers). They don't
// inherit the panel's sharingType, so each one is protected as it appears:
// on window notifications (before it draws) plus a short sweep as a
// backstop. Returns a token to pass to StopProtectingWindows.
NSArray* StartProtectingWindows() {
  void (^protect)(void) = ^{
    for (NSWindow* w in NSApp.windows) {
      if (w.sharingType != NSWindowSharingNone) w.sharingType = NSWindowSharingNone;
    }
  };
  NSNotificationCenter* center = [NSNotificationCenter defaultCenter];
  NSMutableArray* tokens = [NSMutableArray array];
  for (NSNotificationName name in @[ NSWindowDidUpdateNotification, NSWindowDidBecomeKeyNotification,
                                     NSWindowWillBeginSheetNotification,
                                     NSWindowDidChangeOcclusionStateNotification ]) {
    [tokens addObject:[center addObserverForName:name
                                          object:nil
                                           queue:nil
                                      usingBlock:^(NSNotification*) { protect(); }]];
  }
  NSTimer* sweep = [NSTimer scheduledTimerWithTimeInterval:0.05
                                                   repeats:YES
                                                     block:^(NSTimer*) { protect(); }];
  [[NSRunLoop mainRunLoop] addTimer:sweep forMode:NSRunLoopCommonModes];
  [tokens addObject:sweep];
  protect();
  return tokens;
}

void StopProtectingWindows(NSArray* tokens) {
  for (id token in tokens) {
    if ([token isKindOfClass:[NSTimer class]]) {
      [static_cast<NSTimer*>(token) invalidate];
    } else {
      [[NSNotificationCenter defaultCenter] removeObserver:token];
    }
  }
}

}  // namespace

napi_value ChooseFolder(napi_env env, napi_callback_info info) {
  // chooseFolder(nativeHandle | null, stealth, defaultPath?) -> Promise<string | null>
  //
  // A folder picker that can be hidden from screen capture. Electron's
  // dialog opens a separate window that doesn't get the main window's
  // NSWindowSharingNone, so during a screen share the picker would show.
  // Building the NSOpenPanel here lets us apply the same protection, and
  // lift it above the overlay (which sits at the screen-saver level).
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
    ThrowTypeError(env, "Expected nativeHandle (Buffer or null), stealth boolean, defaultPath?");
    return nullptr;
  }

  NSWindow* parent = nil;
  napi_valuetype handle_type;
  napi_typeof(env, argv[0], &handle_type);
  if (handle_type != napi_null && handle_type != napi_undefined) {
    void* handle = nullptr;
    if (!ReadHandleBuffer(env, argv[0], &handle)) return nullptr;
    parent = ResolveWindow(handle);
  }

  bool stealth = false;
  if (napi_get_value_bool(env, argv[1], &stealth) != napi_ok) {
    ThrowTypeError(env, "stealth must be a boolean");
    return nullptr;
  }

  NSString* default_path = nil;
  if (argc >= 3) {
    napi_valuetype path_type;
    napi_typeof(env, argv[2], &path_type);
    if (path_type == napi_string) {
      size_t len = 0;
      napi_get_value_string_utf8(env, argv[2], nullptr, 0, &len);
      char* buf = static_cast<char*>(malloc(len + 1));
      napi_get_value_string_utf8(env, argv[2], buf, len + 1, &len);
      default_path = [NSString stringWithUTF8String:buf];
      free(buf);
    }
  }

  auto* pick = new FolderPick();
  napi_value promise;
  napi_create_promise(env, &pick->deferred, &promise);
  napi_value resource_name;
  napi_create_string_utf8(env, "friday.chooseFolder", NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_threadsafe_function(env, nullptr, nullptr, resource_name, 0, 1, nullptr,
                                      nullptr, pick, ResolveFolderPick,
                                      &pick->tsfn) != napi_ok) {
    delete pick;
    ThrowError(env, "could not create completion callback");
    return nullptr;
  }

  // Electron runs the main-process JS on the Cocoa main thread, which is
  // where AppKit UI must be created.
  [NSApp activateIgnoringOtherApps:YES];
  NSOpenPanel* panel = [NSOpenPanel openPanel];
  panel.canChooseDirectories = YES;
  panel.canChooseFiles = NO;
  panel.allowsMultipleSelection = NO;
  panel.canCreateDirectories = NO;
  panel.prompt = @"Add folder";
  panel.message = @"Choose a project folder to add to Friday";
  if (default_path != nil) {
    panel.directoryURL = [NSURL fileURLWithPath:default_path isDirectory:YES];
  }
  NSWindowSharingType sharing = stealth ? NSWindowSharingNone : NSWindowSharingReadOnly;
  NSWindowLevel level = NSModalPanelWindowLevel;
  if (parent != nil && parent.level >= level) level = parent.level + 1;
  panel.sharingType = sharing;
  panel.level = level;
  NSArray* protection = stealth ? StartProtectingWindows() : nil;

  __weak NSOpenPanel* weak_panel = panel;
  [panel beginWithCompletionHandler:^(NSModalResponse response) {
    if (protection != nil) StopProtectingWindows(protection);
    char* out = nullptr;
    NSOpenPanel* strong = weak_panel;
    if (response == NSModalResponseOK && strong.URL.path != nil) {
      out = strdup(strong.URL.path.fileSystemRepresentation);
    }
    napi_call_threadsafe_function(pick->tsfn, out, napi_tsfn_blocking);
  }];
  // Re-apply once the panel's window is on screen, in case presenting it
  // reset either property.
  panel.sharingType = sharing;
  panel.level = level;
  [panel makeKeyAndOrderFront:nil];

  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"setWindowStealth", nullptr, SetWindowStealth, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"moveCursor", nullptr, MoveCursor, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"chooseFolder", nullptr, ChooseFolder, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(*descriptors), descriptors);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
