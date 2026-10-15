# AArch64

> Status: A4 of [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md)
> (the page tier, J2 of [jit-unification-plan.md](jit-unification-plan.md)),
> without the plan's P5: no virtio devices on the virt board yet, so Alpine
> runs its initramfs, single-user and lifecycle stages, not the live stage
> to a login. Sections marked *(pending)* are filled in as the milestones land.

With `cpu_type: "arm64"` (from A1), v86 runs a separate core,
`build/v86-arm64.wasm`: an Armv8.0-A CPU at EL0 and EL1 only, on the `virt`
board ([virt.md](virt.md)). The x86 core, `build/v86.wasm`, is unchanged and
does not contain the ARM code (the plan's "Wasm core" section).

| | |
| --- | --- |
| Option | `cpu_type: "arm64"` (machine_type "virt", its default) |
| Profile | `v86-aarch64-v1`, [tests/platform/a64-profile.json](../tests/platform/a64-profile.json) |
| Verified guests | Alpine 3.24 aarch64 (Linux 6.18, the official ISO's kernel and initramfs) on 1/2/4 cooperative cores, interpreted and with the page tier: the probe (threads, signals, cross-modified and dual-mapped code, FP across context switches, exclusives), kpti=1, single-user mode, snapshot, reboot and poweroff; kvm-unit-tests arm64 at 4, 16 and 64 KiB |
| Boot time | Alpine's initramfs stage through the probe: 5.7 / 6.1 / 6.8 s on 1/2/4 cores with the page tier, 34.6 / 40.1 / 49.9 s interpreted (release build, Apple M-series Mac; QEMU TCG: 1.7 s on 1 core) |
| Not done | virtio devices and the live stage (P5), cores in workers (P8), the JIT workloads in the guest (P6.7) |

## CPU profile

`v86-aarch64-v1` is Armv8.0-A as Alpine 3.24 needs it, plus the AES, PMULL,
SHA1, SHA2 and CRC32 extensions. Every ID register, its fields and the reason
for each value are in the profile JSON, checked against the Arm Architecture
Reference Manual, DDI 0487 issue L.b.

| Advertised | Not advertised |
| --- | --- |
| AArch64 at EL0 and EL1; FP and Advanced SIMD (no FP16); AES with 64-bit PMULL, SHA1, SHA-256, CRC32; GICv3 system registers; 2 breakpoints, 2 watchpoints; CSV2 and CSV3; 40-bit physical addresses, 16-bit ASIDs, the 4 KiB granule | EL2, EL3, AArch32; LSE, RDM, SHA512, SHA3, SM3/SM4, DotProd, FP16; PAuth, BTI, MTE, SVE, SME; PMU; hardware AF/DBM, PAN, VHE; the 16 and 64 KiB granules (v1.1) |

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
| Bare-metal guests (`tests/a64/guest_runner.mjs`, runtime in `tests/a64/baremetal/`) | `node tests/a64/float_ref.mjs`, `node tests/a64/platform_probe.mjs` | `A64_TARGET=qemu` (v86: A1) |
| Decode oracle (llvm-mc with the profile's `-mattr`) | `node tests/a64/oracle/decode.mjs --self-test` | — |
| kvm-unit-tests arm64, 4k/16k/64k | `make a64-kvm-unit-tests-qemu` | QEMU (v86: A2) |
| ID registers | `node tools/cpu_contract.mjs --a64-reference` | QEMU (v86: P3.1) |
| Host capabilities | `tests/a64/browser_caps.html`, `node tests/a64/browser_caps.mjs` | browsers, Node |
| ISA corpus (Alpine's ELFs against v1) | `node tools/a64_isa_scan.mjs` | — |

`make a64-gate` runs before each commit and `make a64-gate-full` at a
milestone's exit (`tools/a64_gate.mjs`). The release levels `R-a64-*` are in
`tools/release_gate.mjs`. Their targets without tests yet print `A64_PENDING`.

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
cache is per core and EL, filled from the TLB and flushed with it.

| Switch | Default | |
| --- | --- | --- |
| `a64_page` | 0 | compiled code runs |
| `a64_page_hot` | 2000 | interpreted instructions on a page before it is compiled |
| `a64_neon` | 1 | the FP and AdvSIMD templates |
| `a64_helpers` | 1 | helper calls (0: single steps) |
| `a64_relaxed_fma` | the host's probe | FMADD and FMLA through relaxed SIMD's fused multiply-add |
| `a64_asid_tag` | 0 | an access-cache epoch per ASID, so ASID switches keep entries |

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
