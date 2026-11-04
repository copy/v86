#!/bin/sh
# Build an ARMv7 guest dylib on macOS without an obsolete SDK. The import
# stubs name symbols exported by the owner's iOS 6.1.3 shared cache.
set -eu
out=${1:?usage: build-gles.sh output-directory}
src=$(dirname "$0")
case "${2:-}" in
    "") test "$#" -eq 1; host_contexts= ;;
    --host-contexts|--check-host-contexts|--check-host-surfaces|--check-host-window) test "$#" -eq 3; host_contexts=$2; cache=$3 ;;
    *) echo "usage: build-gles.sh out [--host-contexts|--check-host-contexts|--check-host-surfaces|--check-host-window cache-armv7]" >&2; exit 2 ;;
esac
mkdir -p "$out"
stub() {
    cat > "$out/lib$1.tbd" <<STUB
--- !tapi-tbd-v3
archs: [ armv7 ]
platform: ios
install-name: $2
exports:
  - archs: [ armv7 ]
    symbols: [ $3 ]
...
STUB
}
stub System /usr/lib/libSystem.B.dylib '_getpid, _syslog, _malloc, _calloc, _free, _memcmp, _memcpy, _strcmp, _dladdr, _dlsym, _OSSpinLockLock, _OSSpinLockUnlock, _pthread_create, _pthread_detach, dyld_stub_binder'
stub objc /usr/lib/libobjc.A.dylib '_objc_getClass, _sel_registerName, _class_getInstanceMethod, _method_setImplementation, _method_getImplementation, _class_getInstanceVariable, _ivar_getOffset, _objc_msgSend, _objc_autoreleasePoolPush, _objc_autoreleasePoolPop, _objc_allocateClassPair, _objc_registerClassPair, _class_addMethod'
stub IOKit /System/Library/Frameworks/IOKit.framework/Versions/A/IOKit '_IORegistryEntryFromPath, _IORegistryEntryGetProperty, _IOObjectRelease'
node "$src/gles-opcodes.mjs" > "$out/gles-opcodes.h"
compile() {
    xcrun clang -target armv7-apple-ios6.0 -marm -Os -fPIC -ffreestanding -fno-stack-protector -I "$out" "$@"
}
set -- "$out/eagl.o"
if [ -n "$host_contexts" ]; then
    stub IOSurface /System/Library/PrivateFrameworks/IOSurface.framework/IOSurface '_IOSurfaceGetID, _IOSurfaceGetWidth, _IOSurfaceGetHeight, _IOSurfaceGetPixelFormat, _IOSurfaceCreate, _IOSurfaceLookup, _IOSurfaceLock, _IOSurfaceUnlock, _IOSurfaceGetBaseAddress, _IOSurfaceGetBytesPerRow, _kIOSurfaceWidth, _kIOSurfaceHeight, _kIOSurfaceBytesPerElement, _kIOSurfacePixelFormat'
    stub CoreFoundation /System/Library/Frameworks/CoreFoundation.framework/CoreFoundation '_CFRetain, _CFRelease, _CFNumberCreate, _CFDictionaryCreateMutable, _CFDictionarySetValue, _kCFTypeDictionaryKeyCallBacks, _kCFTypeDictionaryValueCallBacks, _kCFBooleanTrue'
    set -- "$@" -lIOSurface -lCoreFoundation
    node "$src/gl-frame-wrappers.mjs" "$cache" "$out" --slots-only
    check_flag=
    surface_flag=
    if [ "$host_contexts" != "--host-contexts" ]; then
        if [ "$host_contexts" != "--check-host-contexts" ]; then
            stub OpenGLES /System/Library/Frameworks/OpenGLES.framework/OpenGLES '_glGenFramebuffers, _glGenTextures, _glGenRenderbuffers, _glDeleteFramebuffers, _glDeleteTextures, _glDeleteRenderbuffers, _glBindFramebuffer, _glBindTexture, _glBindRenderbuffer, _glFramebufferRenderbuffer, _glFramebufferTexture2D, _glCheckFramebufferStatus, _glGetError, _glClearColor, _glClear, _glEnable, _glDisable, _glScissor, _glReadPixels, _kEAGLDrawablePropertyRetainedBacking'
            compile -c "$src/../../../tests/ios/eagl-surface-probe.c" -o "$out/surface-check.o"
            set -- "$@" "$out/surface-check.o" -lOpenGLES
            surface_flag=-DN90_CHECK_SURFACES
            if [ "$host_contexts" = "--check-host-window" ]; then
                compile -c "$src/../../../tests/ios/eagl-window-probe.c" -o "$out/window-check.o"
                set -- "$@" "$out/window-check.o"
                surface_flag="-DN90_CHECK_SURFACES -DN90_CHECK_WINDOW"
            fi
        fi
        compile $surface_flag -c "$src/../../../tests/ios/eagl-context-probe.c" -o "$out/gli-check.o"
        set -- "$@" "$out/gli-check.o"
        check_flag=-DN90_CHECK_CONTEXTS
    fi
    compile -DN90_HOST_CONTEXTS $check_flag -c "$src/eagl.c" -o "$out/eagl.o"
    compile $surface_flag -c "$src/gli-context.c" -o "$out/gli-context.o"
    compile -c "$src/gli-gates.s" -o "$out/gli-gates.o"
    set -- "$@" "$out/gli-context.o" "$out/gli-gates.o"
else
    compile -c "$src/eagl.c" -o "$out/eagl.o"
fi
xcrun ld -dylib -arch armv7 -segalign 0x1000 -platform_version ios 6.0 6.1 -install_name /private/var/v86/libv86gles.dylib \
    -o "$out/libv86gles.dylib" "$@" -L "$out" -lobjc -lIOKit -lSystem
codesign -f -s - --identifier org.v86.gles --digest-algorithm=sha1,sha256 "$out/libv86gles.dylib"
