#!/usr/bin/env node
// x86_64 Linux (Alpine 3.24, the official virt ISO) on a display adapter:
// installs Mesa and the GPU test programs from build/x64-linux/gpu-repo.tar
// (tools/alpine_repo.mjs), loads the adapter's DRM driver and runs the
// steps of a scenario on the serial console, saving screenshots.
//
//     GPU_ADAPTER=bochs_vga node tests/x64/linux_gpu.mjs
//
// GPU_ARCH=aarch64 (tests/a64/linux_gpu.mjs; docs/arm64-virt-android16-plan.md
// P7.2): the same scenarios on the arm64 virt machine with virtio_gpu (no
// VGA), from build/a64-linux/ (gpu-repo.tar from `tools/alpine_repo.mjs
// --arch aarch64`); the ISO, the repository and the test programs on
// virtio-blk disks, found by their serials; the GPU on the PCIe host
// (GPU_TRANSPORT=mmio: on virtio-mmio, without host visible memory); the
// page tier (GPU_NO_JIT=1: the interpreter)
//
// GPU_ADAPTER: bochs_vga (default), vmware_svga, virtio_gpu
// GPU_SCENARIO: the steps below: drm (default), gl, sm41, sm5, gltest, virgl, venus, resize, kms, input (the virt machine);
// custom: the steps in the JSON file GPU_STEPS
// GPU_LEVEL: pins the adapter's level (graphics_adapter_test), e.g. 2d or 2d-full;
// vgpu9 records the 3D batches into <out>/trace.bin (tests/x64/gpu_trace.mjs),
// or with GPU_RENDERER=chrome draws them on the GPU of a headless Chrome
// GPU_OUT: the output directory (default build/x64-linux/gpu-<adapter>[-<level>]/)
// SHOW_LOGS=1: echo the serial console; LINUX_GPU_TIMEOUT: ms (default 900000);
// GPU_SCREENSHOT_AFTER: ms from a step's command to its screenshot, for every step
// LINUX_GPU_MEMORY: MiB (default 1024; 1536 for the virgl and vkcube scenarios and on arm64)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { create_trace_renderer } from "./gpu_trace.mjs";
import { create_remote_renderer } from "./gpu_remote_renderer.mjs";
import { IMAGES, directory_of } from "../lib/alpine_image.mjs";
import { PictureSink, save_png } from "../lib/picture_sink.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const arch = process.env.GPU_ARCH || "x86_64";
assert.ok(arch === "x86_64" || arch === "aarch64", "GPU_ARCH is x86_64 or aarch64");
const arm = arch === "aarch64";
// (the pinned ISO and its unpacked files: tests/lib/alpine_image.mjs)
const directory = directory_of(arch);
const adapter = process.env.GPU_ADAPTER || (arm ? "virtio_gpu" : "bochs_vga");
assert.ok(!arm || adapter === "virtio_gpu", "the virt machine has virtio_gpu only");
const scenario = process.env.GPU_SCENARIO || "drm";
const out = process.env.GPU_OUT || path.join(directory, "gpu-" + adapter + (process.env.GPU_LEVEL ? "-" + process.env.GPU_LEVEL : ""));
fs.mkdirSync(out, { recursive: true });

const iso = directory + IMAGES[arch + "-virt"].name;
const repo = directory + "gpu-repo.tar";
for(const file of [iso, directory + "boot/vmlinuz-virt", directory + "boot/initramfs-virt"])
{
    assert.ok(fs.existsSync(file), file + " is missing: run tests/x64/linux_boot.mjs once (X64_LINUX_PREPARE_ONLY=1)");
}
assert.ok(fs.existsSync(repo), repo + " is missing: run tools/alpine_repo.mjs");

const DRIVER = { bochs_vga: "bochs", vmware_svga: "vmwgfx", virtio_gpu: "virtio_gpu" }[adapter];
// the levels with 3D (vmware_svga's vgpu9 and up)
const LEVEL_3D = ["vgpu9", "gb9", "dx10", "dx10.1", "dx11", "dx11-full", "virgl", "virgl43", "virgl43-blob", "virgl43-hostmem",
    "venus"].includes(process.env.GPU_LEVEL);
assert.ok(DRIVER, "GPU_ADAPTER is bochs_vga, vmware_svga or virtio_gpu");

const APK = "apk add --no-network --repository /mnt/repo/main --repository /mnt/repo/community";
// Alpine 3.23's Mesa (25.2), which has the virgl driver 3.24's (26.1)
// lacks: from a pinned (tagged) repository, so that nothing else comes from it
const APK_VIRGL = "printf '@v323 /mnt/repo/v3.23/main\\n@v323 /mnt/repo/v3.23/community\\n' >> /etc/apk/repositories; " + APK +
    " mesa@v323 mesa-dri-gallium@v323 mesa-gbm@v323 mesa-egl@v323 mesa-gl@v323 mesa-gles@v323 llvm21-libs@v323";
