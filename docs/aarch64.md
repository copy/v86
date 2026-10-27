# AArch64

> Status: A3, A4 and A5 of [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md)
> (virtio-mmio devices; the page tier, J2 of
> [jit-unification-plan.md](jit-unification-plan.md); the PCIe host,
> virtio-pci, input and virtio-gpu), A6 (the lifecycle, cores in vCPU
> workers, extended RAM, 16 and 64 KiB page kernels, the browser) and A7
> (the rehearsals for Android, P9.1-P9.3, and G-Alpine: every release level
> R-a64-isa through R-a64-android-prep on one tagged build, `vA7`), and A8
> (Android 16 on the QEMU reference to boot_completed, the GKI bridge, and
> on v86 to system_server and adbd: the section below), A9 (Android's
> desktop on Venus, touch, network, apps, `vA9`) and A10 (16 KiB pages,
> sound, snapshots with cores in workers, the long run and memory pressure,
> a CTS subset and the metrics against P10.3's budget, `vA10`): the plan is
> complete.

With `cpu_type: "arm64"` (from A1), v86 runs a separate core,
`build/v86-arm64.wasm`: an Armv8.0-A CPU at EL0 and EL1 only, on the `virt`
board ([virt.md](virt.md)). The x86 core, `build/v86.wasm`, is unchanged and
does not contain the ARM code (the plan's "Wasm core" section).

| | |
| --- | --- |
| Option | `cpu_type: "arm64"` (machine_type "virt", its default) |
| Profile | `v86-aarch64-v2` by default since 2026-10-20 (v1.1 and FEAT_PAN), [tests/platform/a64-profile.json](../tests/platform/a64-profile.json) (`cpu_profile: "generic-arm64-v1.1"`: without PAN; `"generic-arm64-v1"`: the 4 KiB granule only; `"generic-arm64-compat32"`: v2 and AArch32 at EL0, 32-bit programs on a 64-bit kernel) |
| Verified guests | Android 16 (BP4A.251205.006, Cuttlefish's arm64-only phone, GKI 6.12): on 4 cores in workers with the page tier to system_server, adbd over vsock and `sys.boot_completed=1`; the desktop on Venus, touch, Wi-Fi, an APK and a reboot (A9); its desktop saved and restored into a new machine, then input, sound, 30 minutes of monkey and memory pressure with the core services kept, a CTS subset (CTS 16.1_r1's KernelConfig, NativeEncryption, AslrMalloc, FsMgr and Bionic, 3208 tests), and the same userspace on a 16 KiB-page GKI kernel (6.12.93) to the desktop (A10); its GKI kernel with Alpine's initramfs, the virtual-device modules and the probe (P10.6). Alpine 3.24 aarch64 (Linux 6.18, the official ISO's kernel and initramfs) on 1/2/4 cooperative cores, interpreted and with the page tier: from the ISO on virtio-blk to a login, the probe (threads, signals, cross-modified and dual-mapped code, FP across context switches, exclusives, O_DIRECT), virtio-net, -rng, hvc0 and -input, kpti=1, single-user mode, snapshots, reboot and poweroff, `setup-disk -m sys` onto a disk and the installed system, all on virtio-mmio and on virtio-pci (the PCI functions as the reference's); s2idle woken by the PL031's alarm and hibernation to a swap disk with the resume after power-on; 3 and 4 GiB of RAM with extended RAM from 4 GiB (a memtest over most of it); in headless Chrome from the source tree, the bundle and the CPU worker; on 2 and 4 cores in vCPU workers (`parallel: true`: the probe, the live stage with snapshots, reboot, poweroff, s2idle, hibernation); Linux 6.18.35 built for 16 and 64 KiB pages (`tools/a64_kernel.mjs`) to a login and through the probe, interpreted and with the page tier, and the guest JITs on them; the androidish kernel (Linux 6.18.35 in GKI's shape: a 39-bit VA, SW_TTBR0_PAN, pseudo-NMIs, KASLR) on 2 and 4 cores, interpreted, with the page tier and in workers, and with 4 GiB of RAM: binderfs's selftest and binder between two cores, userfaultfd, a minimal SELinux policy enforcing (the probe after it), bootconfig, erofs on dm-verity, f2fs with fscrypt across a reboot, zram as swap and PSI's trigger; virtio-console's ports 1-3 (`org.v86.port<N>`, echoed by the host) in every live stage; virtio-gpu: KMS (atomic, planes, cursor, PRIME, explicit sync), kmscube and weston with llvmpipe, virgl (GL 4.3, gltest 0 failures), Venus (vktest, vkcube) on a real GPU through WebGPU, input on weston; kvm-unit-tests arm64 at 4, 16 and 64 KiB; guest JITs (V8 in nodejs, HotSpot, LuaJIT, PCRE2) with their output equal to QEMU's |
| Boot time | The frozen baseline (P9.4, [tests/a64/perf-baseline.json](../tests/a64/perf-baseline.json), release build, medians of 3 sessions on an Apple M-series Mac): Alpine from the ISO to `localhost login:` 34.7 / 39.5 / 40.6 s on 1/2/4 cores with the page tier, 238 / 281 / 362 s interpreted (QEMU TCG: 11 s on 1 core); the initramfs stage through the probe 6.3 / 6.9 / 7.0 s with the page tier, 35.6 / 41.8 / 57.4 s interpreted. On a quiet machine at A4: to login 30 / 39 / 34 s, and on 1 core to login and through the probe 33.1 s, 1.37 times the x86_64 page tier's 24.1 s on the same host (the E level's budget: 3 times) |
| Sound | virtio-snd (`virtio_sound: true`, P7.5, P12.5): one output stream, PCM in 1 or 2 channels, S16 or S32, 8000 to 48000 Hz, played on the machine's clock to the speaker. Android's audio HAL plays through it (its primary output is tinyalsa's card 0 device 0): tinyplay's WAV reaches the host byte for byte; an AAudio tone through AudioFlinger reaches it at its frequency on QEMU, while on v86 the HAL drops it (below). In the browser the speaker's AudioWorklet plays it (from the CPU worker over its audio port); a page started without a user gesture gets a suspended AudioContext (the autoplay policy), which the first click, key or touch on the page resumes |
| Pointer | The virtio tablet and multitouch screen (and arm32's goldfish_events) tell the page when the guest's driver runs (`mouse-enable` at DRIVER_OK, false on a reset, again when a state is restored) and that their positions are absolute (`absolute-pointer`: [active, the guest draws its own cursor]): the page's mouse adapter takes the mouse, a trackpad and touches over the screen only then (the virt machine has no PS/2 controller to say so), locks no pointer on a click, and hides the host's cursor for the tablet only. With `mouse_as_touch` (the Android presets: no tablet) the mouse is one finger: a click taps, a drag swipes; the wheel goes nowhere |

## CPU profile

`v86-aarch64-v1.1` is Armv8.0-A as Alpine 3.24 needs it, plus the AES, PMULL,
SHA1, SHA2 and CRC32 extensions. Every ID register, its fields and the reason
for each value are in the profile JSON, checked against the Arm Architecture
Reference Manual, DDI 0487 issue L.b.

| Advertised | Not advertised |
| --- | --- |
| AArch64 at EL0 and EL1; FP and Advanced SIMD (no FP16); AES with 64-bit PMULL, SHA1, SHA-256, CRC32; GICv3 system registers; 2 breakpoints, 2 watchpoints; CSV2 and CSV3; 40-bit physical addresses, 16-bit ASIDs, the 4, 16 and 64 KiB granules (v1 has 4 KiB only); AArch32 at EL0 in v3 (below) | EL2, EL3, AArch32 at EL1 (32-bit kernels: `cpu_type: "arm32"`, planned in [aarch32-plan.md](aarch32-plan.md) part 2); LSE, RDM, SHA512, SHA3, SM3/SM4, DotProd, FP16; PAuth, BTI, MTE, SVE, SME; PMU; hardware AF/DBM, PAN, VHE |

HWCAP is `0x8ff`: `fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid`.

The default profile, `cpu_profile: "generic-arm64"` (`v86-aarch64-v2`, since
2026-10-20; before it v1.1), is v1.1 and FEAT_PAN, optional in Armv8.0: ID_AA64MMFR1_EL1.PAN 1; PSTATE.PAN, MSR PAN (immediate and
register), SPSR_EL1.PAN; SCTLR_EL1.SPAN clear makes an exception taken to
EL1 set PAN. With PAN set, EL1's loads, stores, exclusives and DC ZVA to
memory EL0 may access (AP[1] set) take a permission fault, LDTR and STTR
are checked as EL0's, and AT S1E1R/W and instruction fetches ignore it (no
PAN2, no PAN3). Linux then uses PAN instead of SW_TTBR0_PAN, which
switched TTBR0 on every entry from EL0 and around every uaccess. The
page tier never caches EL1 entries of memory EL0 may access under v2, so
PSTATE.PAN changes need no flush. HWCAP is v1.1's. A snapshot restores as
its own profile (the machine takes it on), whatever `cpu_profile` says.
`tests/a64/pan.mjs` checks it against QEMU's `-cpu max` (the cortex-a35
reference has no PAN).

Profile `v3` (`cpu_profile: "generic-arm64-compat32"`, `v86-aarch64-v3`; [aarch32-plan.md](aarch32-plan.md)
part 1) is v2 and AArch32 at EL0: a 64-bit kernel with COMPAT runs 32-bit
Arm programs (armhf, armeabi-v7a) as compat tasks. ID_AA64PFR0_EL1.EL0 is 2;
the AArch32 ID registers are the reference's for an AArch32 at EL0 only, as
Cortex-A76 reports them (no AArch32 EL1 modes, no SETEND, no SMC). A32 and
T32 with IT blocks, VFPv4 (no short vectors, no half-precision arithmetic),
Advanced SIMD with AES, SHA-1, SHA-256 and VMULL.P64, CRC32, CP15's EL0
registers (TPIDRURW, TPIDRURO, the generic timer, the CP15 barriers), BKPT,
software step, breakpoints and watchpoints; FPSCR is FPSR and FPCR (Len and
Stride read 0). The compat HWCAP is `half thumb fastmult vfp edsp neon vfpv3
tls vfpv4 idiva idivt lpae evtstrm` and HWCAP2 `aes pmull sha1 sha2 crc32`.
The page tier compiles 32-bit code too (`a64_page_aarch32`, below: A32 and
T32, VFP and Advanced SIMD; T32 about 1.4 times A64's time on the same C
kernels). The instructions are checked against the reference one by one
(`tests/a64/aarch32_oracle.mjs`, `aarch32_el0.mjs`), Alpine's armv7 programs
and a 32-bit probe run with the reference's output
(`A64_PROFILE=v3 A64_WORKLOAD=aarch32 node tests/a64/linux_boot.mjs`). The
VM manager offers it as "Instruction sets" on arm64 (the Linux preset's
choice); the deviations from QEMU, all on UNPREDICTABLE encodings, are in the
plan's progress notes.

The profile's completeness (`node tools/a64_profile_report.mjs --reference --kvm`,
at `vA7`): all 49 classes of the Arm ARM's encoding index have a status (37
implemented, 11 UNDEFINED, 1 ID space) and tests; the ID registers read on v86
equal the profile's on 1 and 4 cores, the reference's differ only as allowed;
Linux reports HWCAP 0x8ff and HWCAP2 0 on the stock, androidish, 16 KiB and
64 KiB kernels; Linux runs with 4, 16 and 64 KiB pages and kvm-unit-tests pass
at all three granules.

