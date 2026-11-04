#!/bin/sh
# Build an ARMv7 guest dylib on macOS without an obsolete SDK. The import
# stubs name symbols exported by the owner's iOS 6.1.3 shared cache.
set -eu
out=${1:?usage: build-gles.sh output-directory}
src=$(dirname "$0")
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
stub System /usr/lib/libSystem.B.dylib '_getpid, _syslog, dyld_stub_binder'
stub objc /usr/lib/libobjc.A.dylib '_objc_getClass, _sel_registerName, _class_getInstanceMethod, _method_setImplementation'
stub IOKit /System/Library/Frameworks/IOKit.framework/Versions/A/IOKit '_IORegistryEntryFromPath, _IORegistryEntryGetProperty, _IOObjectRelease'
node "$src/gles-opcodes.mjs" > "$out/gles-opcodes.h"
xcrun clang -target armv7-apple-ios6.0 -marm -Os -fPIC -ffreestanding -fno-stack-protector \
    -I "$out" -c "$src/eagl.c" -o "$out/eagl.o"
xcrun ld -dylib -arch armv7 -segalign 0x1000 -platform_version ios 6.0 6.1 -install_name /private/var/v86/libv86gles.dylib \
    -o "$out/libv86gles.dylib" "$out/eagl.o" -L "$out" -lobjc -lIOKit -lSystem
codesign -f -s - --identifier org.v86.gles --digest-algorithm=sha1,sha256 "$out/libv86gles.dylib"