const SCENARIOS = {
    // KMS through the adapter's DRM driver: modes, a test pattern, kmscube
    drm: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " kmscube libdrm-tests mesa-dri-gallium mesa-utils >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; tail -15 /tmp/apk.log", /STEP_APK_RC=0/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        [`dmesg | grep -i -E '${DRIVER}|drm' | tail -40; echo STEP_DMESG_DONE`, /STEP_DMESG_DONE/],
        ["modetest -c 2>&1 | head -30; echo STEP_MODES_DONE", /STEP_MODES_DONE/],
        ["SCREENSHOT console", null],
        // (a screenshot 20 s into the command, while it draws)
        // (with 3D the 400 frames take seconds, not a minute)
        ["kmscube -c 400 2>&1 | grep -E 'Rendered|renderer'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube", after: LEVEL_3D ? 2500 : 20000 }],
    ],
    // OpenGL beyond kmscube: the version Mesa reports on GBM, a textured
    // kmscube, and weston on DRM with its EGL and shm clients
    gl: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " kmscube mesa-dri-gallium mesa-utils mesa-demos weston weston-backend-drm weston-shell-desktop " +
            "weston-clients seatd >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; grep -i error /tmp/apk.log | head -5; " +
            "command -v eglinfo kmscube weston weston-simple-egl seatd >/dev/null && echo STEP_APK_PROGRAMS", /STEP_APK_PROGRAMS/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["eglinfo -B -p gbm 2>&1 | grep -E 'OpenGL|renderer|version' | head -12; echo STEP_EGLINFO_DONE",
            LEVEL_3D ? /OpenGL core profile version: (3\.[3-9]|4\.)/ : /STEP_EGLINFO_DONE/],
        ["kmscube -M rgba -c 200 2>&1 | grep -E 'Rendered|renderer'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube-rgba", after: LEVEL_3D ? 2500 : 20000 }],
        ["seatd -g video >/tmp/seatd.log 2>&1 & sleep 1; export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 $XDG_RUNTIME_DIR; " +
            "(weston --backend=drm --shell=desktop --idle-time=0 --continue-without-input >/tmp/weston.log 2>&1 &); sleep 15; export WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 '^wayland-[0-9]*$'); echo $WAYLAND_DISPLAY; " +
            "[ -n \"$WAYLAND_DISPLAY\" ] || { tail -25 /tmp/weston.log /tmp/seatd.log; ps; dmesg | tail -15; }; echo STEP_WESTON_UP",
            /wayland-\d[\s\S]*STEP_WESTON_UP/],
        ["timeout 20 weston-simple-egl -f 2>&1 | tail -3; echo STEP_EGL_DONE", /STEP_EGL_DONE/,
            { screenshot: "weston-simple-egl", after: 12000 }],
        ["timeout 10 weston-simple-shm 2>&1 | tail -3; echo STEP_SHM_DONE", /STEP_SHM_DONE/,
            { screenshot: "weston-simple-shm", after: 6000 }],
        ["grep -i -E 'error|renderer|GL version|EGL' /tmp/weston.log | head -20; echo STEP_WESTON_LOG", /STEP_WESTON_LOG/],
        // the page's size changes (virtio_gpu tells the guest; the others ignore it)
        ["HOST set_display_size 1280 800", null],
        ["sleep 10; tail -6 /tmp/weston.log; echo STEP_WESTON_RESIZE", /STEP_WESTON_RESIZE/, { screenshot: "weston-host-resize", after: 9000 }],
    ],
    // shader model 4.1 (vmware_svga's dx10.1): vmwgfx makes SM4_1 contexts,
    // Mesa offers what that adds to GL 3.3 (Mesa's svga needs SM5 for GL 4),
    // and multisamples: kmscube with 4x MSAA
    sm41: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " kmscube mesa-dri-gallium mesa-utils >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; tail -5 /tmp/apk.log", /STEP_APK_RC=0/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["dmesg | grep -i -E 'shader model|dx2|capabilities' | tail -8; echo STEP_DMESG_DONE", /shader model: SM4_1[\s\S]*STEP_DMESG_DONE/],
        ["eglinfo -B -p gbm 2>&1 | grep -E 'OpenGL core profile (version|shading)' | head -4; echo STEP_EGLINFO_DONE",
            /OpenGL core profile version: 3\.3/],
        ["eglinfo -p gbm 2>&1 | grep -o -E 'GL_ARB_(texture_cube_map_array|texture_gather|draw_buffers_blend|sample_shading|texture_query_lod)' | sort -u; echo STEP_EXTENSIONS_DONE",
            /GL_ARB_draw_buffers_blend[\s\S]*GL_ARB_sample_shading[\s\S]*GL_ARB_texture_cube_map_array[\s\S]*GL_ARB_texture_gather[\s\S]*GL_ARB_texture_query_lod/],
        // (it starts slower than without MSAA)
        ["kmscube -s 4 -c 400 2>&1 | grep -E 'Rendered|renderer|samples|failed'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube-msaa", after: 5000 }],
        ["kmscube -M rgba -c 200 2>&1 | grep -E 'Rendered|renderer'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube-rgba", after: 2500 }],
    ],
    // shader model 5 (vmware_svga's dx11): vmwgfx makes SM5 contexts with
    // GL 4.3's extras, Mesa reports GL 4.3 with compute, tessellation,
    // SSBOs and images; kmscube with 8x MSAA
    sm5: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " kmscube mesa-dri-gallium mesa-utils >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; tail -5 /tmp/apk.log", /STEP_APK_RC=0/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["dmesg | grep -i -E 'shader model|dx3' | tail -8; echo STEP_DMESG_DONE", /shader model: SM_5_1X[\s\S]*STEP_DMESG_DONE/],
        ["eglinfo -B -p gbm 2>&1 | grep -E 'OpenGL core profile (version|shading)' | head -4; echo STEP_EGLINFO_DONE",
            /OpenGL core profile version: 4\.3/],
        ["eglinfo -p gbm 2>&1 | grep -o -E 'GL_ARB_(compute_shader|tessellation_shader|shader_storage_buffer_object|shader_image_load_store|gpu_shader5)' | sort -u; echo STEP_EXTENSIONS_DONE",
            /GL_ARB_compute_shader[\s\S]*GL_ARB_gpu_shader5[\s\S]*GL_ARB_shader_image_load_store[\s\S]*GL_ARB_shader_storage_buffer_object[\s\S]*GL_ARB_tessellation_shader/],
        ["kmscube -s 8 -c 400 2>&1 | grep -E 'Rendered|renderer|samples|failed'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube-msaa8", after: 5000 }],
        ["kmscube -M rgba -c 200 2>&1 | grep -E 'Rendered|renderer'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube-rgba", after: 2500 }],
    ],
    // tests/x64/gltest.c on the adapter's 3D driver (virgl, svga): each
    // test's picture compared with llvmpipe's
    gltest: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK_VIRGL + " >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; grep -i -A3 error /tmp/apk.log | head", /STEP_APK_RC=0/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        // (virtio_gpu: its features, and the host visible memory at level virgl43-hostmem)
        ["dmesg | grep -i -E 'features:|host memory window|shader model' | tail -4; echo STEP_DMESG_DONE", /STEP_DMESG_DONE/],
        ["tar -xf /dev/sdb -C /tmp && LIBGL_ALWAYS_SOFTWARE=1 /tmp/gltest ref 2>&1 | grep -E '^GLTEST (renderer|done|egl)|GL error|^shader|^link'; echo STEP_REF_DONE",
            /llvmpipe[\s\S]*STEP_REF_DONE/],
        ["/tmp/gltest cmp >/tmp/gltest.log 2>&1; grep -v '^GLIMG' /tmp/gltest.log; grep -q FAIL /tmp/gltest.log && grep '^GLIMG' /tmp/gltest.log; " +
            "dmesg | grep -i -A2 segfault | tail -4; echo STEP_GLTEST_DONE", /GLTEST done 0 failures[\s\S]*STEP_GLTEST_DONE/],
    ],
    // virtio_gpu's 3D (GPU_LEVEL=virgl): Mesa's virgl driver on the capsets,
    // what it reports, and kmscube
    // (Alpine 3.24's Mesa has no virgl driver: 3.23's, from v3.23/ of the repository)
    virgl: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        ["free -m | head -2; df -m / | tail -1; echo STEP_MEMORY_DONE", /STEP_MEMORY_DONE/],
        [APK_VIRGL + " kmscube mesa-utils mesa-demos weston weston-backend-drm weston-shell-desktop weston-clients seatd " +
            ">/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; grep -i -A3 error /tmp/apk.log | head -20", /STEP_APK_RC=[02]/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["dmesg | grep -i -E 'features:|capset|virgl' | tail -8; echo STEP_DMESG_DONE", /\+virgl[\s\S]*STEP_DMESG_DONE/],
        // which of GL 3.0's and GLES 3.0's prerequisites Mesa does not offer
        ["eglinfo -p gbm 2>&1 | sed -n '/compatibility profile extensions/,/OpenGL ES profile/p' | tr ',' '\\n' | sed 's/^ *//' | sort -u > /tmp/ext.txt; " +
            "for e in GL_ARB_color_buffer_float GL_ARB_depth_buffer_float GL_ARB_half_float_vertex GL_ARB_map_buffer_range " +
            "GL_ARB_shader_texture_lod GL_ARB_texture_float GL_ARB_texture_rg GL_ARB_texture_compression_rgtc GL_EXT_draw_buffers2 " +
            "GL_ARB_framebuffer_object GL_EXT_framebuffer_sRGB GL_EXT_packed_float GL_EXT_texture_array GL_EXT_texture_shared_exponent " +
            "GL_EXT_transform_feedback GL_NV_conditional_render GL_EXT_texture_sRGB GL_EXT_pixel_buffer_object GL_ARB_draw_instanced " +
            "GL_ARB_texture_buffer_object GL_ARB_uniform_buffer_object GL_ARB_texture_rectangle GL_NV_primitive_restart " +
            "GL_ARB_copy_buffer GL_EXT_texture_integer GL_ARB_texture_multisample GL_ARB_depth_clamp GL_ARB_ES3_compatibility " +
            "GL_ARB_draw_elements_base_vertex GL_EXT_provoking_vertex GL_EXT_vertex_array_bgra GL_EXT_texture_snorm " +
            "GL_ARB_seamless_cube_map GL_ARB_sync GL_ARB_fragment_coord_conventions GL_ARB_provoking_vertex " +
            "GL_ARB_blend_func_extended GL_ARB_explicit_attrib_location GL_ARB_occlusion_query2 GL_ARB_sampler_objects " +
            "GL_ARB_shader_bit_encoding GL_ARB_texture_rgb10_a2ui GL_ARB_texture_swizzle GL_ARB_timer_query " +
            "GL_ARB_instanced_arrays GL_ARB_vertex_type_2_10_10_10_rev; do grep -q \"^$e$\" /tmp/ext.txt || echo MISSING $e; done; " +
            "wc -l < /tmp/ext.txt; echo STEP_MISSING_DONE", /STEP_MISSING_DONE/],
        ["HOST stats", null],
        ["eglinfo -B -p gbm 2>&1 | grep -E 'OpenGL.*(renderer|version)' | head -12; echo STEP_EGLINFO_DONE", /virgl[\s\S]*STEP_EGLINFO_DONE/],
        // tests/x64/gltest.c: llvmpipe's pictures, then virgl's compared with them
        ["tar -xf /dev/sdb -C /tmp && LIBGL_ALWAYS_SOFTWARE=1 /tmp/gltest ref 2>&1 | grep -E '^GLTEST (renderer|done|egl)|GL error|^shader|^link'; echo STEP_REF_DONE",
            /llvmpipe[\s\S]*STEP_REF_DONE/],
        ["/tmp/gltest cmp >/tmp/gltest.log 2>&1; grep -v '^GLIMG' /tmp/gltest.log; grep -q FAIL /tmp/gltest.log && grep '^GLIMG' /tmp/gltest.log; echo STEP_GLTEST_DONE",
            /STEP_GLTEST_DONE/],
        ["kmscube -c 300 2>&1 | grep -E 'Rendered|renderer|failed|error' | head -5", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube", after: 4000 }],
        ["kmscube -M rgba -c 300 2>&1 | grep -E 'Rendered|failed|error' | head -5", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube-rgba", after: 4000 }],
        // a snapshot while kmscube draws (the 3D resources and the context
        // go into it and come back), then the tests again
        // (stdin a pipe nothing comes through: kmscube stops at the first input)
        ["sleep 1000 | kmscube -M rgba -c 100000 > /tmp/kmscube.log 2>&1 & sleep 6; echo STEP_BACKGROUND", /STEP_BACKGROUND/],
        ["HOST snapshot", null],
        ["sleep 3; echo STEP_AFTER_SNAPSHOT", /STEP_AFTER_SNAPSHOT/, { screenshot: "kmscube-after-snapshot", after: 2000 }],
        // (it went on drawing: SUBMIT_3D, 519, went on)
        ["HOST stats", null],
        ["pkill kmscube; sleep 1; grep -c Rendered /tmp/kmscube.log; tail -2 /tmp/kmscube.log; echo STEP_KILLED", /STEP_KILLED/],
        ["/tmp/gltest cmp 2>&1 | grep -E 'FAIL|done'; echo STEP_GLTEST_AGAIN", /GLTEST done 0 failures[\s\S]*STEP_GLTEST_AGAIN/],
        ["seatd -g video >/tmp/seatd.log 2>&1 & sleep 1; export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 $XDG_RUNTIME_DIR; " +
            "(weston --backend=drm --shell=desktop --idle-time=0 --continue-without-input >/tmp/weston.log 2>&1 &); sleep 15; export WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 '^wayland-[0-9]*$'); echo $WAYLAND_DISPLAY; " +
            "[ -n \"$WAYLAND_DISPLAY\" ] || { tail -25 /tmp/weston.log /tmp/seatd.log; ps; dmesg | tail -15; }; echo STEP_WESTON_UP",
            /wayland-\d[\s\S]*STEP_WESTON_UP/],
        ["timeout 20 weston-simple-egl -f 2>&1 | tail -3; echo STEP_EGL_DONE", /STEP_EGL_DONE/,
            { screenshot: "weston-simple-egl", after: 12000 }],
        ["timeout 15 es2gears_wayland 2>&1 | tail -3; echo STEP_GEARS_DONE", /STEP_GEARS_DONE/,
            { screenshot: "es2gears", after: 10000 }],
        ["grep -i -E 'error|renderer|GL version|EGL' /tmp/weston.log | head -20; echo STEP_WESTON_LOG", /STEP_WESTON_LOG/],
    ],
    // virtio_gpu's Vulkan (GPU_LEVEL=venus): Mesa's venus driver on the
    // device's Venus contexts (src/graphics_adapters/virtio_gpu/venus.js),
    // what vulkaninfo reports, next to lavapipe's
    venus: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " mesa-vulkan-virtio mesa-vulkan-swrast vulkan-loader vulkan-tools >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; " +
            "grep -i -A3 error /tmp/apk.log | head; ls /usr/share/vulkan/icd.d/", /STEP_APK_RC=0/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["dmesg | grep -i -E 'features:|capset|host memory window' | tail -6; echo STEP_DMESG_DONE", /\+context_init[\s\S]*STEP_DMESG_DONE/],
        ["VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json vulkaninfo --summary > /tmp/lvp.txt 2>&1; echo rc=$?; " +
            "grep -E 'apiVersion|deviceName|driverName' /tmp/lvp.txt || head -30 /tmp/lvp.txt; echo STEP_LAVAPIPE_DONE", /STEP_LAVAPIPE_DONE/],
        ["VN_DEBUG=init VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json vulkaninfo --summary 2>&1 | tail -40; echo STEP_SUMMARY_DONE",
            /Venus[\s\S]*STEP_SUMMARY_DONE/],
        ["HOST stats", null],
        ["VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json vulkaninfo > /tmp/vulkaninfo.txt 2>&1; echo STEP_VULKANINFO_RC=$?; " +
            "wc -l < /tmp/vulkaninfo.txt; grep -i -E 'error|abort|fail' /tmp/vulkaninfo.txt | head -10", /STEP_VULKANINFO_RC=0/],
        // tests/x64/vktest.c: lavapipe's results, then Venus's (a real GPU:
        // GPU_RENDERER=chrome). On arm64, Alpine 3.24's lavapipe crashes in the
        // tests whose meta operations compile shaders (blit, resolve, ...; on
        // QEMU too): there it runs a test a process and Venus must pass them
        // all (vktest checks each result itself, its expectations lavapipe's on x86_64)
        ...(arm ? [
            ["tar -xf /dev/sdb -C /tmp && for t in $(/tmp/vktest list); do VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json " +
                "/tmp/vktest $t > /tmp/lvp-$t.log 2>&1; echo \"VKTEST-LVP $t rc=$? $(grep -E 'VKTEST '$t' (ok|FAIL)' /tmp/lvp-$t.log)\"; done; echo STEP_LVP_DONE",
                /STEP_LVP_DONE/],
            ["VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json /tmp/vktest " + (process.env.VKTEST_ONLY || "") +
                " 2>&1 | grep -E 'VKTEST|rror|abort'; echo STEP_VKTEST_DONE",
                /VKTEST done 0 failures[\s\S]*STEP_VKTEST_DONE/],
        ] : [
            ["tar -xf /dev/sdb -C /tmp && for t in " + (process.env.VKTEST_ONLY || "\"\"") + "; do VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json /tmp/vktest $t" +
                " 2>&1 | grep VKTEST; done; echo STEP_LVP_DONE",
                /VKTEST done[\s\S]*STEP_LVP_DONE/],
            ["VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json /tmp/vktest " + (process.env.VKTEST_ONLY || "") +
                " 2>&1 | grep -E 'VKTEST|rror|abort'; echo STEP_VKTEST_DONE",
                /STEP_VKTEST_DONE/],
        ]),
        ["HOST stats", null],
    ],
    // Venus's WSI (GPU_LEVEL=venus): vkcube on weston, through the driver's
    // software WSI (no dma-buf: each frame copied into a host visible buffer,
    // then into weston's wl_shm buffer); weston draws with pixman (Alpine
    // 3.24's Mesa has no GL driver for virtio-gpu)
    vkcube: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        // (the repository lacks two install_if packages: seatd-openrc, gstreamer-ptp-helper)
        [APK + " mesa-vulkan-virtio mesa-vulkan-swrast vulkan-loader vulkan-tools weston weston-backend-drm weston-shell-desktop seatd >/tmp/apk.log 2>&1; " +
            "echo STEP_APK_RC=$?; grep -i error /tmp/apk.log | head -5; command -v weston vkcube seatd >/dev/null && echo STEP_APK_PROGRAMS", /STEP_APK_PROGRAMS/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json vulkaninfo 2>/dev/null | grep -E '(VK_KHR_swapchain|VK_KHR_external_semaphore_fd|VK_KHR_external_fence_fd) ' | sort -u; " +
            "echo STEP_EXTENSIONS_DONE", /VK_KHR_swapchain[\s\S]*STEP_EXTENSIONS_DONE/],
        ["seatd -g video >/tmp/seatd.log 2>&1 & sleep 1; export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 $XDG_RUNTIME_DIR; " +
            "(weston --backend=drm --renderer=pixman --shell=desktop --idle-time=0 --continue-without-input >/tmp/weston.log 2>&1 &); sleep 15; " +
            "export WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 '^wayland-[0-9]*$'); echo $WAYLAND_DISPLAY; " +
            "[ -n \"$WAYLAND_DISPLAY\" ] || { tail -25 /tmp/weston.log /tmp/seatd.log; ps; dmesg | tail -15; }; echo STEP_WESTON_UP",
            /wayland-\d[\s\S]*STEP_WESTON_UP/],
        // what the Wayland surface offers (formats, present modes, extents)
        ["VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json vulkaninfo 2>&1 | sed -n '/Presentable Surfaces/,/Device Properties and Extensions/p' | " +
            "grep -v -E '^\\s*$' | head -60; echo STEP_SURFACE_DONE", /STEP_SURFACE_DONE/],
        // (lavapipe's first: vkcube itself on this weston)
        ["VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json timeout 60 vkcube --wsi wayland --c 20 > /tmp/vkcube-lvp.log 2>&1; " +
            "echo STEP_LVP_RC=$?; tail -5 /tmp/vkcube-lvp.log; dmesg | grep -i segfault | tail -3", /STEP_LVP_RC=/],
        // (frames per second: the frames over the seconds they took)
        ["S=$(date +%s); MESA_LOG_LEVEL=debug VN_DEBUG=result VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json timeout 120 vkcube --wsi wayland --c " +
            (process.env.VKCUBE_FRAMES || 1000) + " > /tmp/vkcube.log 2>&1; echo STEP_VKCUBE_RC=$? seconds=$(($(date +%s) - S)); tail -15 /tmp/vkcube.log; " +
            "dmesg | grep -i segfault | tail -2", /STEP_VKCUBE_RC=0/,
            { screenshot: "vkcube", after: 12000 }],
        ["HOST stats", null],
        // a snapshot while vkcube draws: the Venus context, its objects
        // and the GPU's contents go into it and come back; vkcube goes on
        ["(VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json vkcube --wsi wayland --c 1000000 > /tmp/vkcube-bg.log 2>&1 &); " +
            "sleep 8; echo STEP_BACKGROUND", /STEP_BACKGROUND/, { screenshot: "vkcube-before-snapshot", after: 7000 }],
        ["HOST snapshot", null],
        ["sleep 6; echo STEP_AFTER_SNAPSHOT", /STEP_AFTER_SNAPSHOT/, { screenshot: "vkcube-after-snapshot", after: 5000 }],
        ["HOST stats", null],
        ["pidof vkcube && echo STEP_VKCUBE_ALIVE; pkill vkcube; sleep 1; tail -5 /tmp/vkcube-bg.log; echo STEP_KILLED", /STEP_VKCUBE_ALIVE[\s\S]*STEP_KILLED/],
        ["grep -i -E 'error|warn' /tmp/weston.log | head -10; echo STEP_WESTON_LOG", /STEP_WESTON_LOG/],
    ],
    // what Android's graphics needs of the kernel's KMS (docs/arm64-virt-android16-plan.md
    // P7.3; GPU_LEVEL=virgl43-hostmem, for the fences): the planes (a primary
    // and a cursor), an atomic mode set, the cursor, dma-buf PRIME from GBM
    // to weston (linux-dmabuf) and explicit synchronization with sync files
    // (EGL_ANDROID_native_fence_sync, weston's linux-explicit-synchronization)
    kms: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK_VIRGL + " libdrm-tests mesa-utils weston weston-backend-drm weston-shell-desktop weston-clients seatd " +
            ">/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; command -v modetest weston weston-simple-dmabuf-egl eglinfo >/dev/null && echo STEP_APK_PROGRAMS",
            /STEP_APK_PROGRAMS/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["modetest -M virtio_gpu -p 2>&1 | grep -E -A2 '^[0-9]+\\s+[0-9]+\\s+[0-9]+' | head -12; " +
            "modetest -M virtio_gpu -p | awk '/^Planes:/ {p=1} p && /^[0-9]/ {n++} END {print \"STEP_PLANES \" n}'",
            /STEP_PLANES [2-9]/],
        // (the connector, the CRTC and the primary plane: an atomic commit of
        // the mode and the plane with modetest's test pattern)
        ["C=$(modetest -M virtio_gpu -c | awk '$3==\"connected\" {print $1; exit}'); " +
            "R=$(modetest -M virtio_gpu -p | awk '/^CRTCs:/ {c=1; next} c && /^[0-9]/ {print $1; exit}'); " +
            "P=$(modetest -M virtio_gpu -p | awk '/^Planes:/ {p=1; next} p && /^[0-9]/ {print $1; exit}'); echo $C $R $P; " +
            "sleep 10 | modetest -M virtio_gpu -a -s $C@$R:1024x768 -P $P@$R:1024x768 > /tmp/atomic.log 2>&1; head -6 /tmp/atomic.log; " +
            "echo ATOMIC_FAILURES $(grep -c -i -E 'fail|invalid' /tmp/atomic.log); echo STEP_ATOMIC", /ATOMIC_FAILURES 0\r?\nSTEP_ATOMIC/,
            { screenshot: "atomic-modeset", after: 6000 }],
        ["sleep 12 | modetest -M virtio_gpu -s $C:1024x768 -C 2>&1 | head -4; echo STEP_CURSOR", /STEP_CURSOR/,
            { screenshot: "cursor", after: 8000 }],
        ["HOST stats", null],
        ["eglinfo -p gbm 2>&1 | grep -o -E 'EGL_ANDROID_native_fence_sync|EGL_EXT_image_dma_buf_import|EGL_MESA_image_dma_buf_export' | sort -u; echo STEP_EGL_EXTENSIONS",
            /EGL_ANDROID_native_fence_sync[\s\S]*EGL_EXT_image_dma_buf_import[\s\S]*STEP_EGL_EXTENSIONS/],
        ["seatd -g video >/tmp/seatd.log 2>&1 & sleep 1; export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 $XDG_RUNTIME_DIR; " +
            "(weston --backend=drm --shell=desktop --idle-time=0 --continue-without-input >/tmp/weston.log 2>&1 &); sleep 15; export WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 '^wayland-[0-9]*$'); echo $WAYLAND_DISPLAY; " +
            "[ -n \"$WAYLAND_DISPLAY\" ] || { tail -25 /tmp/weston.log /tmp/seatd.log; ps; dmesg | tail -15; }; echo STEP_WESTON_UP",
            /wayland-\d[\s\S]*STEP_WESTON_UP/],
        ["weston-simple-dmabuf-egl --help 2>&1 | head -30; echo STEP_HELP", /STEP_HELP/],
        // (dma-buf from GBM through linux-dmabuf; then with explicit
        // synchronization: acquire and release fences as sync files)
        ["timeout 20 weston-simple-dmabuf-egl 2>&1 | tail -4; echo STEP_DMABUF rc=$?", /STEP_DMABUF/,
            { screenshot: "dmabuf", after: 15000 }],
        ["timeout 20 weston-simple-dmabuf-egl -e 1 2>&1 | tail -4; echo STEP_EXPLICIT", /STEP_EXPLICIT/,
            { screenshot: "dmabuf-explicit-sync", after: 15000 }],
        ["grep -i -E 'dmabuf|explicit|sync|error' /tmp/weston.log | head -12; echo STEP_WESTON_LOG", /explicit sync: yes[\s\S]*STEP_WESTON_LOG/],
        ["HOST stats", null],
    ],
    // input on the desktop (the virt machine's virtio-input, P7.4): weston
    // with its input devices (no --continue-without-input), text typed into
    // weston-terminal (which runs it), the pointer moved and clicked, and
    // two touches on the multi-touch screen read from its evdev node
    input: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " mesa-dri-gallium weston weston-backend-drm weston-shell-desktop weston-terminal weston-clients seatd " +
            ">/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; grep -i error /tmp/apk.log | head -5; " +
            "command -v weston weston-terminal seatd >/dev/null && echo STEP_APK_PROGRAMS", /STEP_APK_PROGRAMS/],
        [`modprobe ${DRIVER}; modprobe evdev; modprobe virtio_input; sleep 2; ls /dev/dri /dev/input; echo STEP_DRM_OK`, /event\d[\s\S]*STEP_DRM_OK/],
        // (the live system has eudev's libudev but no udevd: libinput takes
        // only devices whose udev properties say they are input devices, so
        // the database entries udevd's input_id would write are written here)
        ["mkdir -p /run/udev/data; for e in /sys/class/input/event*; do t=; case \"$(cat $e/device/name)\" in " +
            "*Keyboard) t='ID_INPUT_KEY=1 ID_INPUT_KEYBOARD=1';; *Tablet) t='ID_INPUT_MOUSE=1';; *MultiTouch) t='ID_INPUT_TOUCHSCREEN=1';; esac; " +
            "{ echo I:1; echo E:ID_INPUT=1; for p in $t; do echo E:$p; done; echo G:seat; echo Q:seat; echo V:1; } > /run/udev/data/c$(cat $e/dev); done; " +
            "grep -c ID_INPUT=1 /run/udev/data/c13:*; echo STEP_UDEV_DATA", /STEP_UDEV_DATA/],
        ["seatd -g video >/tmp/seatd.log 2>&1 & sleep 1; export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 $XDG_RUNTIME_DIR; " +
            "(weston --backend=drm --shell=desktop --idle-time=0 >/tmp/weston.log 2>&1 &); sleep 20; export WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 '^wayland-[0-9]*$'); echo $WAYLAND_DISPLAY; " +
            "[ -n \"$WAYLAND_DISPLAY\" ] || { tail -25 /tmp/weston.log /tmp/seatd.log; ps; dmesg | tail -15; }; echo STEP_WESTON_UP",
            /wayland-\d[\s\S]*STEP_WESTON_UP/],
        ["grep -i -E 'input device|keyboard|pointer|touch' /tmp/weston.log | head -12; echo STEP_INPUT_DEVICES",
            /Virtio Keyboard[\s\S]*Virtio Tablet[\s\S]*STEP_INPUT_DEVICES/],
        ["(weston-terminal --shell=/bin/sh >/tmp/terminal.log 2>&1 &); sleep 20; echo STEP_TERMINAL", /STEP_TERMINAL/],
        ["HOST pointer 0.5 0.5", null],
        ["HOST click", null],
        ["HOST type touch /tmp/typed\n", null],
        ["sleep 8; [ -e /tmp/typed ] && echo TYPED_FILE_EXISTS; grep -c SYN_DROPPED /tmp/weston.log; echo STEP_TYPED", /\nTYPED_FILE_EXISTS[\s\S]*STEP_TYPED/,
            { screenshot: "weston-typed", after: 6000 }],
        // (the multi-touch screen's events as the guest's evdev reads them,
        // for 15 s: two touches, tracking IDs 0 and 1, the first at x 0.25
        // (0x2000), BTN_TOUCH down; then both lifted, BTN_TOUCH up)
        ["for e in /sys/class/input/event*; do grep -q MultiTouch $e/device/name && M=/dev/input/${e##*/}; done; " +
            "(timeout 15 dd if=$M bs=24 2>/dev/null | hexdump -v -e '24/1 \"%02x\" \"\\n\"' | sed 's/^/GPU_EVT /' > /tmp/touch.txt &); sleep 2; echo STEP_TOUCH_READY",
            /STEP_TOUCH_READY/],
        ["HOST touch 0.25 0.25 0.75 0.5", null],
        ["HOST touch", null],
        ["sleep 16; cut -c 41- /tmp/touch.txt | tr '\\n' ' '; echo; echo STEP_TOUCHED",
            /0300390000000000 0300350000200000[\s\S]*0300390001000000[\s\S]*01004a0101000000[\s\S]*03003900ffffffff[\s\S]*01004a0100000000[\s\S]*STEP_TOUCHED/],
    ],
    // the page's size reaching the guest (virtio_gpu): a display event, the
    // new preferred mode, which a KMS client then sets
    resize: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " kmscube libdrm-tests mesa-dri-gallium >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; tail -5 /tmp/apk.log", /STEP_APK_RC=0/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        ["dmesg | grep -i -E 'virtio_gpu|virtio-pci|fb0|features:|scanouts' | tail -12; echo STEP_DMESG_DONE", /\+edid[\s\S]*STEP_DMESG_DONE/],
        ["cat /sys/class/drm/card*-Virtual-1/modes | head -3; echo STEP_MODES_DONE", /^1024x768\r?$/m],
        ["SCREENSHOT console", null],
        ["HOST set_display_size 1280 800", null],
        // (sysfs lists what fbdev's probe kept, which is no larger than its
        // frame buffer; a KMS client's probe sees every mode)
        ["sleep 3; modetest -M virtio_gpu -c | grep -m3 -E '#[0-9]+ '; echo STEP_MODES_DONE", /#0 1280x800 [\s\S]*preferred[\s\S]*STEP_MODES_DONE/],
        ["C=$(modetest -M virtio_gpu -c | awk '$3==\"connected\" {print $1; exit}'); sleep 10 | modetest -M virtio_gpu -s $C:1280x800 2>&1 | head -4",
            /setting mode 1280x800/, { screenshot: "modetest-1280x800", after: 7000 }],
        // a snapshot taken and restored with the mode set: the guest carries on
        ["HOST snapshot", null],
        ["SCREENSHOT restored", null],
        ["cat /sys/class/drm/card*-Virtual-1/status; echo STEP_RESTORED", /connected[\s\S]*STEP_RESTORED/],
        ["kmscube -c 100 2>&1 | grep -E 'Rendered|renderer'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube", after: 20000 }],
        // (the commands the guest sent: blob ones at the levels with blobs)
        ["HOST stats", null],
    ],
};
// (GPU_SCENARIO=custom: the steps in the JSON file GPU_STEPS, [command, pattern source, options], for debugging)
if(scenario === "custom")
{
    SCENARIOS.custom = JSON.parse(fs.readFileSync(process.env.GPU_STEPS, "utf8")).map(([command, pattern, options]) =>
        [command, pattern === null ? null : new RegExp(pattern), ...(options ? [options] : [])]);
}
assert.ok(SCENARIOS[scenario], "unknown GPU_SCENARIO " + scenario);
// (the repository's and the test programs' disks: $REPO and $TESTS, set
// after the login; the Vulkan ICDs are the architecture's)
// (the arm64 guest's programs start about three times slower: its sleeps
// and timeouts are three times as long)
const steps = SCENARIOS[scenario].map(([command, ...rest]) => [command.replaceAll("/dev/sda", "$REPO").replaceAll("/dev/sdb", "$TESTS")
    .replaceAll(".x86_64.json", "." + arch + ".json")
    .replace(/\b(sleep|timeout) (\d+)([; ])/g, (match, verb, seconds, after) => arm ? `${verb} ${seconds * 3}${after}` : match), ...rest]);
