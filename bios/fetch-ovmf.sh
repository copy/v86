#!/bin/sh
# The UEFI firmware (docs/uefi.md): OVMF of edk2-stable202408, as QEMU 9.2.0
# ships it prebuilt (pc-bios/edk2-x86_64-code.fd and edk2-i386-vars.fd, built
# by QEMU's roms/edk2-build.py from OvmfPkg/OvmfPkgX64.dsc, DEBUG, with
# QEMU's options: network, TLS, TPM2; no Secure Boot or SMM), and the Secure
# Boot build (edk2-x86_64-secure-code.fd: SECURE_BOOT_ENABLE, SMM_REQUIRE, no
# Shell; the same variable store template). Extracts them from the release
# tarball (given, or downloaded) and checks the pinned hashes.
set -eu

QEMU_VERSION=9.2.0
CODE_SHA256=33090cc07675baa5190d9f1e84bf5176b33bcbfa9bacac522961150cdb6dbb2a
VARS_SHA256=5d2ac383371b408398accee7ec27c8c09ea5b74a0de0ceea6513388b15be5d1e
SECURE_CODE_SHA256=32807682a9e5c0e2d192ecb6077941d4be8bcfa6b9cd6e60830c3a9f48c0555a

tarball=${1:-}
if [ -z "$tarball" ]
then
    tarball=qemu-$QEMU_VERSION.tar.xz
    if [ ! -f "$tarball" ]
    then
        curl -fLO "https://download.qemu.org/qemu-$QEMU_VERSION.tar.xz"
    fi
fi

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
tar -xJf "$tarball" -C "$dir" \
    "qemu-$QEMU_VERSION/pc-bios/edk2-x86_64-code.fd.bz2" \
    "qemu-$QEMU_VERSION/pc-bios/edk2-x86_64-secure-code.fd.bz2" \
    "qemu-$QEMU_VERSION/pc-bios/edk2-i386-vars.fd.bz2" \
    "qemu-$QEMU_VERSION/pc-bios/edk2-licenses.txt"
bunzip2 -c "$dir/qemu-$QEMU_VERSION/pc-bios/edk2-x86_64-code.fd.bz2" > "$dir/code.fd"
bunzip2 -c "$dir/qemu-$QEMU_VERSION/pc-bios/edk2-i386-vars.fd.bz2" > "$dir/vars.fd"
bunzip2 -c "$dir/qemu-$QEMU_VERSION/pc-bios/edk2-x86_64-secure-code.fd.bz2" > "$dir/secure-code.fd"

check()
{
    actual=$(shasum -a 256 "$1" | cut -d" " -f1)
    if [ "$actual" != "$2" ]
    then
        echo "$1: sha256 $actual, expected $2" >&2
        exit 1
    fi
}
check "$dir/code.fd" "$CODE_SHA256"
check "$dir/vars.fd" "$VARS_SHA256"
check "$dir/secure-code.fd" "$SECURE_CODE_SHA256"

cp "$dir/code.fd" ovmf-code.fd
cp "$dir/vars.fd" ovmf-vars.fd
cp "$dir/secure-code.fd" ovmf-secure-code.fd
cp "$dir/qemu-$QEMU_VERSION/pc-bios/edk2-licenses.txt" OVMF-LICENSES.txt
echo "ovmf-code.fd, ovmf-vars.fd, ovmf-secure-code.fd: edk2-stable202408 from QEMU $QEMU_VERSION"
