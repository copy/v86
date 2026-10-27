#!/bin/sh
# The TPM 2.0 of v86's TPM device (docs/tpm.md): libtpms with OpenSSL's
# libcrypto, built for WebAssembly with Emscripten, and v86_tpm.c's
# interface: bios/libtpms.wasm. Pinned sources, checked; one patch
# (emscripten.patch: libtpms's byte order check knows Emscripten).
#   tools/libtpms/build.sh [work directory, default build/libtpms]
# needs emcc (an emsdk: source emsdk_env.sh), autoreconf, automake and
# libtool (glibtoolize on macOS).
set -eu

LIBTPMS_VERSION=0.10.2
LIBTPMS_SHA256=edac03680f8a4a1c5c1d609a10e3f41e1a129e38ff5158f0c8deaedc719fb127
OPENSSL_VERSION=3.5.9
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=${1:-$root/build/libtpms}
mkdir -p "$work/dl"
cd "$work"

fetch()
{
    if [ ! -f "dl/$1" ]
    then
        curl -fL -o "dl/$1.part" "$2"
        mv "dl/$1.part" "dl/$1"
    fi
    actual=$(shasum -a 256 "dl/$1" | cut -d" " -f1)
    if [ "$actual" != "$3" ]
    then
        echo "dl/$1: sha256 $actual, expected $3" >&2
        exit 1
    fi
}
fetch libtpms-$LIBTPMS_VERSION.tar.gz https://codeload.github.com/stefanberger/libtpms/tar.gz/refs/tags/v$LIBTPMS_VERSION $LIBTPMS_SHA256
fetch openssl-$OPENSSL_VERSION.tar.gz https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz $OPENSSL_SHA256

rm -rf src && mkdir src
tar -xzf dl/libtpms-$LIBTPMS_VERSION.tar.gz -C src
tar -xzf dl/openssl-$OPENSSL_VERSION.tar.gz -C src
openssl=$work/src/openssl-$OPENSSL_VERSION
libtpms=$work/src/libtpms-$LIBTPMS_VERSION

# libcrypto alone: no assembler, threads, sockets or loadable modules
(cd "$openssl" &&
    CC=emcc AR=emar RANLIB=emranlib ./Configure linux-generic32 no-asm no-threads no-shared no-dso no-engine \
        no-ui-console no-tests no-apps no-sock no-afalgeng no-async no-docs no-module &&
    make -j4 build_generated libcrypto.a)

# libtpms, TPM 2.0 only; longjmp as WebAssembly exceptions (no JS glue)
(cd "$libtpms" &&
    patch -p1 < "$here/emscripten.patch" &&
    LIBTOOLIZE=${LIBTOOLIZE:-$(command -v libtoolize || command -v glibtoolize)} NOCONFIGURE=1 ./autogen.sh &&
    emconfigure ./configure --host=wasm32-unknown-emscripten --with-openssl --with-tpm2 --without-tpm1 \
        --disable-shared --enable-static CFLAGS="-O2 -sSUPPORT_LONGJMP=wasm" CPPFLAGS="-I$openssl/include" LDFLAGS="-L$openssl" &&
    emmake make -j4 -C src)

# (function pointer casts emulated: libtpms calls OpenSSL's hash functions
# through pointers of other signatures, which WebAssembly's indirect calls trap on)
emcc -O2 -sSUPPORT_LONGJMP=wasm -sEMULATE_FUNCTION_POINTER_CASTS -I"$libtpms/include" "$here/v86_tpm.c" \
    "$libtpms/src/.libs/libtpms.a" "$libtpms/src/.libs/libtpms_tpm2.a" "$openssl/libcrypto.a" \
    -o libtpms.wasm --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=4MB -sSTACK_SIZE=256KB \
    -sEXPORTED_FUNCTIONS=_v86_tpm_alloc,_v86_tpm_free,_v86_tpm_set_blob,_v86_tpm_init,_v86_tpm_terminate,_v86_tpm_process,_v86_tpm_response,_v86_tpm_cancel,_v86_tpm_get_state,_v86_tpm_state

cp libtpms.wasm "$root/bios/libtpms.wasm"
{
    echo "bios/libtpms.wasm: libtpms $LIBTPMS_VERSION (TPM 2.0) with OpenSSL $OPENSSL_VERSION's libcrypto, tools/libtpms/build.sh"
    echo
    echo "==> libtpms/LICENSE <=="
    cat "$libtpms/LICENSE"
    echo
    echo "==> openssl/LICENSE.txt <=="
    cat "$openssl/LICENSE.txt"
} > "$root/bios/LIBTPMS-LICENSES.txt"
echo "bios/libtpms.wasm: $(shasum -a 256 libtpms.wasm | cut -d" " -f1)"