const DISKS = arm ? "REPO=; TESTS=; for d in /sys/block/vd*; do case \"$(cat $d/serial 2>/dev/null)\" in " +
    "a64gpurepo) REPO=/dev/${d##*/};; a64gputests) TESTS=/dev/${d##*/};; esac; done; echo STEP_DISKS $REPO $TESTS" :
    "REPO=/dev/sda; TESTS=/dev/sdb; echo STEP_DISKS $REPO $TESTS";


const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const sink = new PictureSink();
// A 3D level needs a renderer: the real one in a headless Chrome
// (GPU_RENDERER=chrome, tests/x64/gpu_remote_renderer.mjs), or one that
// records the batches into a trace (tests/x64/gpu_trace.mjs) and renders nothing
// tests/x64/gltest.c for the scenarios that run it (/dev/sdb): built here
// with clang and rust-lld against musl's libc and Mesa's libEGL, taken from
// the repository's Alpine 3.23 packages
function build_gltest()
{
    const dir = directory + "gltest/", sysroot = dir + "sysroot/";
    const run = (program, args) => {
        const result = spawnSync(program, args, { encoding: "utf8" });
        assert.equal(result.status, 0, `${program}: ${result.stderr || result.error}`);
        return result.stdout.trim();
    };
    fs.mkdirSync(sysroot, { recursive: true });
    const packages = directory + "gpu-repo/v3.23/main/" + arch + "/";
    for(const name of fs.readdirSync(packages).filter(f => /^(musl|mesa-egl)-\d.*\.apk$/.test(f)))
    {
        spawnSync("bsdtar", ["-xf", packages + name, "-C", sysroot]);
    }
    const host = run("rustc", ["-vV"]).match(/host: (.+)/)[1];
    const lld = process.env.LD_LLD || `${run("rustc", ["--print", "sysroot"])}/lib/rustlib/${host}/bin/rust-lld`;
    run(process.env.CLANG || "clang", ["--target=" + arch + "-unknown-linux-musl", "-fPIC", "-O1", "-c", root + "tests/x64/gltest.c", "-o", dir + "gltest.o"]);
    run(lld, ["-flavor", "gnu", "-m", LINKER_EMULATION, "-pie", "--dynamic-linker", "/lib/ld-musl-" + arch + ".so.1", "--allow-shlib-undefined",
        "-o", dir + "gltest", dir + "gltest.o", sysroot + "lib/ld-musl-" + arch + ".so.1", sysroot + "usr/lib/libEGL.so.1"]);
    run("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0", "-cf", dir + "gltest.tar", "-C", dir, "gltest"]);
    return dir + "gltest.tar";
}
// tests/x64/vktest.c, for the venus scenario (/dev/sdb): the same way,
// against the Vulkan loader, with third_party/vulkan's headers
function build_vktest()
{
    const dir = directory + "vktest/", sysroot = dir + "sysroot/";
    const run = (program, args) => {
        const result = spawnSync(program, args, { encoding: "utf8" });
        assert.equal(result.status, 0, `${program}: ${result.stderr || result.error}`);
        return result.stdout.trim();
    };
    fs.mkdirSync(sysroot, { recursive: true });
    const packages = directory + "gpu-repo/main/" + arch + "/";
    for(const name of fs.readdirSync(packages).filter(f => /^(musl|vulkan-loader)-\d.*\.apk$/.test(f)))
    {
        spawnSync("bsdtar", ["-xf", packages + name, "-C", sysroot]);
    }
    const host = run("rustc", ["-vV"]).match(/host: (.+)/)[1];
    const lld = process.env.LD_LLD || `${run("rustc", ["--print", "sysroot"])}/lib/rustlib/${host}/bin/rust-lld`;
    // the shaders, as C arrays: tests/x64/vktest_shaders/ by naga (Vulkan GLSL)
    const shaders = [];
    for(const name of fs.readdirSync(root + "tests/x64/vktest_shaders").sort())
    {
        const stage = { vert: "vert", frag: "frag", comp: "compute" }[name.split(".").pop()];
        const spv = dir + name + ".spv";
        run(process.env.NAGA || "naga", ["--input-kind", "glsl", "--shader-stage", stage, "--keep-coordinate-space",
            root + "tests/x64/vktest_shaders/" + name, spv]);
        const file = fs.readFileSync(spv);
        const words = new Uint32Array(file.buffer.slice(file.byteOffset, file.byteOffset + file.length));
        shaders.push(`static const uint32_t SPV_${name.replace(".", "_")}[] = { ${Array.from(words, w => "0x" + w.toString(16)).join(", ")} };`);
    }
    // vkcube's (glslang's: combined image samplers), out of the guest's vulkan-tools
    const tools = fs.readdirSync(packages).find(f => /^vulkan-tools-\d.*\.apk$/.test(f));
    spawnSync("bsdtar", ["-xf", packages + tools, "-C", dir, "usr/bin/vkcube"]);
    const binary = fs.readFileSync(dir + "usr/bin/vkcube");
    for(let align = 0; align < 4; align++)
    {
        const w = new Uint32Array(binary.buffer.slice(binary.byteOffset + align, binary.byteOffset + align + (binary.length - align & ~3)));
        for(let i = 0; i < w.length; i++)
        {
            if(w[i] !== 0x07230203) continue;
            // the module: instructions while they parse, to its last OpFunctionEnd
            let at = i + 5, end = 0, model = -1;
            while(at < w.length)
            {
                const count = w[at] >>> 16, op = w[at] & 0xFFFF;
                if(!count || op > 400 && op < 4400) break;
                if(op === 15 && model < 0) model = w[at + 1];
                at += count;
                if(op === 56) end = at;
            }
            const stage = { 0: "vert", 4: "frag" }[model];
            if(!end || !stage) continue;
            shaders.push(`static const uint32_t SPV_cube_${stage}[] = { ${Array.from(w.subarray(i, end), x => "0x" + x.toString(16)).join(", ")} };`);
        }
    }
    fs.writeFileSync(dir + "vktest_shaders.h", "// generated by tests/x64/linux_gpu.mjs\n" + shaders.join("\n") + "\n");
    run(process.env.CLANG || "clang", ["--target=" + arch + "-unknown-linux-musl", "-fPIC", "-O1", "-I", dir, "-I", root + "tests/x64/include", "-I", root + "third_party/vulkan",
        "-c", root + "tests/x64/vktest.c", "-o", dir + "vktest.o"]);
    run(lld, ["-flavor", "gnu", "-m", LINKER_EMULATION, "-pie", "--dynamic-linker", "/lib/ld-musl-" + arch + ".so.1", "--allow-shlib-undefined",
        "-o", dir + "vktest", dir + "vktest.o", sysroot + "lib/ld-musl-" + arch + ".so.1", sysroot + "usr/lib/libvulkan.so.1"]);
    run("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0", "-cf", dir + "vktest.tar", "-C", dir, "vktest"]);
    return dir + "vktest.tar";
}
const LINKER_EMULATION = arm ? "aarch64linux" : "elf_x86_64";
const gltest = steps.some(step => step[0].includes("$TESTS")) ? (scenario === "venus" ? build_vktest() : build_gltest()) : null;

