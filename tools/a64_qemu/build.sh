#!/bin/bash
# The fixed AArch64 reference (docs/arm64-virt-android16-plan.md P0.11):
# QEMU 9.2.0 built from its release tarball (checked against the SHA-256
# below) with this directory's patches, into build/a64-ref/qemu-9.2.0-install,
# with the TCG plugins the measurements use (contrib/plugins execlog and
# howvec, tests/tcg/plugins insn). Homebrew's QEMU follows the latest release
# and cannot be pinned. Only aarch64-softmmu: QEMU's linux-user targets do not
# build on macOS.
#
# usage: tools/a64_qemu/build.sh
#   The tarball is build/a64-ref/qemu-9.2.0.tar.xz (or A64_QEMU_TARBALL); it is
#   downloaded from download.qemu.org only with A64_QEMU_DOWNLOAD=1. The build
#   needs Python's distlib, installed into build/a64-ref/pyenv.
set -euo pipefail

version=9.2.0
sha256=f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894
here="$(cd "$(dirname "$0")"; pwd)"
ref="$here/../../build/a64-ref"
mkdir -p "$ref"
ref="$(cd "$ref"; pwd)"
tarball="${A64_QEMU_TARBALL:-$ref/qemu-$version.tar.xz}"
src="$ref/qemu-$version"
prefix="$ref/qemu-$version-install"

if [ ! -f "$tarball" ]
then
    if [ "${A64_QEMU_DOWNLOAD:-}" != 1 ]
    then
        echo "$tarball is missing: download https://download.qemu.org/qemu-$version.tar.xz (or set A64_QEMU_DOWNLOAD=1)" >&2
        exit 1
    fi
    curl -fL -o "$tarball" "https://download.qemu.org/qemu-$version.tar.xz"
fi
if [ "$(shasum -a 256 "$tarball" | cut -d' ' -f1)" != "$sha256" ]
then
    echo "$tarball: SHA-256 mismatch" >&2
    exit 1
fi

# a fresh source tree, patched once (the marker names the patches applied)
patches="$(cd "$here"; ls *.patch | sort)"
if [ ! -f "$src/.v86-patches" ] || [ "$(cat "$src/.v86-patches")" != "$patches" ]
then
    rm -rf "$src"
    tar -xJf "$tarball" -C "$ref"
    for patch in $patches
    do
        patch -p1 -d "$src" < "$here/$patch"
    done
    echo "$patches" > "$src/.v86-patches"
fi

if [ ! -x "$ref/pyenv/bin/python" ]
then
    python3 -m venv "$ref/pyenv"
    "$ref/pyenv/bin/pip" install distlib
fi

mkdir -p "$src/build"
cd "$src/build"
[ -f build.ninja ] || ../configure --python="$ref/pyenv/bin/python" --prefix="$prefix" --target-list=aarch64-softmmu \
    --enable-plugins --disable-docs --disable-werror
ninja install
ninja contrib/plugins/libexeclog.dylib contrib/plugins/libhowvec.dylib tests/tcg/plugins/libinsn.dylib 2>/dev/null ||
    ninja contrib/plugins/libexeclog.so contrib/plugins/libhowvec.so tests/tcg/plugins/libinsn.so
"$prefix/bin/qemu-system-aarch64" --version | head -1
