#!/bin/sh
# Builds the gfxstream oracle (oracle.cpp) from the guest's marshaling C++:
# the files are copied beside the oracle's stubs (its VulkanStreamGuest.h,
# Resources.h), which a quoted include would otherwise miss.
#
# usage: tools/gfxstream_oracle/build.sh <mesa src/gfxstream> <mesa include> [out]
set -e
GFX=$1
INCLUDE=$2
OUT=${3:-build/gfxstream-oracle/oracle}
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=$(dirname "$OUT")/src
rm -rf "$DIR"
mkdir -p "$DIR"
ENC=$GFX/guest/vulkan_enc
cp "$ENC"/goldfish_vk_marshaling_guest.* "$ENC"/goldfish_vk_reserved_marshaling_guest.* "$ENC"/goldfish_vk_extension_structs_guest.* \
    "$ENC"/goldfish_vk_private_defs.h "$ENC"/vk_android_native_buffer_gfxstream.h "$ENC"/vk_platform_compat.h \
    "$ENC"/vulkan_gfxstream.h "$ENC"/vulkan_gfxstream_structure_type.h "$ENC"/VulkanHandles.h \
    "$ENC"/VulkanHandleMapping.h "$ENC"/VulkanHandleMapping.cpp \
    "$GFX"/aemu/include/Stream.h "$GFX"/aemu/Stream.cpp "$DIR"/
cp -R "$HERE"/stub/* "$DIR"/
c++ -std=c++17 -w -O1 -DVK_USE_PLATFORM_ANDROID_KHR -DVK_GFXSTREAM_STRUCTURE_TYPE_EXT -I "$DIR" -I "$INCLUDE" -o "$OUT" \
    "$HERE"/oracle.cpp "$DIR"/goldfish_vk_marshaling_guest.cpp "$DIR"/goldfish_vk_reserved_marshaling_guest.cpp \
    "$DIR"/goldfish_vk_extension_structs_guest.cpp "$DIR"/VulkanHandleMapping.cpp "$DIR"/Stream.cpp
echo "$OUT"
