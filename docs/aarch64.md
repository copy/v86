# AArch64

> Status: A3, A4 and A5 of [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md)
> (virtio-mmio devices; the page tier, J2 of
> [jit-unification-plan.md](jit-unification-plan.md); the PCIe host,
> virtio-pci, input and virtio-gpu), A6 (the lifecycle, cores in vCPU
> workers, extended RAM, 16 and 64 KiB page kernels, the browser), and of A7
> the rehearsals for Android (P9.1, P9.2). Sections marked *(pending)* are filled in
> as the milestones land.

With `cpu_type: "arm64"` (from A1), v86 runs a separate core,
`build/v86-arm64.wasm`: an Armv8.0-A CPU at EL0 and EL1 only, on the `virt`
board ([virt.md](virt.md)). The x86 core, `build/v86.wasm`, is unchanged and
does not contain the ARM code (the plan's "Wasm core" section).

| | |
| --- | --- |
| Option | `cpu_type: "arm64"` (machine_type "virt", its default) |
| Profile | `v86-aarch64-v1.1`, [tests/platform/a64-profile.json](../tests/platform/a64-profile.json) (`a64_profile: "v1"`: the 4 KiB granule only) |
| Verified guests | Alpine 3.24 aarch64 (Linux 6.18, the official ISO's kernel and initramfs) on 1/2/4 cooperative cores, interpreted and with the page tier: from the ISO on virtio-blk to a login, the probe (threads, signals, cross-modified and dual-mapped code, FP across context switches, exclusives, O_DIRECT), virtio-net, -rng, hvc0 and -input, kpti=1, single-user mode, snapshots, reboot and poweroff, `setup-disk -m sys` onto a disk and the installed system, all on virtio-mmio and on virtio-pci (the PCI functions as the reference's); s2idle woken by the PL031's alarm and hibernation to a swap disk with the resume after power-on; 3 and 4 GiB of RAM with extended RAM from 4 GiB (a memtest over most of it); in headless Chrome from the source tree, the bundle and the CPU worker; on 2 and 4 cores in vCPU workers (`parallel: true`: the probe, the live stage with snapshots, reboot, poweroff, s2idle, hibernation); Linux 6.18.35 built for 16 and 64 KiB pages (`tools/a64_kernel.mjs`) to a login and through the probe, interpreted and with the page tier, and the guest JITs on them; the androidish kernel (Linux 6.18.35 in GKI's shape: a 39-bit VA, SW_TTBR0_PAN, pseudo-NMIs, KASLR) on 2 and 4 cores, interpreted, with the page tier and in workers, and with 4 GiB of RAM: binderfs's selftest and binder between two cores, userfaultfd, a minimal SELinux policy enforcing (the probe after it), bootconfig, erofs on dm-verity, f2fs with fscrypt across a reboot, zram as swap and PSI's trigger; virtio-console's ports 1-3 (`org.v86.port<N>`, echoed by the host) in every live stage; virtio-gpu: KMS (atomic, planes, cursor, PRIME, explicit sync), kmscube and weston with llvmpipe, virgl (GL 4.3, gltest 0 failures), Venus (vktest, vkcube) on a real GPU through WebGPU, input on weston; kvm-unit-tests arm64 at 4, 16 and 64 KiB; guest JITs (V8 in nodejs, HotSpot, LuaJIT, PCRE2) with their output equal to QEMU's |
| Boot time | Alpine from the ISO to `localhost login:`: 30 / 39 / 34 s on 1/2/4 cores with the page tier, 232 / 267 / 341 s interpreted (QEMU TCG: 11 s on 1 core), the same with the devices on virtio-pci; to login and through the probe on 1 core with the page tier 33.1 s, 1.37 times the x86_64 page tier's 24.1 s on the same host (the E level's budget: 3 times); the initramfs stage through the probe: 5.7 / 6.1 / 6.8 s with the page tier, 34.6 / 40.1 / 49.9 s interpreted (release build, Apple M-series Mac) |
| Not done | virtio-snd (P7.5, optional; deferred to Android's audio) |

## CPU profile

`v86-aarch64-v1.1` is Armv8.0-A as Alpine 3.24 needs it, plus the AES, PMULL,
SHA1, SHA2 and CRC32 extensions. Every ID register, its fields and the reason
for each value are in the profile JSON, checked against the Arm Architecture
Reference Manual, DDI 0487 issue L.b.

| Advertised | Not advertised |
| --- | --- |
| AArch64 at EL0 and EL1; FP and Advanced SIMD (no FP16); AES with 64-bit PMULL, SHA1, SHA-256, CRC32; GICv3 system registers; 2 breakpoints, 2 watchpoints; CSV2 and CSV3; 40-bit physical addresses, 16-bit ASIDs, the 4, 16 and 64 KiB granules (v1 has 4 KiB only) | EL2, EL3, AArch32; LSE, RDM, SHA512, SHA3, SM3/SM4, DotProd, FP16; PAuth, BTI, MTE, SVE, SME; PMU; hardware AF/DBM, PAN, VHE |

HWCAP is `0x8ff`: `fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid`.

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
  the parallel build (interpreter and page tier; an unaligned access retries
  in the interpreter), DMB and ISB a fence, DSB a single step while cores run
  in workers.

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
cache is per core and EL, filled from the TLB and flushed with it. A page
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
| `a64_relaxed_fma` | the host's probe | FMADD and FMLA through relaxed SIMD's fused multiply-add |
| `a64_asid_tag` | 2 | an access-cache epoch per ASID, so ASID switches keep entries: 1 always, 2 (auto) while the ASIDs change at least 256 times in about 4 million instructions (SW_TTBR0_PAN changes them at every entry from EL0 and around every uaccess), 0 never |

`page_tier_stats()` on the ARM CPU (and `jit_stat(1, field)`) gives the
counters. Tests: `make a64-page-tier-tests` (random programs against the
interpreter, the FP loop, the ISA and system oracles compiled, litmus) and
`make a64-jit-guest-tests` (Alpine and kvm-unit-tests with the page tier).

Alpine's initramfs stage through the probe (`tools/a64_jit_metrics.mjs`,
release build, medians of 3 sessions; "native" is the share of retired
instructions the page tier ran, "chained" the share of activations that
tail-called another page's function; the table has 12000 slots):

| Configuration | probe_done_ms | run ms | MIPS | compiles | compile ms | evictions | fewest free slots | native | steps per instruction | chained |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| interpreter, 1 core | 34560 | 37519 | 26.8 | – | – | – | – | – | – | – |
| page tier, 1 core | 5711 | 6566 | 134.9 | 1770 | 414 | 0 | 11117 | 97.3% | 3.1e-3 | 44.2% |
| interpreter, 2 cores | 40126 | 43677 | 26.2 | – | – | – | – | – | – | – |
| page tier, 2 cores | 6137 | 7088 | 128.7 | 1924 | 473 | 0 | 11081 | 97.4% | 2.9e-3 | 61.8% |
| interpreter, 4 cores | 49930 | 53912 | 25.5 | – | – | – | – | – | – | – |
| page tier, 4 cores | 6826 | 7800 | 123.4 | 1989 | 481 | 0 | 11069 | 97.3% | 3.0e-3 | 62.3% |

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
