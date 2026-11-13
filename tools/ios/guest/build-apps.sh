#!/bin/sh
# ARMv7 test applications and native install probe, using local link stubs.
set -eu
out=${1:?usage: build-apps.sh output-directory}
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
stub System /usr/lib/libSystem.B.dylib '_printf, _snprintf, _strcmp, _memcmp, _strlen, _memcpy, _memset, _malloc, _calloc, _free, _open, _close, _read, _write, _fsync, _unlink, _mkdir, _usleep, _sync, _syslog, _dlopen, _dlsym, _dlerror, dyld_stub_binder'
stub objc /usr/lib/libobjc.A.dylib '_objc_getClass, _object_getClass, _sel_registerName, _objc_allocateClassPair, _objc_registerClassPair, _class_addMethod, _objc_msgSend, _objc_autoreleasePoolPush, _objc_autoreleasePoolPop'
stub CoreFoundation /System/Library/Frameworks/CoreFoundation.framework/CoreFoundation '_CFStringCreateWithCString, _CFStringGetCString, _CFDictionaryCreateMutable, _CFDictionarySetValue, _CFDictionaryGetValue, _CFDictionaryGetCount, _CFRelease, _CFShow, _kCFTypeDictionaryKeyCallBacks, _kCFTypeDictionaryValueCallBacks'
stub UIKit /System/Library/Frameworks/UIKit.framework/UIKit '_UIApplicationMain'
stub OpenGLES /System/Library/Frameworks/OpenGLES.framework/OpenGLES '_glGenRenderbuffers, _glBindRenderbuffer, _glGenFramebuffers, _glBindFramebuffer, _glFramebufferRenderbuffer, _glViewport, _glClearColor, _glClear, _glCreateShader, _glShaderSource, _glCompileShader, _glCreateProgram, _glAttachShader, _glBindAttribLocation, _glLinkProgram, _glUseProgram, _glVertexAttribPointer, _glEnableVertexAttribArray, _glDrawArrays, _glGetError'
compile() { xcrun clang -target armv7-apple-ios6.0 -marm -Os -fPIC -ffreestanding -fno-stack-protector -I "$src" "$@"; }
link() { xcrun ld -arch armv7 -segalign 0x1000 -headerpad 0x400 -platform_version ios 6.0 6.1 -L "$out" -lSystem -lobjc -lCoreFoundation "$@"; }
compile -c "$src/app-agent.c" -o "$out/app-agent.o"
link -o "$out/v86-app-agent" "$out/app-agent.o"
codesign -f -s - --identifier org.v86.app-agent --digest-algorithm=sha1,sha256 "$out/v86-app-agent"
for variant in Install GLES2; do
    app="$out/Payload/V86${variant}Test.app"
    mkdir -p "$app"
    flag=
    if [ "$variant" = GLES2 ]; then flag=-DV86_GLES_TEST; fi
    compile $flag -c "$src/test-app.c" -o "$out/test-$variant.o"
    link -o "$app/V86Test" "$out/test-$variant.o" -lUIKit -lOpenGLES
    cat > "$app/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.v86.${variant}Test</string>
<key>CFBundleName</key><string>V86${variant}Test</string>
<key>CFBundleDisplayName</key><string>V86 ${variant} Test</string>
<key>CFBundleExecutable</key><string>V86Test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>MinimumOSVersion</key><string>6.0</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>UIRequiredDeviceCapabilities</key><array><string>armv7</string></array>
</dict></plist>
PLIST
    codesign -f -s - --identifier "org.v86.${variant}Test" --digest-algorithm=sha1,sha256 "$app"
    (cd "$out" && /usr/bin/zip -q -r "V86${variant}Test.ipa" "Payload/V86${variant}Test.app")
done
