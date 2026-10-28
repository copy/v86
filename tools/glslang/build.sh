#!/bin/sh
# The GLES host's GLSL ES compiler (docs/gles3-plan.md L1): glslang, built
# for WebAssembly with Emscripten, with v86_glslang.cpp's interface:
# bios/glslang.wasm (src/gles/glslang.js loads it). Pinned source, checked;
# one patch (es_spirv.patch: ES 1.00 and 3.00 shaders become SPIR-V under
# Vulkan's relaxed rules, which glslang otherwise refuses below 310 es).
#   tools/glslang/build.sh [work directory, default build/glslang]
# needs emcc (an emsdk: source emsdk_env.sh), cmake and ninja.
set -eu

GLSLANG_VERSION=16.6.0
GLSLANG_SHA256=9c09b901149c729df745057dafa815278aaa101b84d2b6e14f16a42de52f97f2

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=${1:-$root/build/glslang}
mkdir -p "$work/dl"
cd "$work"

if [ ! -f dl/glslang-$GLSLANG_VERSION.tar.gz ]
then
    curl -fL -o dl/glslang-$GLSLANG_VERSION.tar.gz.part \
        https://github.com/KhronosGroup/glslang/archive/refs/tags/$GLSLANG_VERSION.tar.gz
    mv dl/glslang-$GLSLANG_VERSION.tar.gz.part dl/glslang-$GLSLANG_VERSION.tar.gz
fi
actual=$(shasum -a 256 dl/glslang-$GLSLANG_VERSION.tar.gz | cut -d" " -f1)
if [ "$actual" != "$GLSLANG_SHA256" ]
then
    echo "dl/glslang-$GLSLANG_VERSION.tar.gz: sha256 $actual, expected $GLSLANG_SHA256" >&2
    exit 1
fi

rm -rf src build-wasm && mkdir src build-wasm
tar -xzf dl/glslang-$GLSLANG_VERSION.tar.gz -C src
glslang=$work/src/glslang-$GLSLANG_VERSION
(cd "$glslang" && patch -p1 < "$here/es_spirv.patch")

# GLSL in, SPIR-V out: no HLSL, no optimizer (SPIRV-Tools), no binaries or tests
(cd build-wasm &&
    emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_OPT=OFF -DENABLE_HLSL=OFF \
        -DENABLE_GLSLANG_BINARIES=OFF -DGLSLANG_TESTS=OFF -DBUILD_EXTERNAL=OFF -DGLSLANG_ENABLE_INSTALL=OFF \
        -DENABLE_PCH=OFF "$glslang" &&
    ninja)

b=$work/build-wasm
em++ -O2 -std=c++17 -fno-exceptions -I"$glslang" -I"$b" -I"$b/include" "$here/v86_glslang.cpp" \
    "$b/glslang/libglslang.a" "$b/glslang/libMachineIndependent.a" "$b/glslang/libGenericCodeGen.a" \
    "$b/glslang/OSDependent/Unix/libOSDependent.a" "$b/glslang/libglslang-default-resource-limits.a" "$b/SPIRV/libSPIRV.a" \
    -o glslang.wasm --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=8MB -sSTACK_SIZE=1MB

cp glslang.wasm "$root/bios/glslang.wasm"
{
    echo "bios/glslang.wasm: glslang $GLSLANG_VERSION with tools/glslang/es_spirv.patch, tools/glslang/build.sh"
    echo
    echo "==> glslang/LICENSE.txt <=="
    cat "$glslang/LICENSE.txt"
} > "$root/bios/GLSLANG-LICENSES.txt"
echo "bios/glslang.wasm: $(shasum -a 256 glslang.wasm | cut -d" " -f1)"
