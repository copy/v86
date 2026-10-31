#!/bin/sh
# E0 isolated experiment. Reuse pinned static libraries, never replace bios/.
# Usage: sh tools/glslang/build_desktop_spirv_prototype.sh CACHE [WORK]
# CACHE is a completed tools/glslang/build.sh directory; EMXX selects em++.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cache=$(cd "$1" && pwd)
work=${2:-$root/build/gl-e0-repro}
archive=$cache/dl/glslang-16.6.0.tar.gz
expected=9c09b901149c729df745057dafa815278aaa101b84d2b6e14f16a42de52f97f2
actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
test "$actual" = "$expected"
test ! -e "$work/src"
mkdir -p "$work/src"
tar -xzf "$archive" -C "$work/src"
source_dir=$work/src/glslang-16.6.0
for patch_name in es_spirv desktop_lod desktop_spirv_prototype; do
    (cd "$source_dir" && patch -p1 < "$here/$patch_name.patch")
done
cp "$here/v86_glslang.cpp" "$work/v86_glslang.cpp"
(cd "$work" && patch -p1 < "$here/desktop_spirv_driver.patch")
b=$cache/build-wasm
compiler=${EMXX:-em++}
for source_name in ShaderLang Initialize Scan; do
    "$compiler" -O2 -std=c++17 -DNDEBUG -DENABLE_OPT=0 -DENABLE_SPIRV -DGLSLANG_OSINCLUDE_UNIX -fno-exceptions \
        -I"$source_dir" -I"$b" -I"$b/include" -c "$source_dir/glslang/MachineIndependent/$source_name.cpp" -o "$work/$source_name.o"
done
"$compiler" -O2 -std=c++17 -DNDEBUG -DENABLE_OPT=0 -DENABLE_SPIRV -DGLSLANG_OSINCLUDE_UNIX -fno-exceptions \
    -I"$source_dir" -I"$b" -I"$b/include" -I"$here" "$work/v86_glslang.cpp" "$work/ShaderLang.o" "$work/Initialize.o" "$work/Scan.o" \
    "$b/glslang/libglslang.a" "$b/glslang/libMachineIndependent.a" "$b/glslang/libGenericCodeGen.a" \
    "$b/glslang/OSDependent/Unix/libOSDependent.a" "$b/glslang/libglslang-default-resource-limits.a" "$b/SPIRV/libSPIRV.a" \
    -o "$work/desktop_spirv.wasm" --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=8MB -sSTACK_SIZE=1MB
shasum -a 256 "$archive" "$here/"*.patch "$here/desktop_spirv_lowering.hpp" "$here/v86_glslang.cpp" \
    "$b/glslang/"*.a "$b/glslang/OSDependent/Unix/"*.a "$b/SPIRV/libSPIRV.a" \
    "$work/desktop_spirv.wasm" "$root/bios/glslang.wasm" > "$work/input-output-sha256.txt"
cat "$work/input-output-sha256.txt"
