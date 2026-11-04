#!/bin/sh
# Build an SDK-free, statically linked iOS 6 ARM executable on macOS.
set -eu
out=${1:?usage: build-shell.sh output-directory [--gles|--native-gles cache|--nand]}
mkdir -p "$out"
src=$(dirname "$0")
native_object=
case "${2:-}" in
    "") set -- ;;
    --nand) set -- -DN90_TEST_NAND ;;
    --native-gles)
        node "$src/gl-frame-wrappers.mjs" "${3:?expected the local armv7 shared cache}" "$out"
        xcrun clang -target armv7-apple-ios6.0 -c "$out/gl-frame-wrappers.s" -o "$out/gl-frame-wrappers.o"
        node "$src/gles-opcodes.mjs" > "$out/gles-opcodes.h"
        set -- -mthumb -DN90_TEST_GLES -DN90_NATIVE_GL -I "$out"
        native_object=$out/gl-frame-wrappers.o ;;
    --gles) node "$src/gles-opcodes.mjs" > "$out/gles-opcodes.h"; set -- -mthumb -DN90_TEST_GLES -I "$out" ;;
    *) echo "unknown recovery-shell option" >&2; exit 2 ;;
esac
xcrun clang -target armv7-apple-ios6.0 -marm -Os -ffreestanding -fno-builtin \
    -fno-stack-protector "$@" -c "$src/recovery-shell.c" -o "$out/recovery-shell.o"
set -- "$out/recovery-shell.o"
if [ -n "${native_object:-}" ]; then set -- "$@" "$native_object"; fi
xcrun ld -arch armv7 -static -e _start -platform_version ios 6.0 6.1 \
    -o "$out/recovery-shell" "$@"
codesign -f -s - --identifier org.v86.recovery-shell --digest-algorithm=sha1,sha256 "$out/recovery-shell"