The differences allowed against the QEMU `cortex-a35` reference are listed in
the profile JSON (`allowed_differences`). `node tools/cpu_contract.mjs
--a64-reference` reads the reference's ID registers at EL1 with a bare-metal
program and fails on any other difference.

## The QEMU reference

QEMU 9.2.0 built from its release tarball (`tools/a64_qemu/build.sh`; SHA-256
checked) into `build/a64-ref/qemu-9.2.0-install`:

```
-machine virt-9.2,gic-version=3,its=off,highmem-ecam=on,highmem-mmio=on,highmem-redists=on,virtualization=off,secure=off,acpi=off,dtb-randomness=off
-cpu cortex-a35,pmu=off,cntfrq=1000000000
-global virtio-mmio.force-legacy=false
```

One local patch, `tools/a64_qemu/0001-tb_phys_invalidate-jit-write.patch`:
on a macOS host the first watchpoint hit hangs the vCPU thread. The JIT
region is write-protected, so `qemu_spin_lock()` on the TB never succeeds.

Only `aarch64-softmmu` is built. QEMU's linux-user targets do not build on
macOS.

## Android 16

v64 boots Android from its disk itself: V86's `android` option
(`{ device, gpu_mode, selinux, vendor_ramdisk }`, in place of `kernel`,
`initrd` and `cmdline`) reads the first virtio disk's GPT, the slot's boot,
init_boot, vendor_boot and vbmeta partitions and those vbmeta chains, and
gives the kernel, the initrd with bootconfig (the vendor's section, the
launcher's and bootloader's keys, the vbmeta digest as libavb computes it)
and the command line (`src/android/bootloader.js`, run where the disk is: in
the CPU Worker by default). The VM manager imports official images into
such a disk: Cuttlefish's images zip, and a GSI on that device
(`src/android/assemble.js`; `node tools/android_import.mjs <zip> <disk.img>
[--gsi <zip>]` does it in node); see [vm-manager.md](vm-manager.md) and
[android-images-plan.md](android-images-plan.md). The image formats (boot
images, LZ4, cpio, bootconfig, sparse, AVB, LP, erofs, GPT, zip) are
`src/android/`'s, which `tools/a64_android.mjs` uses too.

