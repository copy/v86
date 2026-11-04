#!/bin/sh
# Build an ARMv7 guest dylib on macOS without an obsolete SDK. The import
# stubs name symbols exported by the owner's iOS 6.1.3 shared cache.
set -eu
out=${1:?usage: build-gles.sh output-directory}
src=$(dirname "$0")
case "${2:-}" in
    "") test "$#" -eq 1; host_contexts= ;;
    --host-contexts|--check-host-contexts) test "$#" -eq 3; host_contexts=$2; cache=$3 ;;
    *) echo "usage: build-gles.sh out [--host-contexts cache-armv7]" >&2; exit 2 ;;
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
stub objc /usr/lib/libobjc.A.dylib '_objc_getClass, _sel_registerName, _class_getInstanceMethod, _method_setImplementation, _method_getImplementation, _class_getInstanceVariable, _ivar_getOffset, _objc_msgSend, _objc_autoreleasePoolPush, _objc_autoreleasePoolPop'
stub IOKit /System/Library/Frameworks/IOKit.framework/Versions/A/IOKit '_IORegistryEntryFromPath, _IORegistryEntryGetProperty, _IOObjectRelease'
node "$src/gles-opcodes.mjs" > "$out/gles-opcodes.h"
compile() {
    xcrun clang -target armv7-apple-ios6.0 -marm -Os -fPIC -ffreestanding -fno-stack-protector -I "$out" "$@"
}
set -- "$out/eagl.o"
if [ -n "$host_contexts" ]; then
    node "$src/gl-frame-wrappers.mjs" "$cache" "$out" --slots-only
    check_flag=
    if [ "$host_contexts" = "--check-host-contexts" ]; then
        compile -c "$src/../../../tests/ios/eagl-context-probe.c" -o "$out/gli-check.o"
        set -- "$@" "$out/gli-check.o"
        check_flag=-DN90_CHECK_CONTEXTS
    fi
    compile -DN90_HOST_CONTEXTS $check_flag -c "$src/eagl.c" -o "$out/eagl.o"
    compile -c "$src/gli-context.c" -o "$out/gli-context.o"
    compile -c "$src/gli-gates.s" -o "$out/gli-gates.o"
    set -- "$@" "$out/gli-context.o" "$out/gli-gates.o"
else
    compile -c "$src/eagl.c" -o "$out/eagl.o"
fi
xcrun ld -dylib -arch armv7 -segalign 0x1000 -platform_version ios 6.0 6.1 -install_name /private/var/v86/libv86gles.dylib \
    -o "$out/libv86gles.dylib" "$@" -L "$out" -lobjc -lIOKit -lSystem
codesign -f -s - --identifier org.v86.gles --digest-algorithm=sha1,sha256 "$out/libv86gles.dylib"