const remote = LEVEL_3D && process.env.GPU_RENDERER === "chrome" ? await create_remote_renderer() : null;
const trace = LEVEL_3D && !remote ?
    create_trace_renderer(path.join(out, "trace.bin"), { adapter, level: process.env.GPU_LEVEL, scenario }) : null;
// VENUS_TRACE=1: the Venus commands the device runs, as decoded (venus.js's on_command)
const venus_trace = name => +process.env.VENUS_TRACE > 1 || !/^vk(Cmd|SetReply|Get(PhysicalDevice|Device|Image|Buffer)\w*(Properties|Requirements))/.test(name);
// (the root file system is half the RAM: the arm64 packages need more than 512 MiB of it)
const memory_size = Number(process.env.LINUX_GPU_MEMORY || (arm || ["virgl", "vkcube"].includes(scenario) ? 1536 : 1024)) * 1048576;
const array_buffer = file => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const test_options = process.env.GPU_LEVEL ? { graphics_adapter_test: { level: process.env.GPU_LEVEL, renderer: remote ? remote.renderer : trace && trace.renderer } } : {};
// (the virt machine: the ISO, the repository and the test programs on
// virtio-blk, the GPU on the PCIe host or virtio-mmio; less than 2 GiB of
// RAM with the GPU's device memory)
const emulator = arm ? new V86({
    cpu_type: "arm64", graphics_adapter: "virtio_gpu", wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm",
    kernel: { url: directory + "boot/vmlinuz-virt" }, initrd: { url: directory + "boot/initramfs-virt" },
    cmdline: "console=ttyAMA0 loglevel=4 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage",
    virtio_disks: [{ buffer: array_buffer(iso), readonly: true }, { buffer: array_buffer(repo), id: "a64gpurepo", readonly: true },
        ...(gltest ? [{ buffer: array_buffer(gltest), id: "a64gputests", readonly: true }] : [])],
    virtio_transport: process.env.GPU_TRANSPORT || "pci", virtio_input: ["keyboard", "tablet", "multitouch"],
    memory_size, cpu_cores: Number(process.env.GPU_CORES || 1), autostart: false, log_level: 0, net_device: { type: "none" },
    screen_adapter: sink, ...(+process.env.GPU_NO_JIT ? {} : { jit_switches: { a64_page: 1 } }), ...test_options,
}) : new V86({
    graphics_adapter: adapter,
    wasm_path: process.env.WASM_PATH,
    bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
    bzimage: { url: directory + "boot/vmlinuz-virt" }, initrd: { url: directory + "boot/initramfs-virt" },
    cdrom: { url: iso }, hda: { url: repo }, ...(gltest ? { hdb: { url: gltest } } : {}),
    cmdline: "console=ttyS0,115200 loglevel=4 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage",
    // (the root file system is half the RAM: the virgl and vkcube scenarios' packages need more than 1 GiB's)
    memory_size, acpi: true, autostart: false,
    disable_jit: !!+process.env.LINUX_GPU_NO_JIT, experimental_smp_jit: !+process.env.LINUX_GPU_NO_JIT,
    log_level: 0, net_device: { type: "none" }, screen_adapter: sink,
    ...(process.env.VRAM_SIZE ? { vram_size: Number(process.env.VRAM_SIZE) } : {}),
    ...test_options,
});