A8 of the plan (P10). The product is not built here: AOSP builds need an
x86_64 Linux host. The pinned prebuilt is Cuttlefish's arm64-only phone,
`aosp_cf_arm64_only_phone-userdebug` build 15581820 from ci.android.com,
which is BP4A.251205.006, the build of `android-16.0.0_r4` (QPR2). Its GKI
kernel is `6.12.38-android16-5`, and the virtual-device modules come from its
vendor_boot. ART targets cortex-a53 with default features (v8.0 and CRC32),
and the image is 64-bit only.

`node tools/a64_android.mjs [--download]` makes the direct-boot materials in
`build/a64-android/out/`:

- `Image`, the kernel from boot.img.
- `initrd.img`: the vendor ramdisk, the generic ramdisk of init_boot, and
  bootconfig. It carries the vendor's own section plus what Cuttlefish's
  launcher and U-Boot would add: slot `_a`, normal boot, an unlocked device
  with the vbmeta digest computed as libavb does, the boot device
  `4010000000.pcie`, the f2fs fstab, and the graphics keys.
- `disk.img`: one GPT disk with Cuttlefish's partitions, written as a
  sparse file.
- With the guest's Venus driver (`make android-venus`, below): the driver
  in odm as `/odm/lib64/vulkan.virtio.so` (blocks added to odm's erofs, a
  new hash tree and vbmeta descriptor, odm_a moved within super), and
  `initrd-venus.img`, `initrd.img` with libvulkan's driver that one
  (`androidboot.hardware.vulkan=virtio`), the ranchu HWC scanning out what
  SurfaceFlinger composes (`hwcomposer.mode=client`) and OpenGL ES 2.0
  announced. `initrd.img` keeps SwiftShader.
- `manifest.json`: the hashes, partitions, command line and bootconfig.

Cuttlefish's host services (keymint, gatekeeper, ...) are replaced by the
guest's nonsecure APEXes, which bootconfig selects. The default vendor
ramdisk is the build's debug one, so an unlocked device runs adbd without a
key. SELinux is enforcing (`--selinux permissive` for debugging).

The kernel's console is hvc0, logcat goes to hvc2, and an Android shell
runs on the PL011.

| | QEMU reference (TCG cortex-a35, `tests/a64/android_boot.mjs`) | v86 (`A64_ANDROID_TARGET=v86`) |
| --- | --- | --- |
| Boot (first boot, 4 cores, 1536 MiB) | `sys.boot_completed=1` in 341 s (system_server at 143 s); 174 billion instructions to it (libinsn, an upper bound); about 1 GiB is the least RAM that boots | release build, page tier, cores in workers: system_server at 443 s, adbd over vsock at 447 s, `sys.boot_completed=1` (polled over adb) at 1396 s, 4.1 times the reference |
| Devices | virtio-pci: blk 00:01.0, gpu 00:02.0, 18 virtconsoles, rng, keyboard, tablet, three NICs | the same order, `virtio_vsock` (adb), a multitouch screen, three virtio NICs (`net_device.count: 3`), the third on the fetch adapter under Cuttlefish's Wi-Fi |
| A9's scenario (`A64_ANDROID_SCENARIO=a9`) | boot_completed 299 s, the desktop at 370 s, Launcher3's frames 1.4 s (warm median), app start 12.1 s, second boot 179 s (an earlier run: 341 s, 27.8 s, 208 s) | Venus (`A64_ANDROID_GPU=venus`): boot_completed 1076 s, the desktop at 1174 s (user 0 unlocked within 3 s), frames 2.3 s, app start 17.7 s (1.5 times), second boot 569 s (3.2 times); Wi-Fi, HTTP through the fetch adapter, a tap that opens Gallery. SwiftShader: Launcher3 still not drawn some 38 minutes after it resumed, so the tap fails |

P10.3 freezes Android's E level against the QEMU TCG reference on the same
host, with the same materials, on 4 cores with 1536 MiB, and v86 as above. A
measurement beyond twice its budget is the plan's stop condition.

- The first cold boot to `sys.boot_completed=1` takes at most 5 times the
  reference's (4.1 measured).
- The second boot, an app's start (`am start -W`) and input latency also take
  at most 5 times the reference's.
- The sustained frame rate is at least a fifth of the reference's.
- A10's long run is 30 minutes of a fixed-seed monkey. Its memory-pressure
  case starts apps until lmkd kills one. In both, system_server, surfaceflinger
  and zygote must not restart.

The GKI bridge (P10.6, `A64_KERNEL=gki` in `tests/a64/linux_boot.mjs`) runs
the GKI kernel with Alpine's initramfs and the probe, on QEMU and on v86. It
loads the 19 virtual-device modules in modprobe's order first; the virtio
drivers they register must match the reference's.

The ISA scan (P10.4, `node tools/a64_android.mjs --extract` then
`node tools/a64_isa_scan.mjs --android build/a64-android/rootfs.tar`) reads
what the booted guest mounts: the read-only partitions and 87 APEXes, 2601
AArch64 ELFs including ART's OAT files and the libraries in APKs. Of 170
million code words, 0.1% are valid only beyond v1. Each of those is one of:

- code selected at runtime by HWCAP: BoringSSL, image and video codecs,
  WebView, bionic's MTE/MOPS/SME paths, LSE through outline atomics or kernel
  alternatives;
- data in OAT `.text`;
- code that never runs here: the pKVM Trusty VM.

No v2 feature is needed.

A9's scenario (P11, `tests/a64/android_scenario.mjs`) runs over adb after
`sys.boot_completed=1`, on both targets:

- SELinux enforcing; the device's test settings (`prepare_device`: no lock
  screen, no animations), set on v86 as soon as adb answers;
- user 0 unlocked, Launcher3 the top resumed activity;
- Wi-Fi on Cuttlefish's VirtWifi with an address by DHCP; on v86 also an
  HTTP request through the fetch adapter to the test's own server, again
  after Wi-Fi off and on;
- on v86, a tap on the multitouch screen at the centre of Gallery's icon
  (found with uiautomator) opens Gallery;
- an APK (`tests/a64/apk.mjs`) pushed, installed and started;
- a reboot: boot_completed again, the APK and a file in /data still there,
  SELinux still enforcing;
- no service restarting over and over; the app crashes and ANRs since the
  reboot, and DHCP failures, are recorded.

