# ARM (32-bit)

> Status: part 2 of [aarch32-plan.md](aarch32-plan.md), R1–R8. The 64-bit
> CPU's 32-bit programs (AArch32 at EL0 under a 64-bit kernel, profile
> `v3`) are part 1, in [aarch64.md](aarch64.md).

With `cpu_type: "arm32"`, the ARM core (`build/v86-arm64.wasm`, the same
file as arm64's) runs in AArch32 throughout: an ARMv8-A CPU in its AArch32
state at PL0 and PL1, which 32-bit kernels (ARMv7-A's system) run on. The
instructions (A32, T32, VFP, Advanced SIMD) are part 1's; part 2 adds PL1's
system, the short-descriptor MMU, the 32-bit platform and the Android
Emulator's board.

| | |
| --- | --- |
| Option | `cpu_type: "arm32"`; `machine_type: "virt"` (the default: [virt.md](virt.md)'s board with a 32-bit device tree) or `"ranchu"` (the Android Emulator's board, [virt.md](virt.md#the-ranchu-machine)) |
| Profile | `v86-arm32-v1`: ARMv8-A's AArch32 state at PL0 and PL1 (no Hyp, no Monitor, no Security Extensions), LPAE, the generic timer, VFPv4, Advanced SIMD, AES, SHA-1, SHA-256, VMULL.P64 and CRC32; MIDR `0x414FC0F0` (a Cortex-A15's), the AArch32 ID registers of part 1's v3 with PL1's fields |
| Verified guests | Alpine 3.24 armv7 (Linux 6.18.58, the netboot kernel and initramfs) on 1, 2 and 4 cores: its initramfs with part 1's 32-bit workload, the same output as QEMU's but for the CPU's deliberate differences (below); single-user mode, snapshots, `reboot -f` and `poweroff -f`; from a FAT disk with its modloop and packages to OpenRC's login. kvm-unit-tests arm (selftest, gicv3, psci, pl031, spinlock). The official Android 7.1.1 emulator image (`armeabi-v7a-25_r18`, google_apis) on ranchu with 2 cores and 1 GiB to `sys.boot_completed` |
| Boot time | Alpine's initramfs stage through the workload: 12.8 s with the page tier (interpreted 174 s, QEMU TCG 7.4 s), 14.3 s on 4 cores. Android 7.1.1 to `sys.boot_completed`: 633 to 826 s on 2 cores with the page tier |

## The CPU

- **Reset and boot.** The cores reset to AArch32 SVC mode with A, I and F masked, SCTLR `0x00C50078`. A kernel boots as Linux's zImage protocol wants it: the MMU off, r0 = 0, r1 = ~0, r2 = the device tree's address, the kernel at RAM + `0x10000` (`a32_boot`).
- **Modes and banked registers.** USR, FIQ, IRQ, SVC, ABT, UND and SYS. The current mode's R0–R14 are X0–X14; the other modes' R13 and R14, FIQ's R8–R12 and the five SPSRs live in the state block's `a32_*` fields (`gen/state_layout.js`), swapped on a mode change. CPSR is PSTATE in its AArch32 form.
- **PL1's instructions.** MRS and MSR (CPSR's fields, SPSR, the banked registers), CPS, SRS, RFE, `LDM`/`STM` of the User registers and `LDM` with the PC and `^` (an exception return), `SUBS PC, LR`, ERET, HVC and SMC (PSCI 0.2's calls), WFI and WFE.
- **Exceptions.** The vectors at VBAR (or `0xFFFF0000` with SCTLR.V), each exception's mode and return offset, SCTLR.TE (taken in T32) and EE; DFSR and IFSR in the short format (the fault's domain in bits 7:4) or LPAE's, DFAR and IFAR. FPEXC.EN gates VFP and Advanced SIMD at PL1 and PL0.
- **CP15.** Most registers are AArch64 system registers seen in 32 bits (SCTLR, TTBR0/1, the timer's, TPIDR*, CONTEXTIDR, VBAR, PRRR/NMRR as MAIR's halves, DFSR as ESR_EL1, DFAR and IFAR as FAR_EL1's halves); TTBCR, DACR and IFSR are their own. The cache and TLB maintenance operations (by ASID, by MVA, all), the barriers, the GICv3's system registers through CP15, the PMU reading zero. CP14 reads zero at PL1 and is UNDEFINED at PL0.
- **The MMU.** Short descriptors (sections, supersections, large and small pages, AP with AFE, XN, PXN, TEX remap, the domains: a TLB entry keeps its domain, DACR decides at each use, so a DACR write flushes no TLB) and LPAE's long descriptors (the 64-bit walk with VMSAv8-32's execute rules).
- **The page tier** compiles PL1's code too (modes 5 and 7 of its functions, EL1's access cache); instructions that change the mode, the masks or the MMU are single steps; a DACR write flushes the access cache.

## The QEMU reference

`qemu-system-aarch64` 9.2.0 with `-M virt-9.2,gic-version=3,its=off,highmem=off,virtualization=off,secure=off -cpu cortex-a15,pmu=off`
(`tests/a32/runner.mjs`: `QEMU_MACHINE32`, `QEMU_CPU32`). Deliberate differences, all in places the tests know:

- v86 has AArch32's crypto (AES, SHA-1, SHA-256, VMULL.P64) and CRC32, which a Cortex-A15 has not; it has no ThumbEE (QEMU's A15 has).
- QEMU's A15 has no EL2, so the banked forms of MRS and MSR are UNDEFINED there; v86 runs them as ARMv8's AArch32 PL1 does.
- QEMU's TTBCR keeps only N without LPAE (PD0 and PD1, which stop table walks, have no effect); v86 has them.
- QEMU raises no alignment fault for an unaligned access to Device memory with short descriptors; v86 does.
- An UNPREDICTABLE encoding is UNDEFINED in v86 (part 1's rule).

## Android 7.1 (the emulator image)

The SDK's `system-images/android-25/google_apis/armeabi-v7a` (`armeabi-v7a-25_r18.zip`) boots on `machine_type: "ranchu"`
as the emulator boots it with `-gpu guest`: its `kernel-ranchu` (Linux 3.10, LPAE), `ramdisk.img`, `system.img` read-only
as vda, an empty cache (vdb) and `userdata.img` (vdc), the emulator's kernel command line and boot properties. The guest
draws with the CPU: without a host GPU (`qemu.gles=0` on the command line) the image's EGL loader takes the vendor's
SwiftShader (it sets `qemu.gles` to 2), and gralloc copies SurfaceFlinger's frames into the framebuffer (no page flipping).
The device is a low-RAM one (boot property `ro.config.low_ram=true`, the device model's): system_server then draws its
own windows with Skia on the CPU, because the image's SELinux policy denies it `execmem`, which SwiftShader's JIT needs
(with GL, system_server's RenderThread jumped into its non-executable JIT code and system_server died). The VM manager imports
the zip into one disk ([android-images-plan.md](android-images-plan.md) I6, the "Android 7.1 (32-bit, emulator image)"
preset): v64's bootloader hands its kernel and ramdisk partitions to the kernel and makes its system, cache and userdata
partitions the machine's virtio disks (`src/android/partition_buffer.js`).

What differs from the emulator: no host GPU (no `opengles` pipe), no boot animation (the CPU would draw it), no sound
(goldfish_audio's buffers are consumed in time, not played), no sensors, no modem or SMS (`qemu.wifi=0`: eth0 on DHCP).

## Known defects

- The Android desktop's frames are slow: SurfaceFlinger and the apps draw with the CPU.
- The 32-bit virt machine's display (virtio-gpu) is not verified; the Linux preset uses the serial console.
- More than 2048 MB of RAM is not offered (the 32-bit kernels' high memory above 768 MB is enough for both guests).

## Testing

| What | Command | Machine |
| --- | --- | --- |
| Bare metal at PL1 against QEMU's cortex-a15: modes, exceptions, CP15 (`system`), the MMU's short and long descriptors (`mmu`), PSCI, the timers, the GICv3's CP15 interface, a second core (`platform`), the GICv2 (`gicv2`) | `node tests/a32/baremetal.mjs` | both |
| Alpine 3.24 armv7 (pinned SHA-256): the initramfs stage with the 32-bit workload, single-user mode, the lifecycle (snapshots, reboot, poweroff), the live stage from a FAT disk; 1/2/4 cores, interpreted and with the page tier (`A32_STAGE`, `A32_CORES`, `A32_JIT=1`: the page tier, `A32_LINUX_TARGET=qemu\|v86\|both`) | `node tests/a32/linux_boot.mjs` | both |
| kvm-unit-tests arm (`tests/kvm-unit-tests/build.sh arm`) | `node tests/kvm-unit-tests/arm32.mjs` | both |
| The ranchu machine's devices through their registers: the device tree, virtio-mmio's legacy transport with virtio-blk, goldfish_events, _battery, _audio, _pipe (qemud's boot properties), the framebuffer, `/cache`'s file system, snapshots | `node tests/a32/ranchu_devices.mjs` | v86 |
| Android 7.1.1 to `sys.boot_completed`, the screen woken and unlocked, a screenshot (`A32_ANDROID_DISK=1`: the imported disk through the bootloader; `A32_ANDROID_SAVE_STATE`, `A32_ANDROID_RESTORE_STATE`; `A32_ANDROID_LOGCAT=1`) | `node tests/a32/android_boot.mjs` | v86 |
| The emulator image's import: the disk, the bootloader, partitions as disks (`tests/android/library.mjs`); the wizard (`part=android_emulator`) | `make app-tests` | — |

`make a32-system-tests` runs these but the Android boot (`make a32-android-tests`); `make a32-tests` runs them with part 1's AArch32 EL0 tests.