let serial = "";
// the guest drivers' logs through the VMware backdoor (vmwgfx's host log)
emulator.add_listener("vmware-log", text => console.log("guest-log: " + String(text).trim()));
emulator.add_listener("serial0-output-byte", byte => {
    const c = String.fromCharCode(byte);
    serial += c;
    if(+process.env.SHOW_LOGS) process.stdout.write(c);
});

const started = performance.now();
const elapsed = () => ((performance.now() - started) / 1000).toFixed(0) + "s";
const deadline = started + Number(process.env.LINUX_GPU_TIMEOUT || (arm ? 2700000 : 900000));

async function wait_for(pattern, from)
{
    while(performance.now() < deadline)
    {
        const tail = serial.slice(from);
        if(pattern.test(tail)) return tail;
        if(/Kernel panic/.test(serial)) throw new Error("Kernel panic");
        await delay(20);
    }
    throw new Error("timed out waiting for " + pattern);
}

/** A step's third element: { screenshot, after } */
const arguments_of = step => step[2] || {};

let failed = false;
try
{
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    const cpu = emulator.v86.cpu;
    if(!arm) cpu.wm.exports.set_x64_test_capabilities(1);
    const venus = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["virtio_gpu"]?.venus;
    if(venus && +process.env.VENUS_TRACE)
    {
        venus.on_command = (name, a) => {
            if(!venus_trace(name)) return;
            const brief = JSON.stringify(a, (k, v) => ArrayBuffer.isView(v) ? "[" + v.length + " bytes]" : v);
            console.log("venus: " + name + " " + brief.slice(0, 300));
        };
        if(+process.env.VENUS_TRACE > 1) venus.vk.debug = text => console.log("venus-device: " + text);
    }
    emulator.run();
    // GPU_DEBUG_BLITS=n: the first n BLIT_SURFACE_TO_SCREEN commands and what came of them
    const svga3d_debug = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"]?.svga3d;
    if(svga3d_debug && +process.env.GPU_DEBUG_BLITS)
    {
        let left = +process.env.GPU_DEBUG_BLITS;
        const blit = svga3d_debug.blit_surface_to_screen.bind(svga3d_debug), to_desktop = svga3d_debug.to_desktop.bind(svga3d_debug);
        svga3d_debug.blit_surface_to_screen = p => { if(left > 0) console.log("BLIT_SURFACE_TO_SCREEN " + Array.from(p).join(" ")); blit(p); };
        svga3d_debug.to_desktop = (...args) => {
            if(left-- > 0)
            {
                const [surface] = args;
                console.log("to_desktop format=" + surface.format + " sizes=" + JSON.stringify(surface.sizes) + " " + args.slice(1).map(a => JSON.stringify(a)).join(" ") +
                    " screens=" + JSON.stringify([...svga3d_debug.device.screens.screens.values()].map(s => [s.id, s.x, s.y, s.width, s.height])));
            }
            to_desktop(...args);
        };
    }

    // virgl's shaders as they come (TGSI text): GPU_OUT/tgsi/, each once
    const virgl = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["virtio_gpu"]?.virgl;
    if(virgl)
    {
        const dir = path.join(out, "tgsi");
        fs.mkdirSync(dir, { recursive: true });
        if(+process.env.GPU_DEBUG_VIRGL) virgl.debug_log = text => console.log("virgl-debug " + text);
        const seen = new Set();
        virgl.shader_log = (type, text) => {
            if(seen.has(text)) return;
            seen.add(text);
            const stage = ["vs", "fs", "gs", "tcs", "tes", "cs"][type] || "s" + type;
            fs.writeFileSync(path.join(dir, String(seen.size).padStart(3, "0") + "-" + stage + ".txt"), text);
        };
    }

    // vmware_svga's DX shaders as they come (VGPU10 tokens): GPU_OUT/dxbc/, each once
    if(svga3d_debug)
    {
        const dir = path.join(out, "dxbc");
        fs.mkdirSync(dir, { recursive: true });
        const seen = new Set();
        svga3d_debug.shader_log = (shid, type, bytes) => {
            const key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
            if(seen.has(key)) return;
            seen.add(key);
            fs.writeFileSync(path.join(dir, String(seen.size).padStart(3, "0") + "-" + type + ".bin"), bytes);
        };
    }

    await wait_for(/localhost login:/, 0);
    emulator.serial0_send("root\n");
    await wait_for(/localhost:~# /, 0);
    console.log(`[${elapsed()}] logged in`);
    {
        const from = serial.length;
        emulator.serial0_send(DISKS + "\n");
        const tail = await wait_for(/\nSTEP_DISKS \/dev\/\w+ ?(\/dev\/\w+)?\r?\n[\s\S]*localhost:~# /, from);
        console.log(`[${elapsed()}] disks: ${tail.match(/\nSTEP_DISKS ([^\r\n]*)/)[1]}`);
    }

    for(const step of steps)
    {
        const [command, expect] = step;
        if(command.startsWith("HOST "))
        {
            // the page's side: HOST set_display_size <width> <height> [display],
            // HOST snapshot (saved, then restored in place)
            const [verb, ...values] = command.slice(5).split(" ");
            if(verb === "set_display_size") emulator.set_display_size(...values.map(Number));
            // HOST pointer <x> <y> (fractions of the screen), HOST click, HOST type <text>,
            // HOST touch [<x> <y> ...] (the touches now, fractions of the screen; none: all lifted)
            else if(verb === "pointer") emulator.bus.send("mouse-absolute", [Number(values[0]) * 1000, Number(values[1]) * 1000, 1000, 1000]);
            else if(verb === "click")
            {
                emulator.bus.send("mouse-click", [true, false, false]);
                await delay(100);
                emulator.bus.send("mouse-click", [false, false, false]);
            }
            // (slowly: a guest compositor under emulation that renders in
            // software for a while lets evdev's 64 events overflow, SYN_DROPPED,
            // and libinput drops the keys)
            else if(verb === "type") await emulator.keyboard_send_text(values.join(" ").replace(/\\n/g, "\n"), 400);
            else if(verb === "touch")
            {
                const touches = [];
                for(let i = 0; i + 1 < values.length; i += 2) touches.push([i / 2, Number(values[i]) * 1000, Number(values[i + 1]) * 1000]);
                emulator.bus.send("touch", { "touches": touches, "width": 1000, "height": 1000 });
            }
            else if(verb === "stats")
            {
                // what the adapter's device has done (virtio_gpu: commands, virgl's)
                const device = emulator.v86.cpu.devices.graphics_adapter.device;
                const gpu = device["virtio_gpu"];
                if(gpu) console.log("virtio-gpu " + JSON.stringify({ stats: gpu.stats, active: gpu.active,
                    scanouts: gpu.scanouts.map(s => [s.enabled, s.resource_id, s.width, s.height, !!s.rgba]), pending: gpu.pending && gpu.pending.length,
                    virgl: gpu.virgl && { counts: gpu.virgl.counts, warnings: gpu.virgl.warnings, submitted: gpu.virgl.submitted, completed: gpu.virgl.completed,
                        requests: gpu.virgl.requests.size, completions: gpu.virgl.completions.length },
                    venus: gpu.venus && { stats: gpu.venus.stats, vk: gpu.venus.vk.stats, warnings: gpu.venus.vk.warnings,
                        contexts: [...gpu.venus.contexts.values()].map(c => ({ rings: c.rings.size, objects: c.objects.size })) } }));
            }
            else if(verb === "snapshot")
            {
                await emulator.stop();
                const state = await emulator.save_state();
                await emulator.restore_state(state);
                await emulator.run();
                console.log(`[${elapsed()}] snapshot: ${(state.byteLength / 1048576).toFixed(1)} MiB, restored`);
            }
            else throw new Error("unknown HOST step " + verb);
            console.log(`[${elapsed()}] ${command}`);
            continue;
        }
        if(command.startsWith("SCREENSHOT "))
        {
            // nothing presents in node: ask for a whole frame first
            cpu.devices.display.request_frame(true);
            const file = save_png(sink, out, command.slice(11));
            console.log(`[${elapsed()}] screenshot ${file || "(text mode)"}`);
            continue;
        }
        const from = serial.length;
        emulator.serial0_send(command + "\n");
        const options = arguments_of(step);
        if(options.screenshot)
        {
            // (GPU_SCREENSHOT_AFTER: ms, for every screenshot step instead of its
            // own; the arm64 guest's llvmpipe takes three times as long to start)
            await delay(Number(process.env.GPU_SCREENSHOT_AFTER || options.after * (arm && !LEVEL_3D ? 3 : 1)));
            cpu.devices.display.request_frame(true);
            console.log(`[${elapsed()}] screenshot ${save_png(sink, out, options.screenshot)}`);
        }
        // the command is done when the prompt comes back after its output
        const tail = await wait_for(/\n[^\n]*localhost:~# /, from + command.length);
        console.log(`[${elapsed()}] $ ${command}\n` + tail.replace(/\r/g, "").split("\n").slice(1, -1).join("\n"));
        if(!expect.test(tail)) throw new Error("step failed: " + command);
    }
    console.log("LINUX_GPU_DONE " + adapter + " " + scenario);
}
catch(error)
{
    failed = true;
    console.error("LINUX_GPU_FAIL " + adapter + ": " + error.message + "\n" + error.stack);
    emulator.v86 && emulator.v86.cpu.devices.display && emulator.v86.cpu.devices.display.request_frame(true);
    save_png(sink, out, "failure");
}
finally
{
    fs.writeFileSync(path.join(out, "serial.log"), serial);
    // gltest's failures: its pictures (PPM in base64) as PNG
    const pictures = new Map();
    for(const m of serial.replace(/\r/g, "").matchAll(/^GLIMG (\S+) (\S+) (\d+) (\S+)$/gm))
    {
        const key = m[1] + "-" + m[2];
        pictures.set(key, (pictures.get(key) || "") + m[4]);
    }
    for(const [key, text] of pictures)
    {
        const ppm = Buffer.from(text, "base64");
        const header = /^P6\n(\d+) (\d+)\n255\n/.exec(ppm.subarray(0, 32).toString("latin1"));
        if(!header) continue;
        const width = +header[1], height = +header[2], rgb = ppm.subarray(header[0].length);
        const rgba = new Uint8Array(width * height * 4);
        for(let i = 0; i < width * height; i++) rgba.set([rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], 255], 4 * i);
        console.log("gltest picture " + save_png({ width, height, rgba }, out, "gltest-" + key));
    }
    const svga3d = emulator.v86 && emulator.v86.cpu.devices.graphics_adapter && emulator.v86.cpu.devices.graphics_adapter.device["svga"]?.svga3d;
    if(svga3d) console.log("svga3d commands: " + JSON.stringify(svga3d.counts) + " warnings: " + JSON.stringify(svga3d.warnings));
    const virgl_end = emulator.v86 && emulator.v86.cpu.devices.graphics_adapter && emulator.v86.cpu.devices.graphics_adapter.device["virtio_gpu"]?.virgl;
    if(virgl_end) console.log("virgl: " + JSON.stringify({ counts: virgl_end.counts, warnings: virgl_end.warnings }));
    if(remote)
    {
        remote.close();
        console.log("renderer: " + JSON.stringify(remote.stats));
    }
    if(trace)
    {
        trace.close();
        console.log("trace: " + JSON.stringify(trace.stats) + " in " + path.join(out, "trace.bin"));
    }
    emulator.destroy();
}
process.exit(failed ? 1 : 0);