Graphics with SwiftShader are too slow on v86 for the desktop's acceptance:
A9's graphics move to Venus (P11.4). The prebuilt image has no Mesa, so
`make android-venus` (`tools/a64_venus/build.mjs`) builds Mesa's venus
driver with the NDK (Mesa 26.1.6, the version of `venus_protocol.js`;
libdrm linked in; `tools/a64_venus/venus-android.patch`: the render node
opened by path, as SELinux hides /dev/dri from drmGetDevices2; minigbm's
buffer handles read directly; AHardwareBuffers imported as their
virtio-gpu resources without `VK_EXT_external_memory_dma_buf`), and the
materials install it. ANGLE runs GLES on it (OpenGL ES 2.0: WebGPU's 12
uniform buffers a stage are fewer than ES 3 needs with ANGLE's own, and
there is no transform feedback), for SurfaceFlinger and HWUI;
`A64_ANDROID_GPU=venus` boots `initrd-venus.img`.

The official images need no driver of v64's: virtio-gpu's gfxstream level
([gfxstream-plan.md](gfxstream-plan.md), [gpu-devices.md](gpu-devices.md))
speaks the protocol of the image's own Vulkan driver (`vulkan.ranchu`, ANGLE's
GLES on it, OpenGL ES 3.0), which Cuttlefish's `gfxstream_guest_angle` mode
selects (bootconfig only: the bootloader's `gpu_mode: "gfxstream"`). The
official Cuttlefish images on gfxstream pass A9's scenario on v86
(`A64_ANDROID_GPU=gfxstream A64_ANDROID_BOOTLOADER=1`, 4 vCPU workers):
boot_completed 1186 s, Launcher3 in front after the unlock, Gallery opened by
a tap, Wi-Fi and HTTP, an APK installed (Success) and started in 59.9 s, the
second boot 665 s; the official GSI over Cuttlefish's vendor (BP4A) passes it
too: boot_completed 991 s, the APK started in 25.6 s, the second boot 477 s
(2026-10-25). A10's scenario passes on gfxstream as well (the official image,
its desktop saved and restored into a new machine): input latency 734 ms
(median), 12.6 fps, the tone byte for byte, 30 minutes of monkey without a
crash, lmkd's kills, the core services kept. The VM manager's Android preset and imported images use
gfxstream by default; the screen shows the scanout straight from the GPU
when the graphics proxy's compositor is on the page (no readback, G-31).

32-bit apps (profile `v3`, [aarch32-plan.md](aarch32-plan.md) Q5.2): Cuttlefish's
arm64 phone is 64-bit only, so `tools/a64_android.mjs --gsi <zip>
--zygote64-32` gives its vendor a 32-bit second architecture for a GSI that
has one (vendor's `ro.zygote=zygote64_32`, vendor's and odm's 32-bit ABI
lists, vendor's 32-bit boringssl self test left to the system's). An APK
with only `armeabi-v7a` libraries then installs and runs its library in a
32-bit process (`A64_ANDROID_SCENARIO=compat32`, with `A64_PROFILE=v3` on
v86). It gets no window: the vendor has no 32-bit gralloc mapper or graphics
drivers. On v86 (4 vCPU workers, the page tier) the BP4A GSI so built reaches
`boot_completed` after 1982 s, both zygotes up, and the library reports a
32-bit process and the host's floating-point sum (2026-10-25); QEMU's
cortex-a35 TCG, the reference, after 370 s.

## Known defects

The G-Alpine list (docs/arm64-virt-android16-plan.md P9.4). Major: a
verified guest's function fails, or a release level does; minor: a
declared deviation, a slower path or a documented limit. None is major.

