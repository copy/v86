#!/usr/bin/env node
// Alpine 3.24 aarch64 on the virt machine's virtio_gpu (no VGA;
// docs/arm64-virt-android16-plan.md P7.1, P7.2): the scenarios of
// tests/x64/linux_gpu.mjs (drm, gl, gltest, virgl, venus, vkcube, resize)
// with GPU_ARCH=aarch64, the packages from build/a64-linux/gpu-repo.tar
// (node tools/alpine_repo.mjs --arch aarch64 --set gpu), the ISO's kernel
// and initramfs (tests/a64/linux_boot.mjs prepares them).
//
//     [GPU_SCENARIO=drm] [GPU_LEVEL=virgl43-hostmem] [GPU_TRANSPORT=pci|mmio] node tests/a64/linux_gpu.mjs
process.env.GPU_ARCH = "aarch64";
await import("../x64/linux_gpu.mjs");
