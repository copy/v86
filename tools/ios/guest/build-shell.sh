#!/bin/sh
# Build an SDK-free, statically linked iOS 6 ARM executable on macOS.
set -eu
out=${1:?usage: build-shell.sh output-directory [--gles]}
case "${2:-}" in
    "") set -- ;;
    --gles) set -- -DN90_TEST_GLES ;;
    *) echo "unknown recovery-shell option" >&2; exit 2 ;;
esac
mkdir -p "$out"
src=$(dirname "$0")
xcrun clang -target armv7-apple-ios6.0 -marm -Os -ffreestanding -fno-builtin \
    -fno-stack-protector "$@" -c "$src/recovery-shell.c" -o "$out/recovery-shell.o"
xcrun ld -arch armv7 -static -e _start -platform_version ios 6.0 6.1 \
    -o "$out/recovery-shell" "$out/recovery-shell.o"
codesign -f -s - --identifier org.v86.recovery-shell --digest-algorithm=sha1,sha256 "$out/recovery-shell"