| Defect | Severity | |
| --- | --- | --- |
| Cores in workers: a store-exclusive also compares the value its load-exclusive read, so a value written back by a store compiled in another worker does not make it fail (ABA) | minor | declared deviation, as QEMU's; the probe and litmus only report the ABA line in this mode |
| Cores in workers: WFE ends after at most 20 µs without an event | minor | a spurious wake-up, which the architecture allows |
| Cores in workers: DSB is a single step, and compiled code leaves accesses to extended RAM, and code there, to the interpreter | minor | slower; cooperative cores cache extended RAM's frames and compile from it |
| The interpreter's accesses to extended RAM look up the frame each time | minor | interpreted Alpine with 3 GiB: 18 MIPS against 26 |
| Interpreted on several cores, the guest's clock is the host's: every core takes its timer ticks (HZ=1000) for the whole slow boot, so Alpine retires about 50% more instructions on 4 cores than on 1, and the jitter entropy self-test at boot takes 17-18 s on 4 cores | minor | close to the soft lockup threshold (20 s) when the host is busy: `tests/a64/linux_boot.mjs` gives such runs `watchdog_thresh=30`; the page tier takes under a second there |
| Kernels with SW_TTBR0_PAN (the androidish one, GKI) boot 17% slower to a login than the stock kernel with `a64_asid_tag` auto, 70% slower without it | minor | profile v2 has FEAT_PAN (`cpu_profile: "generic-arm64"`), which they use instead: the androidish Alpine logs in after 52.2 s on v2 against 54.6 s on v1.1, the page tier's system instructions on both (plan appendix F3) |
| A single-buffer snapshot (`save_state`) refuses extended RAM | minor | `save_state_stream` holds it |
| Android 16's first boot takes 20-22 minutes on 4 cores in workers (release build: 1192-1325 s, about 4 times QEMU TCG's; mostly APEX decompression and dex2oat, about 100-110 MIPS overall) | minor | within P10.3's budget (P12.3: every metric is; the plan's appendix E, A10); FEAT_PAN is the first candidate for speed |
| Android's graphics with SwiftShader on v86: Launcher3's first frames take minutes; with animations on, ART's finalizer watchdog killed it (`ReferenceQueueDaemon` timed out on `HardwareRenderer$DestroyContextRunnable`) although `ro.hw_timeout_multiplier` is 50; screenshots lag the window manager by seconds | minor | A9's scenario turns animations off; A9's graphics are Venus's (P11.4) |
| Android on Venus: frames still take seconds when they are new (Launcher3's all-apps list: about 5 s cold; warm 0.8 s at the median, as QEMU TCG's SwiftShader); a GL app sustains 14 fps | minor | within P10.3's budget (P12.3) |
| Android on Venus reports OpenGL ES 3.0 since 2026-10-21 (`androidboot.opengles.version=196608`; SwiftShader's 3.1): dEQP's GLES3 sample of 1334 cases from the re-saved `a10-desktop.v7`, 1233 pass, 94 not supported (ASTC, float color buffers, multiview, 8 samples, wide points and lines), 5 fail: shadow lookups with an explicit lod or gradients (compared at level 0, WGSL's only comparison with a level) and the sample's two blits of a multisampled color buffer into the window after an invalidate (`fbo.invalidate.{whole,sub}.unbind_blit_msaa_color`; all 8 `unbind_blit_msaa_*` cases of the group fail). gfxstream gives the same counts and the same 5 failures (2026-10-25) | minor | [gpu-deviations.md](gpu-deviations.md) G-45 to G-58; the plan's appendix F (F2, F6) |
| UWB's initialisation times out on Cuttlefish without the host's pica (hvc9), and a userdebug build then takes a full bug report: minutes of dumpstate on v86 | minor | A9's scenario turns UWB's device-error bug reports off (`device_config`) |
| Android's first boot on v86: user 0 unlocks about ten minutes after `sys.boot_completed=1` (the receivers of PRE_BOOT_COMPLETED and BOOT_COMPLETED); SystemUI's SYSTEM_READY can then come before provisioning ends, so it never shows its keyguard while the window manager keeps the keyguard's sleep token, and dismissals do nothing | minor | the scenario waits for `RUNNING_UNLOCKED` and disables the lock screen as soon as adb answers |
| "DHCP failures" on Android's wlan0 (twice in one run, the network then blocked for five minutes) are IpClient's provisioning deadline, not DHCP: the fetch adapter answers each exchange within a second (`dhcp.log`, DhcpClient's log), but IpClient gives the whole provisioning 18 s from its start (NetworkStack's `ProvisioningConfiguration` default), and on v86 the Wi-Fi thread's pre-DHCP step took 11 s and applying the lease about 3 s | minor | the scenario connects again every two minutes; only an overlay (`config_wifiRemainConnectedAfterIpProvisionTimeout`) or a faster guest avoids it |
| Bluetooth's native stack aborts (FinalizerWatchdogDaemon) on Android's first boot | minor | on QEMU TCG too: not v86's |
| Venus ring ids were read as numbers until 2026-10-19: they are the driver's pointers to its rings, Android's heap pointers carry a tag in the top byte, and two threads' rings a few hundred bytes apart rounded to one id, the second ring replacing the first. The first ring's thread (an ANGLE worker's warm-up `vkCreateGraphicsPipelines`) then waited for good, and with it Launcher3's or SystemUI's RenderThread in ANGLE's post-link wait; a state saved after such a collision keeps it (all five restores of one stalled). Ring ids are exact now ([gpu-devices.md](gpu-devices.md)); a state saved before may already lack a ring | minor | re-save such states (A10's `android-venus-booted.v7`, `android-a10-desktop.v7`); a snapshot of then restores, its rings under their rounded ids |
| virtio-snd: no input stream, no jacks, no volume control; a stopped stream's buffers come back only at RELEASE | minor | Android plays through it; recording is not needed by the plan |
| Android's framework audio on v86: Cuttlefish's audio HAL (StreamPrimary) skips a transfer, its frames accepted but not written, whenever its writes have fallen behind real time, a workaround for emulators (b/302587331); AudioFlinger on v86's cores falls behind from a stream's start and the HAL then skips nearly every transfer, so the card hears silence | minor | tinyplay (ALSA without the HAL) plays exactly; A10's scenario records the HAL's skipped transfers and offsets |
| Android with 16 KiB pages: the 16K GKI build has no `tls.ko` (`CONFIG_TLS` is off in its configuration; the 4K system_dlkm's file stays, out of modules.dep), and 11 of its modules have no place in the 4K layout and are not loaded: hardware the virt machine does not have (exynos-hvm, xhci-pci-renesas, snd-hda-codec-hdmi, ...), efivarfs and pstore without EFI or a pstore device, and aes-neon-blk, which `aes-ce-blk` (built in, FEAT_AES) outdoes | minor | the same services start as on 4K; the replaced system_dlkm and vendor_dlkm have their AVB footer again (2026-10-20), so fs_mgr reads their offline vbmeta as on 4K; no pgagnostic Cuttlefish build is public, the 4K image's userspace is page-size agnostic |

## Testing

| What | Command | Machine |
| --- | --- | --- |
| Alpine 3.24 aarch64 initramfs and live stages, the probe (`tests/a64/linux_probe.c`), 1/2/4 cores | `A64_LINUX_QEMU=1 A64_STAGE=initramfs\|live A64_CORES=N node tests/a64/linux_boot.mjs` | QEMU |
| The same on v86 (initramfs, single, lifecycle; `A64_JIT=1`: the page tier; `A64_KPTI=1`, `A64_WORKLOAD=N`, `A64_MIDWAY_SNAPSHOT=1`) | `A64_STAGE=initramfs A64_CORES=N node tests/a64/linux_boot.mjs` | v86 |
| `setup-disk -m sys` onto a virtio-blk disk, the installed system booted from it, fsck (packages from `node tools/alpine_repo.mjs --arch aarch64 --set sys`) | `A64_JIT=1 [A64_TRANSPORT=pci] node tests/a64/linux_install.mjs` | v86 |
| The live stage with the devices on the PCIe host, the PCI functions against the reference's | `A64_STAGE=live A64_TRANSPORT=pci node tests/a64/linux_boot.mjs` | both |
| Snapshots at the probe's three markers (V7 stream, V6 buffer), interpreter and page tier, 1/2/4 cores, mmio and pci; s2idle and hibernation (`A64_LINUX_SLEEP=N`: N rounds each, a tmpfs file's MD5 and the online CPUs checked after each) | `make a64-lifecycle-guest-tests` | v86 |
| Extended RAM: the bus, eviction, DMA, code there, snapshots (`tests/a64/extended_memory.mjs`); 3 and 4 GiB of RAM, the probe's memtest (`A64_MEMORY_MB`, `A64_EXTENDED_MEMORY`, `A64_LINUX_MEMTEST=<MiB>`) | `make a64-extended-guest-tests` | v86 |
| Alpine from its ISO in headless Chrome: the source tree, the bundle, the CPU worker, virtio-pci (`BROWSER_CHROME`, `A64_BROWSER_QUERIES`) | `make a64-browser-tests` | Chrome |
| Linux built for 16 and 64 KiB pages (`tools/a64_kernel.mjs`, in an Alpine aarch64 VM under QEMU with HVF; `A64_KERNEL=16k\|64k`): the live stage to a login, the probe's page size, the guest JITs | `make a64-kernels`, `make a64-pagesize-guest-tests` | v86 |
| The profile's completeness (P9.4): every encoding class with a status and tests, the ID registers as the profile's on 1 and 4 cores, HWCAP on every kernel, the page sizes; `--reference` the QEMU reference's registers, `--kvm` kvm-unit-tests at 4k/16k/64k (`build/a64-linux/profile-report.json`) | `node tools/a64_profile_report.mjs --reference --kvm` | both |
| The frozen Alpine baseline (P9.4, `tests/a64/perf-baseline.json`): the initramfs and live stages, interpreted and with the page tier, 1/2/4 cores, medians of 3 | `TEST_RELEASE_BUILD=1 node tools/a64_jit_metrics.mjs --stages initramfs,live --baseline tests/a64/perf-baseline.json` | v86 |
| The androidish kernel and its images (`tools/a64_kernel.mjs --variants androidish`; `--programs-only` rebuilds the programs and images alone; `A64_KERNEL=androidish`, the initramfs stage): f2fs and fscrypt across a reboot, bootconfig, SELinux enforcing, binder, userfaultfd, erofs on dm-verity, zram and PSI (`tests/a64/*.c`, `tests/a64/minimal.cil`) | `make a64-android-prep-tests` | v86 |
| Cores in workers: Alpine's stages (`A64_PARALLEL=1`), litmus in four modes (`LITMUS_MODES=cooperative,cooperative-jit,parallel,parallel-jit`) | `make a64-parallel-tests`, `make a64-parallel-guest-tests` | v86 |
| virtio-gpu: drm, gl, resize, input; gltest, virgl, kms (`GPU_LEVEL=virgl43-hostmem GPU_RENDERER=chrome`); venus, vkcube (`GPU_LEVEL=venus`); packages from `node tools/alpine_repo.mjs --arch aarch64` | `GPU_SCENARIO=drm node tests/a64/linux_gpu.mjs` (`make a64-gpu-guest-tests`) | v86 |
| The guest JIT workloads after the probe (node, `java Hello.java`, luajit `-jon`/`-joff`, `pcre2test -jit`; packages from `node tools/alpine_repo.mjs --arch aarch64 --set jit`, 1.5 GiB of RAM) | `A64_WORKLOAD=jit A64_STAGE=initramfs node tests/a64/linux_boot.mjs` (with `A64_LINUX_QEMU=1` first for the reference) | both |
| Bare-metal guests (`tests/a64/guest_runner.mjs`, runtime in `tests/a64/baremetal/`) | `node tests/a64/float_ref.mjs`, `node tests/a64/platform_probe.mjs` | `A64_TARGET=qemu` (v86: A1) |
| Decode oracle (llvm-mc with the profile's `-mattr`) | `node tests/a64/oracle/decode.mjs --self-test` | — |
| kvm-unit-tests arm64, 4k/16k/64k | `make a64-kvm-unit-tests-qemu` | QEMU (v86: A2) |
| ID registers | `node tools/cpu_contract.mjs --a64-reference` | QEMU (v86: P3.1) |
| Host capabilities | `tests/a64/browser_caps.html`, `node tests/a64/browser_caps.mjs` | browsers, Node |
| ISA corpus (Alpine's ELFs against v1) | `node tools/a64_isa_scan.mjs` | — |
| Android 16's materials (P10.1, P10.5: the pinned Cuttlefish build, `--download` fetches it) | `node tools/a64_android.mjs` (`make android-materials`) | — |
| Android 16 to `sys.boot_completed=1` (P10.3; `A64_ANDROID_ACCEL=hvf`: the host's CPU; `A64_QEMU_PLUGINS=1`: instruction counts; `A64_MEMORY_MB`) | `node tests/a64/android_boot.mjs` (`make android-reference-tests`) | QEMU |
| The GKI bridge (P10.6): the GKI kernel, Alpine's initramfs, the 19 virtual-device modules, the probe | `A64_KERNEL=gki [A64_LINUX_QEMU=1] A64_STAGE=initramfs node tests/a64/linux_boot.mjs` | both |
| Android 16 to system_server and adbd over vsock (P10.7; `A64_ANDROID_WAIT=boot_completed`) | `A64_ANDROID_TARGET=v86 A64_JIT=1 A64_PARALLEL=1 node tests/a64/android_boot.mjs` (`make android-guest-tests`) | v86 |
| A9's scenario (P11): the desktop, frame times (Launcher3's all-apps list, cold and warm), Wi-Fi, HTTP (v86), touch (v86), an APK, a reboot; on v86 with Venus (`A64_ANDROID_GPU=venus`) | `A64_ANDROID_SCENARIO=a9 node tests/a64/android_boot.mjs` (with the v86 variables above for v86); in `make android-reference-tests` and `make android-guest-tests` | both |
| A10's scenario (P12.2, P12.3, P12.5): the desktop saved by a first run (`A64_ANDROID_A10_SAVE=<file>`) and restored by a second (`A64_ANDROID_RESTORE_STATE`): a tap, input latency (five taps timed from the touch to the screen's change; QEMU taps through QMP), sustained frame rate (`tests/a64/android/v86frames.c`: a minute of OpenGL ES frames), sound (the card's PCM on the host: tinyplay's WAV byte for byte, with a 320 ms buffer, `tests/a64/android/v86tone.c`'s AAudio tone through AudioFlinger and the HAL by frequency; QEMU's virtio-sound-pci writes a WAV), 30 minutes of monkey (`A64_ANDROID_A10_MONKEY_MINUTES`), memory pressure until lmkd kills, the core services' pids kept | `A64_ANDROID_SCENARIO=a10 node tests/a64/android_boot.mjs` | both |
| Condition variables across snapshots: `tests/a64/android/futex_stress.c` (bionic's mutexes and condition variables as ANGLE's worker pool uses them, and ping-pong pairs; the NDK, static) in Alpine's initramfs on 4 cores in workers with the page tier, saved and restored in place every 3 s (`A64_FUTEX_SNAPSHOT=fresh`: into a new machine; `A64_KERNEL_FILE`: e.g. Android's GKI kernel); any group without progress for 10 s fails it | `node tests/a64/futex_snapshot.mjs` | v86 |
| Android saved and restored in place at Launcher3's first frames, debugging (`A64_STALL_SNAPSHOTS`, `A64_STALL_DELAY_MS`): what changed during the save, Venus's rings at the capture, rings whose ids would have collided as numbers, and when Launcher3 stops drawing every thread's futex with the memory around it | `node tests/a64/android_restore_stall.mjs` | v86 |
| Android with 16 KiB pages (P12.1): the materials with a 16K kernel build's GKI kernel and modules (`--page-size 16k`, `build/a64-android/out-16k/`), the guest's page size checked; native APKs whose library is aligned to 4 or 16 KiB, stored in the APK or extracted, installed and started (`A64_ANDROID_SCENARIO=pagesize`, on either page size) | `node tools/a64_android.mjs --page-size 16k`, `A64_ANDROID_PAGE_SIZE=16k A64_ANDROID_SCENARIO=pagesize node tests/a64/android_boot.mjs`; in `make android-reference-tests` and `make android-guest-tests` | both |
| A CTS subset (P12.3): CTS 16.1_r1's native modules KernelConfig, NativeEncryption, AslrMalloc, FsMgr and Bionic (`tools/a64_cts.mjs` fetches their files by byte ranges of the 23.8 GB zip), pushed and run as Tradefed's GTest runner would (`A64_ANDROID_CTS_MODULES`, `A64_ANDROID_CTS_FILTER` for parts) | `A64_ANDROID_SCENARIO=cts node tests/a64/android_boot.mjs`; in `make android-reference-tests` and `make android-guest-tests` | both |
| The speaker under the autoplay policy: headless Chrome that wants a user gesture, v86 started without one, a trusted click through the DevTools protocol resumes the AudioContext | `node tests/glbridge/speaker_unlock_browser_test.mjs` (`make cpu-worker-tests`) | browsers |
| Shell commands over adb after boot_completed (`A64_ANDROID_PROBE=<file>`, one per line, `@screenshot <name>` for a picture; `A64_ANDROID_PUSH=<local>=<remote>,...` first); Venus with the renderer in a headless Chrome (`A64_ANDROID_GPU=venus`, v86, `initrd-venus.img`); a state saved after boot_completed and restored instead of booting (`A64_ANDROID_SAVE_STATE`, `A64_ANDROID_RESTORE_STATE`, v86; without a scenario add `A64_ANDROID_WAIT=boot_completed`) | `node tests/a64/android_boot.mjs` | both |
| The guest's Venus driver (P11.4): Mesa 26.1.6 built with the NDK (r26b), `vkprobe` and `vkahb` (`tests/a64/android/`) | `make android-venus` | — |
| Android's ISA (P10.4): the booted guest's partitions and APEXes (`build/a64-android/rootfs.tar`, on QEMU with HVF) against v1 | `node tools/a64_android.mjs --extract`, `node tools/a64_isa_scan.mjs --android build/a64-android/rootfs.tar` | QEMU |

`make a64-gate` runs before each commit and `make a64-gate-full` at a
milestone's exit (`tools/a64_gate.mjs`). The release levels `R-a64-*` are in
`tools/release_gate.mjs`. Their targets without tests yet print `A64_PENDING`.

## Cores in workers

With `parallel: true` (or `"auto"`, which falls back to cooperative cores
where the host cannot), cores 1 and up run in vCPU workers
([`src/parallel/vcpu_arm.js`](../src/parallel/vcpu_arm.js)), each with its own
relocated instance of `build/v86-arm64-parallel.wasm` in one shared memory, as
the x86 core's (see [multicore.md](multicore.md)). Core 0 and the devices stay
on the machine's thread, which serves the workers' device register accesses
(`OP_A64_MMIO_READ`, `OP_A64_MMIO_WRITE`: 64-bit offsets and values) and
stops them at safe points for snapshots, resets and pauses.

- Machine state: guest memory and the address space (a worker copies the
  map, again when its generation changes), the GIC (one lock), PSCI's power
  states, the events, the global monitor and extended RAM. A core in a worker
  is off until another core's PSCI CPU_ON, which kicks its worker.
- TLB maintenance: an inner shareable TLBI (and IC IVAU, IC IALLUIS) acts at
  once on the issuing core and goes to the others through a ring in machine
  memory; the issuing core's next DSB completes only when every other core
  has taken the ring (it is kicked) or waits idle. After 32 page entries in
  one batch, one full flush stands for the rest.
- Code: the cores track which pages others compiled from
  (`crate::parallel::code`): a store to such a page retires their code, and
  an installation waits until the others have marked the page.
- Memory model: guest accesses are sequentially consistent Wasm atomics in
  the parallel build (interpreter and page tier), DMB and ISB a fence, DSB a
  single step while cores run in workers. An unaligned access is no
  single-copy atomic one in the architecture, and a plain one here: compiled
  code copies an unaligned read to an aligned buffer and stores unaligned
  (STR, STP and the SIMD&FP ones) without atomics; LDAR, STLR and the
  exclusives fault in the interpreter as the architecture says.

Deviations, all allowed by the architecture or by the plan:

- A store-exclusive also compares the value its load-exclusive read, as
  QEMU's does: a store compiled in another worker does not clear the
  reservation, so a value written back meanwhile does not make it fail (the
  probe's and the litmus test's ABA lines are only reported in this mode).
- WFE ends after at most 20 µs without an event, for the same reason (a
  waiter on a lock released by a compiled store would otherwise wait for the
  event stream).

Speed (release build, Apple M-series Mac, page tier, 4 cores): Alpine's
initramfs stage through the probe 9.3 s (cooperative 6.4 s: the boot is
mostly core 0's); four copies of the busybox workload at once 14.5 s
(cooperative 23.0 s). The parallel build alone costs about 15% on one core.

## The page tier

The A64 page tier (`src/rust/aarch64/jit/`, switch `a64_page`, default off)
compiles a 4 KiB page of A64 code into one Wasm function, as the x86 page
tier does, on the same runtime (`src/rust/jitrt`) and skeleton
(`src/rust/pagegen/frame.rs`). Integer code, branches and loads and stores
are native templates; scalar FP and the common AdvSIMD forms are native on
a fast path (round to nearest, no flush to zero, FPSR.IXC already set,
ordinary operands and results), everything else calls the interpreter's
execute for that one instruction (a helper) or single-steps. Code is keyed
by its physical page and the mode (EL, SP alignment checks); the access
cache is per core and EL, filled from the TLB and flushed with it. A
tagged pointer (TBI: Android's heap pointers carry 0xB4 in their top byte)
has entries of its own, in the untagged page's slot, which a TLBI by VA
clears with the untagged one; an unaligned access the code cannot take
fills its entry and retries once; with SCTLR_EL1.A nothing is filled (the
interpreter raises the alignment faults). A page
of extended RAM is cached as its frame, which then stays resident until
the run loop's next safe point retires the access caches (when half the
frames are held, or none is free), as on x86; with the cores in workers
extended RAM goes through the interpreter's path.

| Switch | Default | |
| --- | --- | --- |
| `a64_page` | 0 | compiled code runs |
| `a64_page_hot` | 2000 | interpreted instructions on a page before it is compiled |
| `a64_neon` | 1 | the FP and AdvSIMD templates |
| `a64_helpers` | 1 | helper calls (0: single steps) |
| `a64_system` | 31 | the system templates (a mask): EL1's MRS and MSR of SP_EL0, TPIDR_EL1, DAIF, ELR_EL1, SPSR_EL1, ESR_EL1, FAR_EL1 and CONTEXTIDR_EL1, MSR of TPIDRRO_EL0; at EL1 and EL0, MRS of CNTVCT_EL0 and CNTPCT_EL0 (the counter: Android's clock_gettime reads it in the vDSO), CNTFRQ_EL0, DCZID_EL0 and TPIDRRO_EL0, MRS and MSR of FPCR and FPSR (EL0's checks, CNTKCTL_EL1, SCTLR_EL1.DZE and CPACR_EL1.FPEN, made as they run); MSR DAIFSet and DAIFClr (an unmask that makes an interrupt deliverable leaves for the run loop), TLBI (in Rust, leaving when the access cache's epoch changed), DC ZVA at EL1 and EL0 (through the access cache's write entry; at EL0 while SCTLR_EL1.DZE is set: bionic's memset zeroes with it), LDTR and STTR (through the access cache's EL0 tables), and with the cores in workers a DSB that steps only while this core's TLB maintenance is pending (0: helpers and steps, as before) |
| `a64_relaxed_fma` | the host's probe | FMADD and FMLA through relaxed SIMD's fused multiply-add |
| `a64_asid_tag` | 2 | an access-cache epoch per ASID, so ASID switches keep entries: 1 always, 2 (auto) while the ASIDs change at least 256 times in about 4 million instructions (SW_TTBR0_PAN changes them at every entry from EL0 and around every uaccess), 0 never |
| `a64_page_aarch32` | 1 | AArch32's code (profile v3's 32-bit processes, A32 and T32) compiled too (docs/aarch32-plan.md Q6): R0-R14 and NZCV stay in memory; branches, returns (LDM, POP and LDR of the PC to the same instruction set), data processing with every shift, MOVW and MOVT, loads and stores (LDRD, STRD, LDM, STM, PUSH, POP), multiplies, extends, CLZ and REV are native, IT blocks of such forms too; so are VFP's loads, stores, arithmetic and moves and Advanced SIMD's VLD1/VST1 (multiple) and data processing (bitwise, VADD, VSUB, compares, VMAX, VMIN, integer VMUL, shifts by an immediate, modified immediates, VDUP, VEXT, VREV, VMVN, VCNT, VABS, VNEG; D registers as their 64 bits); the rest are helper calls (the interpreter's execute: the other VFP and Advanced SIMD forms, the exclusives, the saturating and parallel forms) or steps. 0 interprets it; 2 and 3 (helper calls only, native forms only) and 16 plus a mask of native kinds bisect |
| `a64_page_aarch32_filter` | 0 | (bisecting) `n << 16 \| pattern`: only the AArch32 pages whose code key's low n bits are the pattern's compile, each named on the console; bit 15: AArch32's functions do not chain |
| `a64_page_aarch32_trace` | 0 | (debugging) 1: the last 384 events of AArch32's EL0 code (interpreted instructions, helper calls, steps, function entries and exits, exceptions and their returns, each with ITSTATE) printed on the console with the page function's blocks around the PC when an IT instruction is UNDEFINED inside an IT block or an instruction fetch at EL0 takes a permission fault |
| `a64_reserved_fill` | 0 | 1: with the cores in workers too, no write entries are filled in pages some core holds a reservation in (as with cooperative cores, where it is needed); 0: they are, since a store-exclusive compares the value anyway and the entries filled before stay: refusing sent every store to an ART lock word's page through the interpreter |
| `a64_step_stats` | 1 | `step_stats()`'s counters, sampled (one step or helper call in 64 counted 64 times: every core writes them; 0: none are kept) |
| `a64_page_code_mb` | 160 | the compiled code each core keeps (the Wasm functions' bytes, at least 8 MiB); past it the least recently used pages are evicted. V8 commits about 1.3 times that as native code, and a process has 4 GiB of committed code space: Android's first boot on 4 cores in workers exhausted it without the budget |

`page_tier_stats()` on the ARM CPU (and `jit_stat(1, field)`) gives the
counters, among them `live_code_bytes`; `step_stats(top)` the instruction
classes most often stepped, those that ended an activation (they changed
what compiled code depends on) and those run as helpers, with MRS/MSR by
register and SYS by operation (every core's; Android's runs record them in
their `result.json`). Tests: `make a64-page-tier-tests` (random programs against the
interpreter, the FP loop, the ISA and system oracles compiled, litmus) and
`make a64-jit-guest-tests` (Alpine and kvm-unit-tests with the page tier).

Alpine through the probe (`tools/a64_jit_metrics.mjs --stages initramfs,live`, the frozen baseline of
P9.4: release build, medians of 3 sessions; "native" is the share of retired
instructions the page tier ran, "chained" the share of activations that
tail-called another page's function; the table has 12000 slots):

| Configuration | boot_to_login_ms | probe_done_ms | run ms | MIPS | compiles | compile ms | evictions | fewest free slots | native | steps per instruction | chained |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| initramfs stage, interpreter, 1 core | – | 35571 | 38688 | 26.2 | – | – | – | – | – | – | – |
| initramfs stage, page tier, 1 core | – | 6314 | 7256 | 122.8 | 1797 | 451 | 0 | 11106 | 97.2% | 3.1e-03 | 44.4% |
| initramfs stage, interpreter, 2 cores | – | 41827 | 45451 | 25.4 | – | – | – | – | – | – | – |
| initramfs stage, page tier, 2 cores | – | 6860 | 7972 | 116.2 | 1949 | 511 | 0 | 11071 | 97.4% | 2.9e-03 | 61.7% |
| initramfs stage, interpreter, 4 cores | – | 57407 | 61667 | 24.2 | – | – | – | – | – | – | – |
| initramfs stage, page tier, 4 cores | – | 7038 | 8068 | 120.3 | 2010 | 496 | 0 | 11058 | 97.3% | 3.0e-03 | 61.3% |
| live stage, interpreter, 1 core | 238327 | 246544 | 253012 | 22.9 | – | – | – | – | – | – | – |
| live stage, page tier, 1 core | 34687 | 35654 | 38690 | 122.2 | 4126 | 1151 | 0 | 10603 | 96.7% | 4.5e-03 | 66.0% |
| live stage, interpreter, 2 cores | 280983 | 291832 | 299342 | 22.8 | – | – | – | – | – | – | – |
| live stage, page tier, 2 cores | 39549 | 40618 | 43769 | 112.2 | 4272 | 1255 | 0 | 10509 | 96.7% | 4.5e-03 | 70.0% |
| live stage, interpreter, 4 cores | 362226 | 375837 | 385054 | 22.7 | – | – | – | – | – | – | – |
| live stage, page tier, 4 cores | 40629 | 41955 | 45160 | 114.3 | 4341 | 1224 | 0 | 10469 | 96.6% | 4.6e-03 | 69.5% |

### Measurements

The definitions (`tests/a64/linux_boot.mjs`, `build/a64-linux/result-<tag>.json`):

- `boot_to_login_ms`: from the start until `localhost login:` appears on the serial console (live stage).
- `probe_done_ms`: until the probe's `A64_PROBE_XC` line.
- Retired instructions and MIPS. On QEMU these come from the insn plugin with
  `-icount shift=0` (`A64_QEMU_PLUGINS=1`), and the instruction classes come
  from howvec. On v86, `retired_instructions` sums every core's
  (`core_statistics_get`), and the page tier's counters come from
  `page_tier_stats()`; `tools/a64_jit_metrics.mjs` takes the medians of 3
  sessions.

| QEMU 9.2.0, cortex-a35, 1 core | instructions | wall time without plugins |
| --- | --- | --- |
| initramfs stage through the probe | 1.01 × 10⁹ | 1.7 s |
| live stage to login and through the probe | 6.36 × 10⁹ | 11.7 s to login, 12.0 s probe done |
